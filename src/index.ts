/**
 * Agentic Surface Compaction backend for DeepSeek Harness.
 *
 * Mount this package instead of `@deepseek-ai/dsh-compaction-basic` on the
 * same `ctx.compaction` seam. The model decides when and what to compact
 * through the six `context_*` tools; every decision is committed as a
 * durable session-log replacement, decompression replays the log, nudges
 * are logged and precisely priced, and overflow recovery or manual
 * compaction falls back to the deterministic LLM summarizer. Oversized tool
 * results are projected content-aware post-execute while their originals
 * stay durable as shadowed session-log events.
 *
 * @module dsh-asc
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session/types'
import { AgenticCompactionEngine } from './engine/engine.ts'
import { registerContextTools } from './tools/tools.ts'
import { registerPhilosophyPrompt } from './engine/prompt.ts'
import { ToolResultProjectionService } from './projection/service.ts'
import { resolveConfig } from './config.ts'
import type { AgenticCompactionConfig } from './types.ts'

export { AgenticCompactionEngine, CompressRejectedError } from './engine/engine.ts'
export { resolveConfig, TargetPolicyConfigError } from './config.ts'
export { ToolResultProjectionService, PROJECTION_SERVICE_ID } from './projection/service.ts'
export type { ResolvedProjectionConfig } from './projection/service.ts'
export { planProjection, contentHash, buildMarker } from './projection/projection.ts'
export { compressStructured, detectContentType } from './projection/structured.ts'
export type { ContentType, StructuredResult } from './projection/structured.ts'
export {
  commitSurfaceCompaction,
  selectCompactableRange,
  frameSummary,
  foldFingerprint,
  regionMessages,
  inspectCompactionEntryState,
  SummaryNotSmallerError,
  SurfaceChangedError,
} from './engine/region.ts'
export {
  applyCompressionBaseline,
  applyNudgeBaseline,
  decideNudge,
  freshNudgeState,
  recommendRanges,
  buildNudgeText,
} from './policy/nudge.ts'
export { evaluateQuality, wordTokens, rouge1F1, topKeywordRecall, topNumericRecall } from './engine/quality-gate.ts'
export {
  resolveRestoreTargets,
  expandRestoreSeqs,
  buildRestoredContent,
  restoreTargets,
} from './engine/restore.ts'
export { serializeMessage, serializeMessages, textPreview } from './utils/text.ts'
export { tierSnapshot, tierTokenUsage, nodeKindOf } from './engine/tier.ts'
export type {
  CheckpointUsage,
  ToolCallUsage,
  DecompressUsage,
  DecompressOutcomeKind,
  UsageReport,
  RegretCause,
  RegretSignal,
  SignalReport,
  SignalOptions,
} from './analytics/types.ts'
export { DEFAULT_SIGNAL_OPTIONS } from './analytics/types.ts'
export { registerAnalyticsCommand } from './analytics/command.ts'
export type {
  AgenticCompactionConfig,
  ModelAgenticPolicyConfig,
  NudgeConfig,
  TierConfig,
  QualityGateConfig,
  FallbackConfig,
  ProtectionConfig,
  DecompressConfig,
  ProjectionConfig,
  AnalyticsConfig,
  ModelCompressionRange,
  CompressionOutcome,
  CompressionFailure,
  ModelCompressResult,
  DecompressTarget,
  DecompressResult,
  RecommendedRange,
  CheckpointView,
  TierTokenUsage,
  SurfaceNodePreview,
  ContextStatus,
  QualityReport,
} from './types.ts'

/** Cordis plugin name. */
export const name = 'dsh-asc'
/** Hard dependencies required before the backend can register. */
export const inject = ['llm', 'tokenMeter', 'sessions', 'tools', 'systemPrompt']
/** Plugin configuration schema. */
export const Config = AgenticCompactionEngine.Config

/**
 * Register the agentic compaction backend: the `compaction` service, the
 * six `context_*` tools, the compression-doctrine system section, the
 * automatic nudge/overflow listeners, and the optional post-execute
 * tool-result projection service.
 *
 * Registration is an effect: the returned function unloads every
 * contribution (engine listeners, tools, system section, projection) so the
 * plugin can be mounted and unmounted at runtime via `ctx.plugin()`.
 * @param ctx - Cordis context.
 * @param config - validated plugin configuration.
 * @returns a disposer that fully unloads the plugin.
 */
export function apply(ctx: Context, config: AgenticCompactionConfig = {}): () => void {
  const engine = new AgenticCompactionEngine(ctx, config)
  let projection: ToolResultProjectionService | undefined
  let disposePhilosophy: (() => void) | undefined
  let disposeTools: (() => void) | undefined
  try {
    // Separate optional service: independent of the compaction engine and of
    // the overflow-only toolResultPruner, which stays mounted as fallback.
    const resolved = resolveConfig(config)
    if (resolved.projection.enabled) {
      projection = new ToolResultProjectionService(ctx, resolved.projection)
    }
    disposePhilosophy = registerPhilosophyPrompt(ctx)
    disposeTools = registerContextTools(ctx, engine)
  } catch (error: unknown) {
    // A partial apply must not leave automatic listeners behind.
    disposeTools?.()
    disposePhilosophy?.()
    projection?.dispose()
    engine.dispose()
    throw error
  }
  return () => {
    disposeTools?.()
    disposePhilosophy?.()
    projection?.dispose()
    engine.dispose()
  }
}
