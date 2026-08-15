/**
 * Configuration and result vocabulary for the agentic compaction backend.
 *
 * @module dsh-asc/types
 */

import type { CompactionId } from '@deepseek-ai/dsh-compaction'

/** Policy fields shared by the default policy and exact model overrides. */
export interface CompactionPolicyFields {
  /** High-pressure reference fraction of the model's context window; scales the fallback retention budget. Defaults to `0.8`. */
  thresholdRatio?: number
  /** Recent context retained as a fraction of the model's window. Defaults to `0.16`. */
  retainRatio?: number
  /** Absolute recent-context budget; mutually exclusive with `retainRatio`. */
  retainTokens?: number
}

/** Exact provider/model override merged over the default compaction policy. */
export interface ModelAgenticPolicyConfig extends CompactionPolicyFields {
  /** Registered provider route to match. */
  provider: string
  /** Exact routed model id to match within `provider`. */
  model: string
}

/** Nudge policy: when and how often to inject compression guidance. */
export interface NudgeConfig {
  /** Master switch for automatic nudge injection. Defaults to `true`. */
  enabled?: boolean
  /** Below this fraction of the window, no nudges fire. Defaults to `0.45`. */
  minRatio?: number
  /** Above this fraction, strong nudges fire every `frequency` steps. Defaults to `0.8`. */
  maxRatio?: number
  /** Token growth since the last nudge required to nudge again. Defaults to `50000`. */
  growthTokens?: number
  /** Step interval for over-max nudges. Defaults to `5`. */
  frequency?: number
  /** Nudge after this many messages since the last user prompt. Defaults to `15`. */
  iterationThreshold?: number
  /** Nudge wording intensity. Defaults to `'soft'`. */
  force?: 'soft' | 'strong'
}

/** Tier policy: LSM-style distillation cadence and depth cap. */
export interface TierConfig {
  /** Master switch for tier distillation nudges. Defaults to `true`. */
  enabled?: boolean
  /** Deepest checkpoint tier; nodes at this tier cannot be consumed again. Defaults to `3`. */
  maxTier?: number
  /** Per-tier summary-token growth that triggers the next-tier nudge. Defaults to `10000`. */
  growthTokens?: number
}

/** Post-compression quality gate over model-written summaries. */
export interface QualityGateConfig {
  /** Master switch. Defaults to `true`. */
  enabled?: boolean
  /** Blocking failures reject the compression until `acknowledgeRisk` retry. Defaults to `true`. */
  blocking?: boolean
  /** L1: minimum summary length in characters. Defaults to `200`. */
  layer1MinChars?: number
  /** L1: minimum summary retention as a percent of shadowed tokens. Defaults to `1.0`. */
  layer1MinRetentionPct?: number
  /** L2: fail when ROUGE-1 F1 is below this (AND with keyword recall). Defaults to `0.05`. */
  layer2MaxRougeF1?: number
  /** L2: fail when top-20 keyword recall is below this (AND with ROUGE-1 F1). Defaults to `0.20`. */
  layer2MaxTop20Recall?: number
  /**
   * Below this unique-token ratio the shadowed content is treated as
   * repetitive noise (e.g. a stuck command re-printing one error line), and
   * the retention and ROUGE floors are waived — a length-adequate summary is
   * enough, since there is no real content to preserve. Defaults to `0.02`.
   */
  noiseUniqueRatio?: number
}

/** Deterministic fallback summarization for overflow recovery and manual compaction. */
export interface FallbackConfig {
  /** Master switch for the LLM fallback path. Defaults to `true`. */
  enabled?: boolean
  /** Summary provider; set together with `summarizationModel`, or inherit the conversation target. */
  summarizationProvider?: string
  /** Summary model; set together with `summarizationProvider`, or inherit the conversation target. */
  summarizationModel?: string
  /** Provider generation cap for fallback summarization. Defaults to `8192`. */
  maxTokens?: number
  /** Maximum overflow-recovery retries after prune + compact. Defaults to `1`. */
  maxOverflowRetries?: number
}

/** Protection policy: content that must never be shadowed by a compression. */
export interface ProtectionConfig {
  /** Protect every human user message (source kind `user`). Defaults to `false`. */
  protectUserMessages?: boolean
  /** Always protect the first human user message. Defaults to `true`. */
  protectFirstUserMessage?: boolean
  /** Protect the last N surface nodes from being included in a compression range. Defaults to `20`. */
  retainRecentMessages?: number
  /** Tool names whose call and result nodes are excluded from compression ranges. Defaults to `[]`. */
  protectedTools?: string[]
  /** Plugin names whose injected `user/message` nodes are excluded from compression ranges. Defaults to `[]`. */
  protectedSources?: string[]
}

