/**
 * Reversible tool-result projection planning.
 *
 * When one text block of a tool result exceeds the metered token threshold:
 *   1. Try structured, content-aware compression (JSON/code/diff/log/search/
 *      cli rules) — deterministic, no LLM.
 *   2. Fall back to a meter-priced head/tail slice that halves its budget
 *      until the meter reports it under the threshold.
 * The original content is NEVER dropped: the caller commits the original
 * event as a shadowed session-log event and stamps the projected text with a
 * retrieval marker embedding `{hash, originalSeq}`, so `context_retrieve`
 * returns it byte-exact. No side store exists — the session log is the only
 * original store.
 *
 * @module dsh-asc/projection/projection
 */

import { createHash } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { compressStructured } from './structured.ts'

/** Fallback slice shape: head gets 2/3 of the kept budget, tail 1/3. */
const HEAD_SHARE = 2 / 3
/** The halving loop stops below this kept-character budget. */
const MIN_KEEP_CHARS = 256
/** Maximum halving iterations before the last candidate is used as-is. */
const MAX_HALVING_STEPS = 12

/** Canonical retrieval key: first 24 hex chars of the SHA-256 over the content. */
export function contentHash(blocks: readonly ContentBlock[]): string {
  return createHash('sha256').update(JSON.stringify(blocks)).digest('hex').slice(0, 24)
}

/** The model-visible retrieval marker stamped onto projected text. */
export function buildMarker(params: {
  hash: string
  originalSeq: number
  kind: string
  tokensBefore: number
  tokensAfter: number
}): string {
  return (
    `[dsh-asc projection: ${params.kind} compressed `
    + `${params.tokensBefore}→${params.tokensAfter} tokens. Full original `
    + `(seq ${params.originalSeq}, stored in this session log): `
    + `context_retrieve(hash="${params.hash}").]`
  )
}

export interface ProjectionPlan {
  /** Projected inner content blocks, in the original block order. */
  readonly blocks: ContentBlock[]
  /** Retrieval key over the ORIGINAL inner content. */
  readonly hash: string
  /** Log seq of the original tool/result event being replaced. */
  readonly originalSeq: number
  readonly strategy: 'structured' | 'head-tail'
  /**
   * Dominant reducer label: `structured:<type>` when any projected block won
   * through a structured reducer, else the content family of the head/tail
   * fallback; mixed multi-block results join the set (`+`). The exact
   * per-block label is embedded in each block's retrieval marker.
   */
  readonly kind: string
  readonly tokensBefore: number
  readonly tokensAfter: number
}

export interface ProjectionBudget {
  /** Metered token ceiling; blocks above it are projected. */
  readonly thresholdTokens: number
  /** Meter pricing callback over inner content blocks. */
  readonly estimate: (blocks: readonly ContentBlock[]) => number
  /** Name of the tool that produced the result; sharpens content detection. */
  readonly toolName?: string
  /** Whether the tool result reports an error; selects failure windows. */
  readonly failed?: boolean
}

/**
 * Project the oversized text blocks of one tool result's inner content.
 * Non-text blocks pass through unchanged; each text block is reduced on its
 * own (so one huge block never forces tiny blocks to shrink).
 * @returns a plan, or `null` when nothing needs or allows projection.
 */
