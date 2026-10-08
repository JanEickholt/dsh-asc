/**
 * Analytics vocabulary: usage counters and regret signals computed from the
 * durable session log.
 *
 * These are *derived observations* over committed events, never new session
 * state: every number here is reproducible by replaying the log. The scanner
 * (`scan.ts`) produces `UsageReport`s from one session's events; the signal
 * layer (`signals.ts`) derives `SignalReport`s from a `UsageReport`; the
 * `asc-stats` command renders them for the human operator.
 *
 * @module dsh-asc/analytics/types
 */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/** One checkpoint fold observed by the scanner. */
export interface CheckpointUsage {
  /** Durable compaction id from `compaction/summary`. */
  readonly compactionId: string
  /** Log seq of the `compaction/summary` event. */
  readonly summarySeq: number
  /** Checkpoint tier (1 = raw capture, 2 = decisions, 3 = facts). */
  readonly tier: number
  /** Optional topic label the model supplied at fold time. */
  readonly topic?: string
  /** Sum of seqs shadowed by this checkpoint (from `shadowedSeqs`). */
  readonly shadowedCount: number
  /** Tokens shadowed by this checkpoint (from `shadowedTokenCount`). */
  readonly shadowedTokens: number
  /** Author of the summary: `model` or `fallback`. */
  readonly author: 'model' | 'fallback'
  /** How many times `context_decompress` restored this checkpoint. */
  readonly decompressCount: number
  /** How many times `context_recap` re-read this checkpoint's summary. */
  readonly recapCount: number
}

/** One `context_*` tool call extracted from a `tool/call` event. */
export interface ToolCallUsage {
  /** Tool name: one of the six `context_*` tools. */
  readonly name: string
  /** Log seq of the `tool/call` event. */
  readonly callSeq: number
  /** Turn number, from the `tool/call` event data. */
  readonly turn: number
}

/** Result class of one `context_decompress` invocation. */
export type DecompressOutcomeKind =
  | 'restored'      // at least one target restored in place
  | 'to-file'       // restored to a file, checkpoint stayed compressed
  | 'skipped'       // all targets skipped (budget/blocks)
  | 'failed'        // tool/result carried an error

/** One decompress invocation with its outcome. */
export interface DecompressUsage extends ToolCallUsage {
  readonly name: 'context_decompress'
  /** Checkpoint ids named by the call's `compactionIds`/`content` argument. */
  readonly requestedIds: readonly string[]
  /** Ids actually restored, from the tool result's `restored` entries. */
  readonly restoredIds: readonly string[]
  /** Ids skipped by budget/blocks, from the tool result's `skipped` entries. */
  readonly skippedIds: readonly string[]
  /** Final outcome class. */
  readonly outcome: DecompressOutcomeKind
}

/** Full derived-observation report over one session's log. */
export interface UsageReport {
  /** Session identity the events belong to. */
  readonly sessionId: SessionId
  /** Highest event seq consumed by the scan (exclusive). */
  readonly scannedToSeq: number
  /** Total `tool/call` events for the six `context_*` tools, in log order. */
  readonly toolCalls: readonly ToolCallUsage[]
  /** Decompress invocations with parsed outcomes. */
  readonly decompressCalls: readonly DecompressUsage[]
  /** All checkpoints observed, oldest fold first. */
  readonly checkpoints: readonly CheckpointUsage[]
  /** Log seq of the last `compaction/summary` event, when any. */
  readonly lastFoldSeq?: number
}

/** Why a decompress is counted as regret for an earlier fold. */
export type RegretCause = 'post-fold' | 'unrelated'

/** One derived regret signal: a decompress followed a fold closely. */
export interface RegretSignal {
  /** Seq distance between fold summary and the decompress call. */
  readonly seqDistance: number
  /** Seq of the folding `compaction/summary` event. */
  readonly foldSeq: number
  /** Seq of the `context_decompress` `tool/call` event. */
  readonly decompressSeq: number
  /** Checkpoint the decompress targeted, when identifiable. */
  readonly compactionId?: string
  /** Whether the decompress targeted the just-folded checkpoint itself. */
  readonly targetedFold: boolean
}

/** Derived signals computed from one `UsageReport`. */
export interface SignalReport {
  /** Decompress calls per checkpoint id. */
  readonly decompressByCheckpoint: ReadonlyMap<string, number>
  /** Recap calls per checkpoint id. */
  readonly recapByCheckpoint: ReadonlyMap<string, number>
  /** Decompress invocations classified as post-fold regret. */
  readonly regrets: readonly RegretSignal[]
  /** Turn distance of each regret (fold turn → decompress turn). */
  readonly regretTurns: readonly number[]
  /** Tokens restored in place (sum of `restoredTokens` over restored entries). */
  readonly restoredTokensTotal: number
  /** Whether no decompress happened after the last fold (healthy tail). */
  readonly quietAfterLastFold: boolean
}

/** Options controlling regret classification. */
export interface SignalOptions {
  /** Maximum seq distance between fold and decompress to count as regret. */
  readonly regretSeqWindow: number
}

/** Fixed derivation defaults. */
export const DEFAULT_SIGNAL_OPTIONS: SignalOptions = { regretSeqWindow: 200 } as const

/** Static event-predicate helpers shared by scanner and signals. */
export interface EventPredicate {
  (event: SessionEvent): boolean
}
