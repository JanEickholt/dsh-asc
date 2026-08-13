/**
 * Session-event vocabulary owned by the agentic compaction backend.
 *
 * All three events are log-only (no `surfaceOp`): they never enter the
 * model surface themselves. The model-visible counterparts (a nudge, a
 * restored transcript) are appended as ordinary `user/message` surface
 * events immediately after their record, following the shadow-price
 * adjacency protocol used by `compaction/prune`.
 *
 * @module @dsh-asc/compaction-agentic/events
 */

import type { CompactionId } from '@deepseek-ai/dsh-compaction'

/** One recommended compression range recorded inside a nudge record. */
export interface NudgeRecommendation {
  readonly start: number
  readonly end: number
  readonly reason: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records one injected compression-guidance nudge — log-only. The
     * following `user/message` (appended synchronously right after this
     * event) carries the nudge text with source
     * `{ kind: 'plugin', plugin: 'dsh-asc', purpose: 'nudge' }`. The
     * recorded `totalTokens` is the token-meter total at emission time, so
     * the nudge state machine can fold its baseline from the log.
     */
    'context/nudge': {
      kind: 'pressure' | 'iteration' | 'tier'
      /** The tier being recommended for distillation, when kind is `tier`. */
      tier?: number
      /** Token-meter total at emission. */
      totalTokens: number
      /** Token-meter surface total at emission. */
      surfaceTokens: number
      /** Token growth since the previous baseline record. */
      growthSinceBaseline: number
      /** Per-tier surface token totals at emission, for tier cadence folding. */
      tierTokens?: { tier: number; tokens: number }[]
      /** Ranges the nudge recommends, in surface seqs. */
      recommendation?: NudgeRecommendation[]
    }
    /**
     * Records one committed compression's authorship and tier — log-only.
     * Its `compactionId` matches the enclosing `compaction/start` bracket;
     * the event is appended after the replacement `user/message` and before
     * `compaction/end`. `totalTokens` is the token-meter total just after
     * the replacement, which the nudge fold uses as its next baseline.
     */
    'context/compress': {
      compactionId: CompactionId
      /** Who wrote the summary: the model through a tool, or the fallback LLM path. */
      author: 'model' | 'fallback'
      /** Checkpoint tier derived from the shadow chain. */
      tier: number
      /** Token-meter total immediately after the replacement. */
      totalTokens: number
      /** Per-tier surface token totals immediately after the replacement. */
      tierTokens?: { tier: number; tokens: number }[]
      /** Quality-gate outcome, when the gate ran. */
      quality?: { passed: boolean; blocking: boolean; gate: string; note?: string }
    }
    /**
     * Records one decompression — log-only. The following `user/message`
     * (appended synchronously right after) carries the restored transcript
     * with source `{ kind: 'plugin', plugin: 'dsh-asc', op: 'decompress',
     * compactionId, tier, full }` and `surfaceOp: 'append'`.
     */
    'context/decompress': {
      compactionId: CompactionId
      /** Tier of the decompressed checkpoint. */
      tier: number
      /** Whether the restore expanded all the way to raw content. */
      full: boolean
      /** The event seqs whose content was restored, in surface order. */
      restoredSeqs: number[]
      /** Estimated tokens of the restored transcript. */
      restoredTokens: number
      /** Character length of the restored transcript. */
      restoredChars: number
    }
  }
}
