/**
 * The compaction transaction bracket for model-written and fallback
 * summaries.
 *
 * The bracket follows the DeepSeek Harness compaction protocol exactly:
 * validate the span (balanced tool pairing, protection, tier caps), append
 * `compaction/start` as the durable lock, price the span through the token
 * meter, frame the summary into a checkpoint message, require the framed
 * checkpoint to be strictly smaller than the shadowed content, re-check
 * surface stability, then append `compaction/summary`, the replacement
 * `user/message` (surfaceOp replace), our `context/compress` record, and
 * `compaction/end` — synchronously adjacent. Every later failure makes
 * exactly one `compaction/end` attempt so the unmatched start stays
 * detectable.
 *
 * @module @dsh-asc/compaction-agentic/region
 */

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenMeter, TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { QualityReport } from './types.ts'
import { eventForSeq, validateSurfaceRange } from './protected.ts'
import { tierSnapshot, tierTokenUsage } from './tier.ts'

/** Tag wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE =
  'This checkpoint condenses an earlier span of this conversation to free up context. '
  + 'Treat the captured facts as established background and continue the task directly '
  + 'from the messages that follow, without acknowledging this checkpoint.'

/** Dependencies the transaction needs beyond the session itself. */
export interface CommitDependencies {
  readonly meter: TokenMeter
}

/** Who wrote the summary and the provenance to record with it. */
export type SummarySource =
  | {
    /** The model wrote the summary inside a `context_compress` call. */
    kind: 'model'
    summary: string
    /** The routed provider of the request that called the tool. */
    provider: string
    /** The routed model that wrote the summary. */
    model: string
    /** Quality-gate outcome, when the gate ran. */
    quality?: QualityReport
  }
  | {
    /** The fallback LLM summarizer wrote the summary. */
    kind: 'llm'
    summary: ContentBlock[]
    provider: string
    model: string
    maxTokens?: number
    /** Complete provider output before the text-only projection. */
    rawOutput?: ContentBlock[]
    /** Provider-reported usage for the summarization request. */
    usage?: TokenUsage
  }

/** Transaction options. */
export interface CommitOptions {
  /** `current-turn` derives a numbered owner; `null` writes a standalone bracket. */
  readonly owner: 'current-turn' | null
  /** Surface relationship that must survive the commit. */
  readonly stability: 'whole-surface' | 'selected-span'
  /** Optional durability checkpoint after a successfully closed bracket. */
  readonly flush?: () => Promise<void>
  /** Manual command that initiated this transaction, when present. */
  readonly sourceCommandId?: CommandId
}

/** Result of one committed compression, including derived tier and authorship. */
export interface CommitResult extends CompactionResult {
  /** Checkpoint tier derived from the shadow chain. */
  readonly tier: number
  /** Who wrote the summary. */
  readonly author: 'model' | 'fallback'
  /** Estimated tokens of the framed checkpoint node. */
  readonly summaryTokenCount: number
}

/** A summary that does not shrink the surface fails closed. */
export class SummaryNotSmallerError extends Error {
  override readonly name = 'SummaryNotSmallerError'
}

/** The surface changed while the transaction prepared. */
export class SurfaceChangedError extends Error {
  override readonly name = 'SurfaceChangedError'
}

/** Failure captured after `compaction/start` has committed. */
interface TransactionFailure {
  readonly error: unknown
  readonly stage: 'summary' | 'commit'
}

interface CompactionEntryState {
  readonly openTurn: number | null
  readonly unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined
  readonly latestEndSeedSeq: number | undefined
}

/**
 * Select the next head-anchored range while retaining a priced recent tail
 * and never splitting a tool-call/result pair or crossing protected nodes.
 * @param session - session supplying authoritative current surface positions.
 * @param measurement - unified pressure and surface measurement.
 * @param retainTokens - minimum recent tail budget retained verbatim.
 * @param protectedSeqs - surface seqs that must stay outside the span.
 * @returns the inclusive positional seq range to compact, or `null`.
 */
