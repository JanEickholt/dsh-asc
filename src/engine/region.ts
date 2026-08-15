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
 * `user/message` (surfaceOp replace), and `compaction/end` — synchronously
 * adjacent. Every later failure makes exactly one `compaction/end` attempt
 * so the unmatched start stays detectable.
 *
 * @module dsh-asc/region
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
import type { QualityReport, ResolvedConfig } from '../types.ts'
import { eventForSeq, rangeIneligibility, validateSurfaceRange } from '../policy/protected.ts'
import { tierSnapshot } from './tier.ts'

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
  /**
   * Protection/tier policy enforced inside the transaction. Engine paths
   * always pass it; low-level callers may omit it for a raw transaction.
   */
  readonly policy?: ResolvedConfig
  /**
   * The shadowed seqs the summary was written for. When present, the live
   * span must still resolve to exactly these seqs at commit time.
   */
  readonly expectedShadowedSeqs?: readonly number[]
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
 * Select the next head-anchored range while retaining a priced recent tail,
 * never splitting a tool-call/result pair, and never crossing protected
 * nodes. The range starts after any leading protected nodes (e.g. a
 * protected first user message) and ends at the first balanced, protected-free
 * cut inside the retention budget.
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

  // Start after any leading protected nodes.
  let startIdx = 0
  while (startIdx < keepFromIdx
    && protectedSeqs !== undefined
    && protectedSeqs.has(surfaceNodes[startIdx]!)) {
    startIdx += 1
  }
  if (startIdx >= keepFromIdx) return null

  // Walk the end back until the span is protected-free and the trailing cut
  // is balanced.
  let endIdx = keepFromIdx - 1
  while (endIdx >= startIdx) {
    const spanProtected = protectedSeqs !== undefined
      && surfaceNodes.slice(startIdx, endIdx + 1).some(seq => protectedSeqs.has(seq))
    if (!spanProtected && toolPairingBalancedAfter(session, surfaceNodes[endIdx]!)) break
    endIdx -= 1
  }
  if (endIdx < startIdx) return null

  // Advance the start past unbalanced leading cuts (a cut before a
  // tool/result whose call precedes the span); re-check the span afterwards.
  while (startIdx <= endIdx && !toolPairingBalancedBefore(session, surfaceNodes[startIdx]!)) {
    startIdx += 1
  }
  if (startIdx > endIdx) return null
  while (endIdx >= startIdx
    && protectedSeqs !== undefined
    && surfaceNodes.slice(startIdx, endIdx + 1).some(seq => protectedSeqs.has(seq))) {
    endIdx -= 1
  }
  if (endIdx < startIdx) return null

  // oxlint-disable-next-line typescript/no-non-null-assertion -- indices validated above
  return { start: surfaceNodes[startIdx]!, end: surfaceNodes[endIdx]! }
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
  if (options.expectedShadowedSeqs !== undefined
    && !isDeepStrictEqual([...selection.shadowedSeqs], [...options.expectedShadowedSeqs])) {
    throw new SurfaceChangedError('compaction: the selected span changed since the summary was prepared')
  }
  if (options.policy !== undefined) {
    const ineligibility = rangeIneligibility(session, selection, options.policy)
    if (ineligibility !== undefined) {
      throw new Error(eligibilityMessage(ineligibility))
    }
  }
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
    const framed = frameCheckpoint(dependencies, prepared, source, compactionId, options.sourceCommandId)
    assertStable(dependencies, session, prepared, options.stability)
    stage = 'commit'
    const pending = commitBody(session, startEvent, prepared, source, framed.message, framed.framedTokenCount)
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
  /** Tiers of the shadowed nodes, captured BEFORE any mutation. */
  shadowedTiers: number[]
  framed: { measurement: TokenMeasurement; selectedNodes: TokenMeasurement['nodes'] }
} {
  const measurement = dependencies.meter.measure(session)
  const selectedNodes = measurement.nodes.slice(selection.startIdx, selection.endIdx + 1)
  if (selectedNodes.length !== selection.shadowedSeqs.length
    || selectedNodes.some((node, index) => node.seq !== selection.shadowedSeqs[index])) {
    throw new SurfaceChangedError('compaction: selected surface changed before commit')
  }
  const shadowedTokenCount = selectedNodes.reduce((total, node) => total + node.tokens, 0)
  const tiers = tierSnapshot(session)
  const shadowedTiers = selection.shadowedSeqs.map(seq => tiers.tierBySeq.get(seq) ?? 0)
  return { selection, shadowedTokenCount, shadowedTiers, framed: { measurement, selectedNodes } }
}

/** Build the checkpoint message and enforce the shrink invariant. */
function frameCheckpoint(
  dependencies: CommitDependencies,
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

/** Append the summary record and the replacement checkpoint message. */
function commitBody(
  session: Session,
  startEvent: SessionEvent<'compaction/start'>,
  prepared: ReturnType<typeof prepareCompaction>,
  source: SummarySource,
  checkpointMessage: UserMessage,
  summaryTokenCount: number,
): Omit<CommitResult, 'endSeq'> {
  const { selection, shadowedTokenCount, shadowedTiers } = prepared
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

  const tier = 1 + shadowedTiers.reduce((max, value) => Math.max(max, value), 0)
  const author = source.kind === 'model' ? 'model' as const : 'fallback' as const

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

/** Wrap raw summary blocks in the durable checkpoint framing. */
export function frameSummary(summary: readonly ContentBlock[]): ContentBlock[] {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

/** Human-readable ineligibility reason for commit-time enforcement. */
function eligibilityMessage(
  ineligibility: { reason: string; seq?: number; position?: number; tier?: number },
): string {
  switch (ineligibility.reason) {
    case 'protected':
      return `compaction range includes protected node seq ${ineligibility.seq}`
    case 'recent-tail':
      return `compaction range reaches into the retained recent tail (position ${ineligibility.position})`
    case 'max-tier':
      return `compaction range includes a tier-${ineligibility.tier} checkpoint at the tier cap`
    default:
      return `compaction range is not eligible (${ineligibility.reason})`
  }
}

/** Inspect open-turn, unmatched-compaction, and latest seed-boundary state independently. */
export function inspectCompactionEntryState(events: readonly SessionEvent[]): CompactionEntryState {
  let openTurn: number | null = null
  let openTurnSeq: number | undefined
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
        openTurnSeq = event.seq
        openTurnStateKnown = true
      } else if (event.type === 'turn/end') {
        openTurnStateKnown = true
      }
    }
    if (openTurnStateKnown && compactionEntryStateKnown && latestEndSeedSeq !== undefined) break
  }
  // A turn opened before the latest end-seed belongs to the prior session
  // lifecycle: it must not block standalone compaction in the new lifecycle.
  if (openTurnSeq !== undefined
    && latestEndSeedSeq !== undefined
    && openTurnSeq < latestEndSeedSeq) {
    openTurn = null
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