export function planProjection(
  blocks: readonly ContentBlock[],
  originalSeq: number,
  budget: ProjectionBudget,
): ProjectionPlan | null {
  const oversized: number[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block: ContentBlock | undefined = blocks[i]
    if (block === undefined || block.type !== 'text') continue
    if (budget.estimate([block]) > budget.thresholdTokens) oversized.push(i)
  }
  if (oversized.length === 0) return null

  const hash = contentHash(blocks)
  const tokensBefore = budget.estimate(blocks)
  const projected: ContentBlock[] = [...blocks]
  const strategies = new Set<'structured' | 'head-tail'>()
  const kinds = new Set<string>()
  let tokensAfter = 0
  const unprojected = new Set<number>()
  for (const index of oversized) {
    const block: ContentBlock | undefined = blocks[index]
    if (block === undefined || block.type !== 'text') continue // unreachable: oversized indices are text blocks
    const single = projectBlock(block.text, hash, originalSeq, budget)
    if (single === null) {
      // Nothing reduced it — the block stays at full length (never dangles).
      unprojected.add(index)
      tokensAfter += budget.estimate([block])
      continue
    }
    projected[index] = { type: 'text', text: single.text }
    tokensAfter += budget.estimate([{ type: 'text', text: single.text }])
    strategies.add(single.strategy)
    kinds.add(single.kind)
  }
  if (strategies.size === 0) return null

  // Blocks left untouched keep their original price.
  for (let i = 0; i < blocks.length; i++) {
    const block: ContentBlock | undefined = blocks[i]
    if (block === undefined || oversized.includes(i) || unprojected.has(i)) continue
    tokensAfter += budget.estimate([block])
  }

  const kind = `${[...strategies].join('+')}:${[...kinds].join('+')}`
  return {
    blocks: projected,
    hash,
    originalSeq,
    strategy: strategies.has('structured') ? 'structured' : 'head-tail',
    kind,
    tokensBefore,
    tokensAfter,
  }
}

interface BlockProjection {
  text: string
  strategy: 'structured' | 'head-tail'
  kind: string
}

/**
 * Project one oversized text block; `null` keeps it at full length.
 * `hash` is the retrieval key over the whole original inner content, shared
 * by every marker of the result.
 */
function projectBlock(
  text: string,
  hash: string,
  originalSeq: number,
  budget: ProjectionBudget,
): BlockProjection | null {
  const original: readonly ContentBlock[] = [{ type: 'text', text }]
  const tokensBefore = budget.estimate(original)
  const structured = compressStructured(text, budget.toolName, budget.failed === true)
  if (structured.text !== null) {
    const candidate: readonly ContentBlock[] = [{ type: 'text', text: structured.text }]
    const tokensAfter = budget.estimate(candidate)
    if (tokensAfter <= budget.thresholdTokens) {
      return {
        text: `${structured.text}\n\n${buildMarker({
          hash,
          originalSeq,
          kind: `structured:${structured.contentType}`,
          tokensBefore,
          tokensAfter,
        })}`,
        strategy: 'structured',
        kind: structured.contentType,
      }
    }
  }

  // Meter-priced head/tail fallback: halve the kept-character budget until
  // the meter reports the slice under the threshold — the estimator decides,
  // never a chars-per-token constant.
  let keep = Math.max(MIN_KEEP_CHARS, Math.floor(text.length / 2))
  let candidateText: string | null = null
  for (let step = 0; step <= MAX_HALVING_STEPS; step++) {
    const headLen = Math.floor(keep * HEAD_SHARE)
    const tailLen = Math.max(0, keep - headLen)
    const head = text.slice(0, headLen)
    const tail = text.slice(Math.max(headLen, text.length - tailLen))
    const attempt = `${head}\n\n${buildMarker({
      hash,
      originalSeq,
      kind: structured.contentType,
      tokensBefore,
      // The marker carries the metered price of the projected result; the
      // measured number includes the marker itself, so rebuild once.
      tokensAfter: tokensBefore,
    })}\n\n${tail}`
    const tokensAfter = budget.estimate([{ type: 'text', text: attempt }])
    if (tokensAfter <= budget.thresholdTokens) {
      candidateText = `${head}\n\n${buildMarker({
        hash,
        originalSeq,
        kind: structured.contentType,
        tokensBefore,
        tokensAfter,
      })}\n\n${tail}`
      break
    }
    if (keep <= MIN_KEEP_CHARS) break
    keep = Math.max(MIN_KEEP_CHARS, Math.floor(keep / 2))
  }
  if (candidateText === null) return null
  if (structured.contentType === 'text' && candidateText.length >= text.length) return null
  return {
    text: candidateText,
    strategy: 'head-tail',
    kind: structured.contentType,
  }
}