export function selectCompactableRange(
  session: Session,
  measurement: TokenMeasurement,
  retainTokens: number,
  protectedSeqs?: ReadonlySet<number>,
): { start: number; end: number } | null {
  const pricedNodes = measurement.nodes
  if (pricedNodes.length === 0) return null

  const surfaceNodes = session.surface.nodes
  if (surfaceNodes.length !== pricedNodes.length
    || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error('compaction: token-meter surface does not match the current session surface')
  }

  let accumulated = 0
  let keepFromIdx = pricedNodes.length
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- pricedNodes mirrors the surface
    accumulated += pricedNodes[index]!.tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }

  // Walk back until the span [0, keepFromIdx) contains no protected node.
  while (keepFromIdx > 0 && protectedSeqs !== undefined) {
    let protectedInside = false
    for (let index = 0; index < keepFromIdx; index += 1) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- index < keepFromIdx <= surface length
      if (protectedSeqs.has(surfaceNodes[index]!)) {
        protectedInside = true
        break
      }
    }
    if (!protectedInside) break
    keepFromIdx -= 1
  }
  if (keepFromIdx === 0) return null

  // Walk back to a balanced cut (no open tool call crosses it).
  while (keepFromIdx > 0) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- keepFromIdx > 0
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx]!)) break
    keepFromIdx -= 1
  }
  if (keepFromIdx === 0) return null

  // oxlint-disable-next-line typescript/no-non-null-assertion -- surface is non-empty
  const first = surfaceNodes[0]!
  // oxlint-disable-next-line typescript/no-non-null-assertion -- keepFromIdx > 0
  const cutoff = surfaceNodes[keepFromIdx - 1]!
  return { start: first, end: cutoff }
}

/**
 * Run the single compaction transaction over one validated positional span.
 * Selection and validation are read-only; the durable opening marker is
 * appended before any pricing or framing, so the `compaction/start` event is
 * the lock. The commit body (summary record, replacement, authorship record,
 * close) is appended without yielding.
 * @param dependencies - token meter for all pricing.
 * @param session - session whose surface is mutated.
 * @param start - inclusive first surface-node seq.
 * @param end - inclusive last surface-node seq.
 * @param source - summary content and provenance.
 * @param options - bracket owner, stability rule, and optional durability checkpoint.
 * @param signal - optional cancellation for standalone transactions.
 * @returns the successful durable compaction result.
 */
export async function commitSurfaceCompaction(
  dependencies: CommitDependencies,
  session: Session,
  start: number,
  end: number,
  source: SummarySource,
  options: CommitOptions,
  signal?: AbortSignal,
): Promise<CommitResult> {
  if (options.owner === null) signal?.throwIfAborted()
  const selection = validateSurfaceRange(session, start, end)
  const entryState = inspectCompactionEntryState(session.events)
  assertCompactionInactive(entryState.unmatchedCompactionStart, entryState.latestEndSeedSeq)

  let owner: number | null
  if (options.owner === null) {
    if (entryState.openTurn !== null) {
      throw new ManualCompactionError('busy', 'manual compaction: the session already has an open turn')
    }
    owner = null
  } else {
    if (entryState.openTurn === null) {
      throw new Error('compaction: no open turn — in-turn compaction must be enclosed in a turn')
    }
    owner = entryState.openTurn
  }

  const compactionId = CompactionId(randomUUID())
  const lifecycle = {
    compactionId,
    ...options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId },
    turn: owner,
  }
  const startEvent = session.append('compaction/start', lifecycle)
  let failure: TransactionFailure | undefined
  let flushFailure: unknown
  let result: CommitResult | undefined
  let closed = false
  let closing = false
  let stage: TransactionFailure['stage'] = 'summary'

  try {
    const prepared = prepareCompaction(dependencies, session, selection)
    const framed = frameCheckpoint(dependencies, session, prepared, source, compactionId, options.sourceCommandId)
    assertStable(dependencies, session, prepared, options.stability)
    stage = 'commit'
    const pending = commitBody(dependencies, session, startEvent, prepared, source, framed.message, framed.framedTokenCount)
    closing = true
    const endEvent = session.append('compaction/end', lifecycle)
    closed = true
    result = completeCommit(pending, endEvent)
  } catch (error: unknown) {
    failure = { error, stage: closing ? 'commit' : stage }
    if (!closing) {
      closing = true
      try {
        session.append('compaction/end', { ...lifecycle, error: errorChain(error) })
        closed = true
      } catch (closeError: unknown) {
        failure = { error: closeError, stage: 'commit' }
      }
    }
  }

  if (closed && options.flush !== undefined) {
    try {
      await options.flush()
    } catch (error: unknown) {
      flushFailure = error
    }
  }

  if (options.owner === null) signal?.throwIfAborted()
  if (failure !== undefined) {
    if (options.owner === null) throwManualFailure(failure)
    throw failure.error
  }
  if (flushFailure !== undefined) {
    throw new ManualCompactionError(
      'persistence',
      'manual compaction durability checkpoint failed',
      { cause: flushFailure },
    )
  }
  /* v8 ignore next -- every path without a result records and throws a failure above. */
  if (result === undefined) throw new Error('compaction committed without a result')
  return result
}

/** Classify one closed manual attempt without weakening cancellation precedence. */
function throwManualFailure(failure: TransactionFailure): never {
  if (failure.stage === 'commit') {
    throw new ManualCompactionError('commit', 'manual compaction did not commit cleanly', { cause: failure.error })
  }
  if (failure.error instanceof SurfaceChangedError) {
    throw new ManualCompactionError('changed', 'the compacted history changed during compaction', { cause: failure.error })
  }
  if (failure.error instanceof SummaryNotSmallerError) {
    throw new ManualCompactionError('summary', 'compaction could not produce a smaller summary', { cause: failure.error })
  }
  throw new ManualCompactionError('summary', 'manual compaction could not produce a summary', { cause: failure.error })
}