/** Decompression budget policy. */
export interface DecompressConfig {
  /** Maximum restored tokens per decompress call, summed across targets. Defaults to `60000`. */
  maxTokens?: number
  /** Maximum blocks restored per decompress call. Defaults to `8`. */
  maxBlocks?: number
}

/** Model-facing compress-tool policy: how requests are validated and repaired. */
export interface CompressToolConfig {
  /**
   * When a requested range would split a tool-call/result pair, extend it to
   * the nearest balanced boundaries (the minimal complete tool turns) and
   * commit instead of rejecting. The extension is reported to the model.
   * Defaults to `true`.
   */
  autoExpandToolPairs?: boolean
}

/** Complete agentic compaction configuration. */
export interface AgenticCompactionConfig extends CompactionPolicyFields {
  /** Exact provider/model overrides; duplicate targets fail plugin load. */
  modelPolicies?: ModelAgenticPolicyConfig[]
  /** Enable automatic nudge and overflow-recovery listeners. Defaults to `true`. */
  auto?: boolean
  /** Model-facing compress-tool policy. */
  compress?: CompressToolConfig
  /** Nudge policy. */
  nudge?: NudgeConfig
  /** Tier policy. */
  tiers?: TierConfig
  /** Quality gate. */
  qualityGate?: QualityGateConfig
  /** Deterministic fallback. */
  fallback?: FallbackConfig
  /** Protection policy. */
  protection?: ProtectionConfig
  /** Decompression budget. */
  decompress?: DecompressConfig
}

/** Exactly one validated retention form. */
export type ResolvedRetention =
  | { readonly retainRatio: number; readonly retainTokens?: never }
  | { readonly retainRatio?: never; readonly retainTokens: number }

/** Validated immutable config. */
export interface ResolvedConfig {
  readonly thresholdRatio: number
  readonly retainRatio: number
  /** Absolute recent-tail budget; when present it wins over `retainRatio`. */
  readonly retainTokens?: number
  readonly auto: boolean
  readonly modelPolicies: readonly Readonly<ModelAgenticPolicyConfig>[]
  readonly compress: Required<CompressToolConfig>
  readonly nudge: Required<Omit<NudgeConfig, 'force'>> & { readonly force: 'soft' | 'strong' }
  readonly tiers: Required<TierConfig>
  readonly qualityGate: Required<QualityGateConfig>
  readonly fallback: Required<FallbackConfig>
  readonly protection: Required<ProtectionConfig>
  readonly decompress: Required<DecompressConfig>
}

/** One model-chosen compression range with its model-written summary. */
export interface ModelCompressionRange {
  /** First surface seq, inclusive. */
  readonly startSeq: number
  /** Last surface seq, inclusive. */
  readonly endSeq: number
  /** Model-written summary replacing the range. */
  readonly summary: string
  /** Optional per-range topic label. */
  readonly topic?: string
  /**
   * Per-range acceptance of a blocked quality-gate rejection, equivalent to
   * the call-level `acknowledgeRisk` option. Some tool-call transports can
   * only pass the content array (not the top-level option), so the engine
   * honors this field on each entry.
   */
  readonly acknowledgeRisk?: boolean
}

/** Outcome of one committed compression. */
export interface CompressionOutcome {
  readonly compactionId: CompactionId
  /** Checkpoint tier derived from the shadow chain. */
  readonly tier: number
  readonly startSeq: number
  readonly endSeq: number
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
  /** Estimated tokens of the framed checkpoint node. */
  readonly summaryTokenCount: number
  readonly author: 'model' | 'fallback'
  readonly quality?: QualityReport
  /** The per-range topic label supplied by the model, when present. */
  readonly topic?: string
  /**
   * The requested range before automatic tool-pair extension, when the
   * committed range was extended beyond what the model asked for. The model
   * must be told what was added and why.
   */
  readonly expandedFrom?: { readonly startSeq: number; readonly endSeq: number }
}

/** One failed compression entry, reported without committing anything. */
export interface CompressionFailure {
  readonly index: number
  readonly reason: string
}

/** Complete result of a model-driven compress call. */
export interface ModelCompressResult {
  readonly compressed: readonly CompressionOutcome[]
  readonly failures: readonly CompressionFailure[]
}

/** Quality-gate report for one summary. */
export interface QualityReport {
  readonly gate: 'rouge-recall-v1'
  readonly passed: boolean
  readonly blocking: boolean
  readonly layer: 1 | 2 | 'pass'
  readonly note?: string
  /** Measured values that failed the gate, when the summary was rejected. */
  readonly metrics?: QualityMetrics
}

