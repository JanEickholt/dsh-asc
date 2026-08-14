/**
 * Agentic Surface Compaction backend for DeepSeek Harness.
 *
 * Mount this package instead of `@deepseek-ai/dsh-compaction-basic` on the
 * same `ctx.compaction` seam. The model decides when and what to compact
 * through the four `context_*` tools; every decision is committed as a
 * durable session-log replacement, decompression replays the log, nudges
 * are logged and precisely priced, and overflow recovery or manual
 * compaction falls back to the deterministic LLM summarizer.
 *
 * @module dsh-asc
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session/types'
import { AgenticCompactionEngine } from './engine.ts'
import { registerContextTools } from './tools.ts'
import { registerPhilosophyPrompt } from './prompt.ts'
import type { AgenticCompactionConfig } from './types.ts'

export { AgenticCompactionEngine, CompressRejectedError } from './engine.ts'
export { resolveConfig, TargetPolicyConfigError } from './config.ts'
export {
  commitSurfaceCompaction,
  selectCompactableRange,
  frameSummary,
  regionMessages,
  inspectCompactionEntryState,
  SummaryNotSmallerError,
  SurfaceChangedError,
} from './region.ts'
export {
  applyCompressionBaseline,
  applyNudgeBaseline,
  decideNudge,
  freshNudgeState,
  recommendRanges,
  buildNudgeText,
} from './nudge.ts'
export { evaluateQuality, wordTokens, rouge1F1, topKeywordRecall } from './quality-gate.ts'
export {
  resolveRestoreTargets,
  expandRestoreSeqs,
  buildRestoredContent,
  restoreTargets,
} from './restore.ts'
export { serializeMessage, serializeMessages, textPreview } from './text.ts'
export { tierSnapshot, tierTokenUsage, nodeKindOf } from './tier.ts'
export type {
  AgenticCompactionConfig,
  ModelAgenticPolicyConfig,
  NudgeConfig,
  TierConfig,
  QualityGateConfig,
  FallbackConfig,
  ProtectionConfig,
  DecompressConfig,
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
export const name = 'compaction-agentic'
/** Hard dependencies required before the backend can register. */
export const inject = ['llm', 'tokenMeter', 'sessions', 'tools', 'systemPrompt']
/** Plugin configuration schema. */
export const Config = AgenticCompactionEngine.Config

/**
 * Register the agentic compaction backend: the `compaction` service, the
 * five `context_*` tools, the compression-doctrine system section, and
 * the automatic nudge/overflow listeners.
 *
 * Registration is an effect: the returned function unloads every
 * contribution (engine listeners, tools, system section) so the plugin
 * can be mounted and unmounted at runtime via `ctx.plugin()`.
 * @param ctx - Cordis context.
 * @param config - validated plugin configuration.
 * @returns a disposer that fully unloads the plugin.
 */
export function apply(ctx: Context, config: AgenticCompactionConfig = {}): () => void {
  const engine = new AgenticCompactionEngine(ctx, config)
  const disposePhilosophy = registerPhilosophyPrompt(ctx)
  const disposeTools = registerContextTools(ctx, engine)
  return () => {
    disposeTools()
    disposePhilosophy()
    engine.dispose()
  }
}