/**
 * Reject a durable unmatched compaction marker unless a later constructor-seed
 * boundary proves that its owner belongs to an earlier session lifecycle.
 */
function assertCompactionInactive(
  unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined,
  latestEndSeedSeq: number | undefined,
): void {
  if (unmatchedCompactionStart === undefined
    || (latestEndSeedSeq !== undefined && latestEndSeedSeq > unmatchedCompactionStart.seq)) return
  throw new ManualCompactionError(
    'busy',
    'compaction already in progress; the session compaction lock is already active',
  )
}

/** Price the validated span and snapshot its replay input. */
function prepareCompaction(
  dependencies: CommitDependencies,
  session: Session,
  selection: ReturnType<typeof validateSurfaceRange>,
): {
  selection: ReturnType<typeof validateSurfaceRange>
  shadowedTokenCount: number
  framed: { measurement: TokenMeasurement; selectedNodes: TokenMeasurement['nodes'] }
} {
  const measurement = dependencies.meter.measure(session)
  const selectedNodes = measurement.nodes.slice(selection.startIdx, selection.endIdx + 1)
  if (selectedNodes.length !== selection.shadowedSeqs.length
    || selectedNodes.some((node, index) => node.seq !== selection.shadowedSeqs[index])) {
    throw new SurfaceChangedError('compaction: selected surface changed before commit')
  }
  const shadowedTokenCount = selectedNodes.reduce((total, node) => total + node.tokens, 0)
  return { selection, shadowedTokenCount, framed: { measurement, selectedNodes } }
}

/** Build the checkpoint message and enforce the shrink invariant. */
function frameCheckpoint(
  dependencies: CommitDependencies,
  session: Session,
  prepared: ReturnType<typeof prepareCompaction>,
  source: SummarySource,
  compactionId: CompactionResult['compactionId'],
  sourceCommandId: CommandId | undefined,
): { message: UserMessage; framedTokenCount: number } {
  const summaryBlocks: ContentBlock[] = source.kind === 'model'
    ? [{ type: 'text', text: source.summary }]
    : source.summary
  if (summaryBlocks.length === 0) {
    throw new Error('compaction: summary content is empty')
  }
  const checkpointMessage = createUserMessage({
    content: frameSummary(summaryBlocks),
    source: compactCheckpointSource(compactionId, sourceCommandId),
  })
  const framedTokenCount = dependencies.meter.estimateMessage(checkpointMessage)
  if (framedTokenCount >= prepared.shadowedTokenCount) {
    throw new SummaryNotSmallerError(
      `summary is not smaller than the shadowed content (${framedTokenCount} estimated framed tokens `
      + `>= ${prepared.shadowedTokenCount} shadowed tokens)`,
    )
  }
  return { message: checkpointMessage, framedTokenCount }
}

/** Reject a summary prepared against any earlier surface generation. */
function assertStable(
  dependencies: CommitDependencies,
  session: Session,
  prepared: ReturnType<typeof prepareCompaction>,
  stability: 'whole-surface' | 'selected-span',
): void {
  const current = dependencies.meter.measure(session)
  if (stability === 'whole-surface') {
    if (!isDeepStrictEqual(current.nodes, prepared.framed.measurement.nodes)) {
      throw new SurfaceChangedError('compaction: session surface changed during commit')
    }
    return
  }
  const selection = validateSurfaceRange(session, prepared.selection.start, prepared.selection.end)
  if (!isDeepStrictEqual([...selection.shadowedSeqs], [...prepared.selection.shadowedSeqs])) {
    throw new SurfaceChangedError('compaction: the selected span changed during commit')
  }
  const measured = current.nodes.slice(selection.startIdx, selection.endIdx + 1)
  if (!isDeepStrictEqual(measured, prepared.framed.selectedNodes)) {
    throw new SurfaceChangedError('compaction: the selected span was rewritten during commit')
  }
}