/** Measured summary values compared against the gate thresholds. */
export interface QualityMetrics {
  /** Summary length in characters. */
  readonly summaryChars: number
  /** Summary tokens as a percent of shadowed tokens. */
  readonly retentionPct: number
  /** ROUGE-1 F1 between the summary and the original. */
  readonly rouge1F1: number
  /** Top-20 keyword recall of the summary against the original. */
  readonly top20Recall: number
  /** L1: minimum summary length in characters. */
  readonly layer1MinChars: number
  /** L1: minimum retention percent. */
  readonly layer1MinRetentionPct: number
  /** L2: ROUGE-1 F1 floor. */
  readonly layer2MaxRougeF1: number
  /** L2: top-20 keyword recall floor. */
  readonly layer2MaxTop20Recall: number
}

/** One decompression target resolved from the log. */
export interface DecompressTarget {
  readonly compactionId: CompactionId
  readonly tier: number
  readonly checkpointSeq: number
  readonly restoredSeqs: readonly number[]
  readonly restoredTokens: number
  readonly restoredChars: number
  readonly preview: string
  /** Path written by `toFile` mode; absent for in-place restores. */
  readonly path?: string
  /**
   * Always empty in the tool result: in-place restores put the transcript
   * back on the surface, and `toFile` restores put it in a file, so the
   * result deliberately never doubles the model-visible footprint.
   */
  readonly content: string
}

/** Complete result of a decompress call. */
export interface DecompressResult {
  readonly restored: readonly DecompressTarget[]
  readonly skipped: readonly string[]
}

/** One recommended compression range shown to the model. */
export interface RecommendedRange {
  /** First surface seq, inclusive (surface order, NOT numeric order). */
  readonly startSeq: number
  /** Last surface seq, inclusive (surface order, NOT numeric order). */
  readonly endSeq: number
  /** 0-based surface position of the first node (0 = oldest current node). */
  readonly startPosition: number
  /** 0-based surface position of the last node. */
  readonly endPosition: number
  readonly tokens: number
  readonly kind: 'history' | 'tool-result'
  readonly reason: string
  /**
   * Whether the range passed the commit-time validation (balanced tool
   * pairing at both edges, no protected node, outside the recent tail,
   * below the tier cap) against the surface shown by the same
   * `context_status` call. It is always `true`; re-verify with a fresh
   * `context_status` after any surface change.
   */
  readonly balanced: true
}

/** Snapshot of one checkpoint for `context_status`. */
export interface CheckpointView {
  readonly compactionId: CompactionId
  readonly seq: number
  readonly tier: number
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
  readonly summaryChars: number
  readonly author: 'model' | 'fallback'
}

/** Per-tier summary token totals for the current surface. */
export interface TierTokenUsage {
  [tier: number]: number
}

/** One surface-node preview for `context_status`. */
export interface SurfaceNodePreview {
  readonly seq: number
  /** 0-based surface position (0 = oldest current surface node). */
  readonly position: number
  readonly kind: 'user' | 'assistant' | 'tool' | 'checkpoint' | 'nudge' | 'restored'
  readonly tokens: number
  readonly tier: number
  /** Whether the node cannot be part of any valid compression range under the current policy. */
  readonly protected: boolean
  readonly preview: string
}

/**
 * Engine `status()` payload. The `context_status` tool summarizes this
 * into a compact model-facing JSON: usage fields are nested under `usage`,
 * and `recentNodes` is capped to the last 40 nodes.
 */
export interface ContextStatus {
  readonly sessionId: string
  readonly totalTokens: number
  readonly surfaceTokens: number
  readonly baselineKind: 'none' | 'estimated' | 'usage'
  readonly baselineTokens: number
  readonly contextWindow?: number
  readonly usagePercent?: number
  readonly surfaceNodes: number
  /** Where the current request's tokens are spent. */
  readonly breakdown?: {
    /** System prompt plus tool schemas when the meter cannot split them. */
    readonly systemTokens: number
    /** Tool-schema tokens, present only when separately measurable. */
    readonly toolsTokens?: number
    readonly messageTokens: number
  }
  readonly checkpoints: readonly CheckpointView[]
  readonly tierTokens: TierTokenUsage
  /** Surface seqs that cannot appear in a valid compression range (protection policy, recent tail, tier cap). */
  readonly protectedSeqs: readonly number[]
  readonly recommendations: readonly RecommendedRange[]
  readonly recentNodes: readonly SurfaceNodePreview[]
  readonly lastCompression?: { readonly compactionId: CompactionId; readonly author: 'model' | 'fallback' }
}
