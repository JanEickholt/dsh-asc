/**
 * Quality gate for model-written compression summaries.
 *
 * A two-layer heuristic gate that catches catastrophic content loss without
 * ever blocking good summaries: L1 is a length/retention floor, L2 is a
 * content-coverage check (ROUGE-1 F1 AND top-keyword recall, AND-combined to
 * keep false positives low). The implementation here is original; the
 * two-layer design follows the idea of non-blocking quality evaluation from
 * model-driven context pruning systems.
 *
 * @module dsh-asc/quality-gate
 */

import type { QualityGateConfig, QualityReport } from '../types.ts'

/** One word-level token. */
type Token = string

/** Characters that separate word tokens; CJK characters are kept as units. */
const WORD_BOUNDARY = /[^\p{L}\p{N}]+/u

/** CJK ideographs are tokenized as individual characters (unigrams). */
const CJK_RE = /[\u3400-\u9fff]/u

/**
 * Tokenize text into word-level units: runs of letters/digits, with CJK
 * characters split into unigram tokens so Chinese summaries are matched at
 * character granularity.
 * @param text - source text.
 * @returns lowercased word tokens.
 */
export function wordTokens(text: string): Token[] {
  const tokens: Token[] = []
  let latinRun = ''
  const flushLatinRun = (): void => {
    if (latinRun.length > 0) {
      tokens.push(latinRun)
      latinRun = ''
    }
  }
  for (const part of text.toLowerCase().split(WORD_BOUNDARY)) {
    if (part.length === 0) continue
    if (!CJK_RE.test(part)) {
      tokens.push(part)
      continue
    }
    // Mixed runs keep Latin/digit words together and split only the CJK
    // ideographs into unigrams, instead of exploding the whole run.
    for (const char of part) {
      if (CJK_RE.test(char)) {
        flushLatinRun()
        tokens.push(char)
      } else {
        latinRun += char
      }
    }
    flushLatinRun()
  }
  return tokens
}

/** ROUGE-1 F1 between two token bags. */
export function rouge1F1(original: readonly Token[], summary: readonly Token[]): number {
  if (original.length === 0 || summary.length === 0) return 0
  const originalCounts = new Map<Token, number>()
  for (const token of original) {
    originalCounts.set(token, (originalCounts.get(token) ?? 0) + 1)
  }
  const summaryCounts = new Map<Token, number>()
  for (const token of summary) {
    summaryCounts.set(token, (summaryCounts.get(token) ?? 0) + 1)
  }
  let overlap = 0
  for (const [token, count] of summaryCounts) {
    overlap += Math.min(count, originalCounts.get(token) ?? 0)
  }
  const precision = overlap / summary.length
  const recall = overlap / original.length
  if (precision + recall === 0) return 0
  return (2 * precision * recall) / (precision + recall)
}

/**
 * Top-20 keyword recall: the fraction of the original's most frequent
 * keywords that appear in the summary.
 * @param original - original token bag.
 * @param summary - summary token bag.
 * @returns keyword recall in [0, 1].
 */
export function topKeywordRecall(original: readonly Token[], summary: readonly Token[]): number {
  if (original.length === 0) return 1
  const counts = new Map<Token, number>()
  for (const token of original) counts.set(token, (counts.get(token) ?? 0) + 1)
  const keywords = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 20)
    .map(([token]) => token)
  if (keywords.length === 0) return 1
  const summarySet = new Set(summary)
  const matched = keywords.filter(token => summarySet.has(token)).length
  return matched / keywords.length
}

/** Inputs for one quality evaluation. */
export interface QualityInput {
  /** Plain-text rendering of the shadowed content. */
  readonly originalText: string
  /** Estimated tokens of the shadowed content (token-meter price). */
  readonly shadowedTokens: number
  /** Plain text of the proposed summary. */
  readonly summaryText: string
  /** Estimated tokens of the framed checkpoint (token-meter price). */
  readonly summaryTokens: number
}

/**
 * Evaluate one summary against the two-layer gate.
 * @param input - original and summary text with token prices.
 * @param config - resolved gate configuration (all fields required).
 * @returns the gate report; a failed report never throws.
 */
export function evaluateQuality(
  input: QualityInput,
  config: Required<QualityGateConfig>,
): QualityReport {
  const summaryChars = Array.from(input.summaryText).length
  const originalTokens = Math.max(1, input.shadowedTokens)
  const retentionPct = (input.summaryTokens * 100) / originalTokens
  const originalTokensList = wordTokens(input.originalText)
  // Repetitive noise (a stuck command re-printing one error line) has almost
  // no unique tokens; forcing retention and ROUGE floors on it would block
  // exactly the content most worth compressing. A length-adequate summary is
  // enough when the unique ratio is below the configured noise threshold.
  const uniqueRatio = originalTokensList.length === 0
    ? 0
    : new Set(originalTokensList).size / originalTokensList.length
  const isNoise = uniqueRatio < config.noiseUniqueRatio
  const noteParts: string[] = []

  // L2 signals are measured on every evaluation so L1 rejections report the
  // real coverage values instead of fabricated zeros.
  const summaryTokensList = wordTokens(input.summaryText)
  const rouge = rouge1F1(originalTokensList, summaryTokensList)
  const recall = topKeywordRecall(originalTokensList, summaryTokensList)

  if (summaryChars < config.layer1MinChars) {
    noteParts.push(`summary ${summaryChars} chars below the ${config.layer1MinChars}-char floor`)
  }
  if (!isNoise && retentionPct < config.layer1MinRetentionPct) {
    noteParts.push(
      `summary retains ${retentionPct.toFixed(2)}% of shadowed tokens, below the `
      + `${config.layer1MinRetentionPct}% floor`,
    )
  }
  if (noteParts.length > 0) {
    return {
      gate: 'rouge-recall-v1',
      passed: false,
      blocking: config.blocking,
      layer: 1,
      note: noteParts.join('; '),
      metrics: {
        summaryChars,
        retentionPct,
        rouge1F1: rouge,
        top20Recall: recall,
        layer1MinChars: config.layer1MinChars,
        layer1MinRetentionPct: config.layer1MinRetentionPct,
        layer2MaxRougeF1: config.layer2MaxRougeF1,
        layer2MaxTop20Recall: config.layer2MaxTop20Recall,
      },
    }
  }

  if (!isNoise && rouge < config.layer2MaxRougeF1 && recall < config.layer2MaxTop20Recall) {
    return {
      gate: 'rouge-recall-v1',
      passed: false,
      blocking: config.blocking,
      layer: 2,
      note: `ROUGE-1 F1 ${rouge.toFixed(3)} and top-20 keyword recall ${recall.toFixed(2)} `
        + 'both below their floors',
      metrics: {
        summaryChars,
        retentionPct,
        rouge1F1: rouge,
        top20Recall: recall,
        layer1MinChars: config.layer1MinChars,
        layer1MinRetentionPct: config.layer1MinRetentionPct,
        layer2MaxRougeF1: config.layer2MaxRougeF1,
        layer2MaxTop20Recall: config.layer2MaxTop20Recall,
      },
    }
  }
  return { gate: 'rouge-recall-v1', passed: true, blocking: config.blocking, layer: 'pass' }
}