/** Append the summary record, replacement, authorship record, and tier. */
function commitBody(
  dependencies: CommitDependencies,
  session: Session,
  startEvent: SessionEvent<'compaction/start'>,
  prepared: ReturnType<typeof prepareCompaction>,
  source: SummarySource,
  checkpointMessage: UserMessage,
  summaryTokenCount: number,
): Omit<CommitResult, 'endSeq'> {
  const { selection, shadowedTokenCount } = prepared
  const { start, end, shadowedSeqs } = selection
  const summaryBlocks: ContentBlock[] = source.kind === 'model'
    ? [{ type: 'text', text: source.summary }]
    : source.summary
  const callProvenance = source.kind === 'llm'
    ? source.rawOutput === undefined ? {} : { rawOutput: source.rawOutput, llmStreamCall: true as const }
    : {}

  const summaryEvent = session.append('compaction/summary', {
    compactionId: startEvent.data.compactionId,
    ...startEvent.data.sourceCommandId === undefined
      ? {}
      : { sourceCommandId: startEvent.data.sourceCommandId },
    summary: summaryBlocks,
    ...callProvenance,
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
    provider: source.provider,
    model: source.model,
    ...source.kind === 'llm' && source.maxTokens !== undefined ? { maxTokens: source.maxTokens } : {},
    ...source.kind === 'llm' && source.usage !== undefined ? { usage: source.usage } : {},
  })
  session.append('user/message', checkpointMessage, {
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
  })

  const tier = deriveTier(session, shadowedSeqs)
  const author = source.kind === 'model' ? 'model' as const : 'fallback' as const
  const postReplace = dependencies.meter.measure(session).totalTokens
  const tierTokens = tierTokenTotals(dependencies, session)
  session.append('context/compress', {
    compactionId: startEvent.data.compactionId,
    author,
    tier,
    totalTokens: postReplace,
    tierTokens,
    ...source.kind === 'model' && source.quality !== undefined
      ? {
        quality: {
          passed: source.quality.passed,
          blocking: source.quality.blocking,
          gate: source.quality.gate,
          ...source.quality.note === undefined ? {} : { note: source.quality.note },
        },
      }
      : {},
  })

  return {
    compactionId: startEvent.data.compactionId,
    ...startEvent.data.sourceCommandId === undefined
      ? {}
      : { sourceCommandId: startEvent.data.sourceCommandId },
    startSeq: startEvent.seq,
    summarySeq: summaryEvent.seq,
    summary: summaryBlocks,
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
    summaryTokenCount,
    tier,
    author,
  }
}

/** Attach the successfully appended close event to a pending result. */
function completeCommit(
  pending: Omit<CommitResult, 'endSeq'>,
  endEvent: SessionEvent<'compaction/end'>,
): CommitResult {
  return { ...pending, endSeq: endEvent.seq }
}

/** Per-tier surface totals after a replacement. */
function tierTokenTotals(
  dependencies: CommitDependencies,
  session: Session,
): { tier: number; tokens: number }[] {
  const usage = tierTokenUsage(session, dependencies.meter.measure(session))
  return [...usage.entries()]
    .filter(([tier]) => tier > 0)
    .map(([tier, tokens]) => ({ tier, tokens }))
    .sort((left, right) => left.tier - right.tier)
}

/**
 * Derive the new checkpoint's tier from its shadow chain: raw shadowed nodes
 * are tier 0, so a checkpoint over them is tier 1; consuming checkpoints of
 * tier t yields tier t + 1.
 */
function deriveTier(session: Session, shadowedSeqs: readonly number[]): number {
  const tiers = tierSnapshot(session)
  let maxShadowed = 0
  for (const seq of shadowedSeqs) {
    const tier = tiers.tierBySeq.get(seq) ?? 0
    if (tier > maxShadowed) maxShadowed = tier
  }
  return maxShadowed + 1
}

/** Wrap raw summary blocks in the durable checkpoint framing. */
export function frameSummary(summary: readonly ContentBlock[]): ContentBlock[] {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

/** Inspect open-turn, unmatched-compaction, and latest seed-boundary state independently. */
export function inspectCompactionEntryState(events: readonly SessionEvent[]): CompactionEntryState {
  let openTurn: number | null = null
  let openTurnStateKnown = false
  let unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined
  let compactionEntryStateKnown = false
  let latestEndSeedSeq: number | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index is in bounds
    const event = events[index]!
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') {
      latestEndSeedSeq = event.seq
    }
    if (!compactionEntryStateKnown) {
      if (event.type === 'compaction/start') {
        unmatchedCompactionStart = event
        compactionEntryStateKnown = true
      } else if (event.type === 'compaction/end') {
        compactionEntryStateKnown = true
      }
    }
    if (!openTurnStateKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data.turn
        openTurnStateKnown = true
      } else if (event.type === 'turn/end') {
        openTurnStateKnown = true
      }
    }
    if (openTurnStateKnown && compactionEntryStateKnown && latestEndSeedSeq !== undefined) break
  }
  return { openTurn, unmatchedCompactionStart, latestEndSeedSeq }
}

/** Replay the shadowed region into model-visible messages, in surface order. */
export function regionMessages(session: Session, shadowedSeqs: readonly number[]): Message[] {
  const events = session.events
  return shadowedSeqs
    .map(seq => session.deriveEventMessage(eventForSeq(events, seq)))
    .filter((message): message is Message => message !== null)
}
