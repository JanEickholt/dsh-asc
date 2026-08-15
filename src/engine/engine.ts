/**
 * The agentic compaction engine.
 *
 * `AgenticCompactionEngine` provides `ctx.compaction` on the standard DSH
 * seam while owning a different philosophy: automatic pressure triggers
 * inject compression guidance (nudges) for the model to act on, the model
 * commits its own summaries through `compressByModel`, decompression
 * replays the log, and only overflow recovery and explicit manual compaction
 * fall back to deterministic selection plus LLM summarization.
 *
 * @module dsh-asc/engine
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  CompactionEngine,
  ManualCompactionError,
} from '@deepseek-ai/dsh-compaction'
import type {
  CompactionAgentContext,
  CompactionResult,
  CompactionTrigger,
  ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import { assertNever, CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { CompactionId, isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { Agent, PreStepDecision, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
// Type-only: the optional pruner service; our own event vocabulary is empty by design.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { resolveCompactSpec, resolveConfig, resolveTargetPolicy, TargetPolicyConfigError } from '../config.ts'
import type { AgenticCompactionConfig, ResolvedConfig } from '../types.ts'
import {
  commitSurfaceCompaction,
  frameSummary,
  regionMessages,
  selectCompactableRange,
  type CommitResult,
} from './region.ts'
import { summarizeWithLlm } from './fallback.ts'
import {
  applyCompressionBaseline,
  applyNudgeBaseline,
  buildNudgeText,
  decideNudge,
  freshNudgeState,
  recommendRanges,
  type NudgeState,
} from '../policy/nudge.ts'
import { evaluateQuality } from './quality-gate.ts'
import {
  checkpointViews,
  isProtectedNode,
  nearestBalancedRange,
  rangeIneligibility,
  validateSurfaceRange,
} from '../policy/protected.ts'
import { nodeKindOf, tierSnapshot, tierTokenUsage } from './tier.ts'
import { buildRestoredContent, nudgeSource, overflowNoticeSource, PLUGIN_NAME, resolveRestoreTargets, restoreTargets } from './restore.ts'
import { blockText, serializeMessages, textPreview } from '../utils/text.ts'
import type {
  CompressionFailure,
  CompressionOutcome,
  ContextStatus,
  DecompressResult,
  DecompressTarget,
  ModelCompressResult,
  ModelCompressionRange,
  QualityGateConfig,
  QualityMetrics,
  QualityReport,
  SurfaceNodePreview,
} from '../types.ts'

/** A blocking quality-gate rejection that must be retried with `acknowledgeRisk`. */
export class CompressRejectedError extends Error {
  override readonly name = 'CompressRejectedError'
}

const MAX_RANGES_PER_CALL = 64
const STATUS_RECENT_NODES = 40
const STATUS_NODE_PREVIEW_CHARS = 60

const thresholdRatioSchema = z.number()
const retainRatioSchema = z.number()
const retainTokensSchema = z.number().step(1).min(0)
const maxTokensSchema = z.number().step(1).min(1)
const ratioSchema = z.number()
const countSchema = z.number().step(1).min(0)

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(session: Session): { provider: string; model: string } | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Derive a distinct write path for one of several `toFile` restores. The
 * requested path is used verbatim for a single target; additional targets
 * get `-<n>` inserted before the extension so no transcript overwrites
 * another.
 */
function uniqueToFilePath(requested: string, index: number, total: number): string {
  if (total <= 1) return requested
  const lastSlash = Math.max(requested.lastIndexOf('/'), requested.lastIndexOf('\\'))
  const lastDot = requested.lastIndexOf('.')
  const suffix = `-${index + 1}`
  if (lastDot <= lastSlash + 1) return `${requested}${suffix}`
  return `${requested.slice(0, lastDot)}${suffix}${requested.slice(lastDot)}`
}

/** Engine configuration schema (strict validation lives in `resolveConfig`). */
function engineConfigSchema(): z<AgenticCompactionConfig> {
  return z.object({
    thresholdRatio: thresholdRatioSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    auto: z.boolean(),
    modelPolicies: z.array(z.object({
      provider: z.string().required(),
      model: z.string().required(),
      thresholdRatio: thresholdRatioSchema,
      retainRatio: retainRatioSchema,
      retainTokens: retainTokensSchema,
    })),
    compress: z.object({
      autoExpandToolPairs: z.boolean(),
    }),
    nudge: z.object({
      enabled: z.boolean(),
      minRatio: ratioSchema,
      maxRatio: ratioSchema,
      growthTokens: maxTokensSchema,
      frequency: maxTokensSchema,
      iterationThreshold: countSchema,
      force: z.union([z.const('soft'), z.const('strong')]),
    }),
    tiers: z.object({
      enabled: z.boolean(),
      maxTier: maxTokensSchema,
      growthTokens: maxTokensSchema,
    }),
    qualityGate: z.object({
      enabled: z.boolean(),
      blocking: z.boolean(),
      layer1MinChars: countSchema,
      layer1MinRetentionPct: ratioSchema,
      layer2MaxRougeF1: ratioSchema,
      layer2MaxTop20Recall: ratioSchema,
      distillationMinChars: countSchema,
      distillationMinRetentionPct: ratioSchema,
      noiseUniqueRatio: ratioSchema,
    }),
    fallback: z.object({
      enabled: z.boolean(),
      summarizationProvider: z.string(),
      summarizationModel: z.string(),
      maxTokens: maxTokensSchema,
      maxOverflowRetries: countSchema,
    }),
    protection: z.object({
      protectUserMessages: z.boolean(),
      protectFirstUserMessage: z.boolean(),
      retainRecentMessages: countSchema,
      protectedTools: z.array(z.string()),
      protectedSources: z.array(z.string()),
    }),
    decompress: z.object({
      maxTokens: maxTokensSchema,
      maxBlocks: maxTokensSchema,
    }),
  })
}

/**
 * Agentic compaction backend: nudges on pressure, model-driven compression,
 * log-replay decompression, deterministic fallback on overflow or manual
 * compaction.
 */
export class AgenticCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  static Config: z<AgenticCompactionConfig> = engineConfigSchema()

  /** Resolved and validated configuration. */
  readonly config: ResolvedConfig

  private readonly overflowRetries = new WeakMap<Agent, number>()
  private readonly overflowAgents = new WeakMap<Session, Agent>()
  private readonly nudgeStates = new WeakMap<Session, NudgeState>()
  private readonly qualityPending = new WeakMap<Session, { rangesKey: string; message: string }>()
  /** Disposers of the automatic listeners, released on engine dispose. */
  private readonly autoDisposers: Array<() => void> = []
  private autoDisposed = false

  constructor(ctx: Context, config: AgenticCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.auto) this._registerAutomatic()
  }

  /**
   * Release every automatic listener. The engine instance may be re-armed
   * by calling `registerAutomatic()` again; unloading the plugin must leave
   * no listener behind.
   */
  dispose(): void {
    if (this.autoDisposed) return
    this.autoDisposed = true
    for (const dispose of this.autoDisposers.splice(0)) dispose()
  }

  /**
   * (Re-)register the automatic listeners after a dispose, e.g. when the
   * plugin is mounted again on a live context.
   */
  registerAutomatic(): void {
    if (!this.autoDisposed) return
    this.autoDisposed = false
    this._registerAutomatic()
  }

  /**
   * Register automatic listeners: step-boundary nudge injection and
   * provider-confirmed overflow recovery with prune + deterministic
   * fallback compaction.
   */
  private _registerAutomatic(): void {
    const { ctx } = this
    const register = (dispose: () => void): void => {
      if (this.autoDisposed) {
        dispose()
        return
      }
      this.autoDisposers.push(dispose)
    }

    register(ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          await this.compactIfNeeded(agent, 'pressure', signal)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`agentic compaction: nudge failed: ${message}; continuing the turn`)
        }
      }
      return next()
    }))

    register(ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    }))

    // A successful response starts a fresh overflow-recovery sequence even
    // when tool calls continue the same turn into another request.
    register(ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowRetries.delete(agent)
    }))

    register(ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ): Promise<RequestErrorAction> => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      if (routedTarget(agent.session) === undefined) return next()
      if (!this.config.fallback.enabled) return next()
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= this.config.fallback.maxOverflowRetries) return next()

      const generation = agent.session.surface.replaceGeneration
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError: unknown) {
        // Durable surface progress (a prune or a committed replacement) is
        // sufficient retry proof even when the optional summary phase threw.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `context-overflow compaction failed after durable surface progress: `
            + `${errorMessage(recoveryError)}; retrying from the replacement surface`,
          )
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        const logFailure = recoveryError instanceof TargetPolicyConfigError
          ? ctx.logger.error.bind(ctx.logger)
          : ctx.logger.warn.bind(ctx.logger)
        logFailure(
          `context-overflow compaction failed: ${errorMessage(recoveryError)}; `
          + `${signal.aborted ? 'cancellation prevents retry' : 'preserving the original request error'}`,
        )
        return next()
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while compaction is awaited.
      if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) {
        ctx.logger.info(
          `agentic compaction (context overflow): shadowed ${result.shadowedSeqs.length} surface nodes `
          + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
          + `~${result.shadowedTokenCount} tokens)`,
        )
      }
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    }))
  }

  /**
   * Automatic entry: pressure injects a nudge (the model decides); overflow
   * prunes tool results and commits a deterministic fallback compaction.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - pressure or provider-confirmed context overflow.
   * @param signal - live turn cancellation signal.
   * @returns the fallback compaction result, or `null` when nothing committed.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    switch (trigger) {
      case 'pressure':
        await this.maybeNudge(agent)
        return null
      case 'context-overflow': {
        if (!this.config.fallback.enabled) return null
        const session = agent.session
        const meter = this.ctx.tokenMeter
        let measurement = meter.measure(session)
        const prune = this.ctx.get('toolResultPruner')
        if (prune !== undefined) {
          prune.pruneSession(session)
          measurement = meter.measure(session)
        }
        const range = selectCompactableRange(
          session,
          measurement,
          await this.fallbackRetainTokens(agent),
          this.fallbackBlockedSeqs(session),
        )
        if (range === null) return null
        return this.commitFallback(range.start, range.end, agent, {
          owner: 'current-turn',
          stability: 'whole-surface',
        }, signal)
      }
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(trigger, 'compaction trigger')
    }
  }

  /**
   * Force one useful idle-session compaction below the pressure threshold
   * using the deterministic fallback summarizer.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  override compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    if (!this.config.fallback.enabled) return Promise.resolve(null)
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          const session = agent.session
          const range = selectCompactableRange(
            session,
            this.ctx.tokenMeter.measure(session),
            await this.fallbackRetainTokens(agent),
            this.fallbackBlockedSeqs(session),
          )
          if (range === null) return null
          return await this.commitFallback(range.start, range.end, agent, {
            owner: null,
            // The idle maintenance phase guarantees only the selected span
            // stays stable; context may legally land elsewhere between the
            // marker pair.
            stability: 'selected-span',
            ...sourceCommandId === undefined ? {} : { sourceCommandId },
            flush: async () => {
              await this.ctx.sessions.flush(session)
            },
          }, operationSignal)
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError('cancelled', 'manual compaction was cancelled', { cause: error })
          }
          // A caller-side abort must surface its exact reason, never a
          // synthetic "busy" classification.
          if (signal.aborted) throw signal.reason
          operationSignal.throwIfAborted()
          throw error
        }
      }).catch((error: unknown) => {
        // Agent cancellation and caller aborts carry their exact reasons.
        // `runMaintenance` claims the idle phase synchronously, so an async
        // rejection here is a task failure, not a busy agent. A routed
        // retention-policy misconfiguration must stay loud.
        if (error instanceof ManualCompactionError || signal.aborted) throw error
        if (error instanceof TargetPolicyConfigError) throw error
        throw new ManualCompactionError(
          'summary',
          'manual compaction could not produce a summary',
          { cause: error },
        )
      })
    } catch (error: unknown) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /**
   * Forcibly compact a range of surface nodes with the fallback summarizer.
   * The target session is `agent.session`; the caller must hold an open turn.
   * @param start - first surface seq, inclusive.
   * @param end - last surface seq, inclusive.
   * @param agent - context whose session is mutated and whose routing guides summarization.
   * @param signal - optional cancellation forwarded to summarization.
   * @returns the committed compaction result.
   */
  override async compactRegion(
    start: number,
    end: number,
    agent: CompactionAgentContext,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    if (!this.config.fallback.enabled) {
      throw new Error('compactRegion: fallback summarization is disabled')
    }
    return this.commitFallback(start, end, agent, {
      owner: 'current-turn',
      stability: 'whole-surface',
    }, signal)
  }

  /**
   * Model-driven compression: validate every range, gate the summaries, then
   * commit each range through the durable transaction.
   * @param agent - agent whose session is mutated.
   * @param ranges - model-chosen ranges with model-written summaries.
   * @param options - `acknowledgeRisk` retries a blocking quality rejection.
   * @param signal - optional cancellation.
   * @returns committed outcomes and per-entry failures.
   */
  async compressByModel(
    agent: Agent,
    ranges: readonly ModelCompressionRange[],
    options: { acknowledgeRisk?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<ModelCompressResult> {
    signal?.throwIfAborted()
    const session = agent.session
    if (ranges.length === 0) throw new Error('context_compress requires at least one range')
    if (ranges.length > MAX_RANGES_PER_CALL) {
      throw new Error(`context_compress accepts at most ${MAX_RANGES_PER_CALL} ranges per call`)
    }
    const failures: CompressionFailure[] = []
    const plans: { range: ModelCompressionRange; selection: ReturnType<typeof validateSurfaceRange>; requested?: { startSeq: number; endSeq: number } }[] = []
    for (const [index, range] of ranges.entries()) {
      try {
        let selection: ReturnType<typeof validateSurfaceRange>
        try {
          selection = validateSurfaceRange(session, range.startSeq, range.endSeq)
        } catch (error: unknown) {
          // A tool-call/result pair may not be split: when the policy allows,
          // extend the requested span to the minimal complete tool turns
          // instead of rejecting. The model is told exactly what was added.
          if (!this.config.compress.autoExpandToolPairs) throw error
          const expanded = nearestBalancedRange(session, range.startSeq, range.endSeq)
          if (expanded === null) throw error
          if (expanded.start === range.startSeq && expanded.end === range.endSeq) throw error
          selection = validateSurfaceRange(session, expanded.start, expanded.end)
        }
        const ineligibility = rangeIneligibility(session, selection, this.config)
        if (ineligibility !== undefined) {
          throw new Error(rangeIneligibilityMessage(ineligibility))
        }
        if (typeof range.summary !== 'string' || range.summary.trim().length === 0) {
          throw new Error('summary must be a non-empty string')
        }
        plans.push({
          range,
          selection,
          ...selection.start !== range.startSeq || selection.end !== range.endSeq
            ? { requested: { startSeq: range.startSeq, endSeq: range.endSeq } }
            : {},
        })
      } catch (error: unknown) {
        failures.push({ index, reason: failureWithGuidance(session, range, error) })
      }
    }
    if (plans.length === 0) return { compressed: [], failures }

    const rangesKey = JSON.stringify(ranges.map(range => [range.startSeq, range.endSeq]))
    const gate = this.config.qualityGate
    const gateReports = new Map<number, QualityReport>()
    let gateBlocked = false

    if (gate.enabled) {
      const pending = this.qualityPending.get(session)
      // The call-level option or any per-entry flag both count as an
      // acknowledgement: some tool-call transports can only pass the content
      // array, so the model declares acceptance inside each entry.
      const acknowledged = options.acknowledgeRisk === true
        || ranges.some(range => range.acknowledgeRisk === true)
      if (acknowledged) {
        if (pending === undefined) {
          throw new Error('no quality-gate rejection is pending; remove acknowledgeRisk')
        }
        if (pending.rangesKey !== rangesKey) {
          throw new Error('a quality-gate rejection is pending for a different range set')
        }
        // Bypass the BLOCK, but still measure and report the quality outcome
        // for every committed entry so the model sees what it acknowledged.
        for (const plan of plans) {
          gateReports.set(plan.selection.start, this.evaluatePlan(session, plan))
        }
      } else {
        for (const plan of plans) {
          const report = this.evaluatePlan(session, plan)
          gateReports.set(plan.selection.start, report)
          if (!report.passed && gate.blocking) {
            gateBlocked = true
            break
          }
        }
        if (gateBlocked) {
          const first = [...gateReports.values()].find(report => !report.passed)
          const detail = first?.metrics === undefined
            ? (first?.note ?? 'unknown reason')
            : qualityGateDetail(first.metrics)
          const message = `quality gate rejected the compression plan (${detail}); `
            + 'retry with acknowledgeRisk: true if you judge the summary acceptable'
          this.qualityPending.set(session, { rangesKey, message })
          throw new CompressRejectedError(message)
        }
      }
    }
    this.qualityPending.delete(session)

    const target = routedTarget(session)
    const compressed: CompressionOutcome[] = []
    for (const [index, plan] of plans.entries()) {
      signal?.throwIfAborted()
      try {
        const report = gateReports.get(plan.selection.start)
        const outcome = await commitSurfaceCompaction(
          { meter: this.ctx.tokenMeter },
          session,
          plan.selection.start,
          plan.selection.end,
          {
            kind: 'model',
            summary: plan.range.summary,
            topic: plan.range.topic,
            provider: target?.provider ?? agent.options.provider ?? '',
            model: target?.model ?? agent.options.model ?? '',
            ...report === undefined ? {} : { quality: report },
          },
          { owner: 'current-turn', stability: 'whole-surface', policy: this.config, expectedShadowedSeqs: plan.selection.shadowedSeqs },
          signal,
        )
        compressed.push({
          compactionId: outcome.compactionId,
          tier: outcome.tier,
          startSeq: outcome.shadowedRange.start,
          endSeq: outcome.shadowedRange.end,
          shadowedSeqs: outcome.shadowedSeqs,
          shadowedTokenCount: outcome.shadowedTokenCount,
          summaryTokenCount: outcome.summaryTokenCount,
          author: 'model',
          ...plan.range.topic === undefined ? {} : { topic: plan.range.topic },
          ...plan.requested === undefined ? {} : { expandedFrom: plan.requested },
          ...report === undefined ? {} : { quality: report },
        })
        this.applyPostCompressionBaseline(session, outcome.tier)
      } catch (error: unknown) {
        failures.push({ index, reason: errorMessage(error) })
      }
    }
    return { compressed, failures }
  }

  /**
   * Model-driven decompression: resolve targets, replay their content from
   * the log, and commit each transcript back into the surface at its
   * checkpoint's position (in-place restore — the compression is undone).
   *
   * With `toFile`, the restored transcript is instead written through the
   * optional fs service and the checkpoint is left compressed — the model
   * can read the file without inflating its context window. Requires a
   * mounted fs provider; without one the call fails loudly.
   * @param agent - agent whose session is read and mutated.
   * @param target - compaction ids and/or a surface range, plus `full`.
   * @param signal - optional cancellation.
   * @returns restored targets (statistics only) and skipped records.
   */
  async decompressByModel(
    agent: Agent,
    target: {
      compactionIds?: string[]
      startSeq?: number
      endSeq?: number
      full?: boolean
      toFile?: string
    },
    signal?: AbortSignal,
  ): Promise<DecompressResult> {
    signal?.throwIfAborted()
    const session = agent.session
    if ((target.startSeq === undefined) !== (target.endSeq === undefined)) {
      throw new Error('context_decompress range mode requires both startSeq and endSeq')
    }
    if (target.toFile !== undefined && target.toFile.trim().length === 0) {
      throw new Error('context_decompress toFile must be a non-empty path')
    }
    const range = target.startSeq !== undefined && target.endSeq !== undefined
      ? { startSeq: target.startSeq, endSeq: target.endSeq }
      : undefined
    if (target.compactionIds === undefined && range === undefined) {
      throw new Error('context_decompress requires compactionIds or startSeq/endSeq')
    }
    const { targets, unknown } = resolveRestoreTargets(session, target.compactionIds, range)
    if (targets.length > this.config.decompress.maxBlocks) {
      throw new Error(
        `context_decompress restores at most ${this.config.decompress.maxBlocks} blocks per call `
        + `(resolved ${targets.length}); narrow the range or pass explicit compactionIds`,
      )
    }
    if (target.toFile !== undefined) {
      // toFile mode: write the transcripts through the fs seam, keep the
      // checkpoints compressed, return paths + previews only.
      const fs = this.ctx.get('fs')
      if (fs === null || fs === undefined) {
        throw new Error('context_decompress toFile requires the fs service (mount a filesystem provider)')
      }
      const restored: DecompressTarget[] = []
      const skipped: string[] = [...unknown]
      let budgetUsed = 0
      for (const [index, t] of targets.entries()) {
        const { restoredSeqs, text, tokens, chars } = buildRestoredContent(session, t, target.full === true, this.ctx.tokenMeter)
        if (text.length === 0 || restoredSeqs.length === 0) {
          skipped.push(`${t.compactionId} (no restorable message content)`)
          continue
        }
        if (budgetUsed + tokens > this.config.decompress.maxTokens) {
          skipped.push(
            `${t.compactionId} (${tokens} tokens; combined ${budgetUsed + tokens} exceeds `
            + `the ${this.config.decompress.maxTokens}-token restore budget)`,
          )
          continue
        }
        budgetUsed += tokens
        const path = uniqueToFilePath(target.toFile, index, targets.length)
        const resolved = await fs.resolve(path)
        await fs.writeText(resolved, text, undefined, signal)
        // Report the target the fs provider actually wrote: remote/sandboxed
        // backends may normalize or remap the requested path.
        const writtenPath = typeof resolved?.displayPath === 'string'
          ? resolved.displayPath
          : typeof resolved?.path === 'string' ? resolved.path : path
        restored.push({
          compactionId: t.compactionId,
          tier: t.tier,
          checkpointSeq: t.checkpointSeq,
          restoredSeqs,
          restoredTokens: tokens,
          restoredChars: chars,
          preview: `written to ${writtenPath} (${chars} chars)`,
          path: writtenPath,
          content: '',
        })
      }
      return { restored, skipped }
    }
    const restored = restoreTargets(session, targets, target.full === true, this.ctx.tokenMeter, this.config)
    // An in-place restore deliberately inflates the surface; reset the
    // transient nudge baseline afterwards so the very next step does not
    // treat the model's own restore as unexpected growth to nag about.
    if (restored.restored.length > 0) this.applyPostRestoreBaseline(session)
    return { restored: restored.restored, skipped: [...unknown, ...restored.skipped] }
  }

  /**
   * Recap: re-fetch checkpoint summaries without decompressing the original
   * content. The summaries are read from the durable compaction/summary
   * events, so they survive even when the compress call that wrote them has
   * scrolled out of context or been consumed by a later compression.
   * Explicit ids resolve against the full log (including consumed
   * checkpoints); omitting the ids recaps every checkpoint on the current
   * surface.
   * @param agent - agent whose session is read.
   * @param compactionIds - optional ids to recap; every checkpoint on the
   *   current surface when omitted.
   * @param tier - optional tier filter: only recaps checkpoints of this tier.
   * @returns each checkpoint's summary text plus coverage metadata.
   */
  async recapByModel(
    agent: Agent,
    compactionIds: readonly string[] | undefined,
    tier?: number,
  ): Promise<Array<{
    compactionId: CompactionId
    tier: number
    seq: number
    shadowedSeqs: readonly number[]
    shadowedTokenCount: number
    summary: string
  }>> {
    const session = agent.session
    const summaryByCompactionId = new Map<string, SessionEvent<'compaction/summary'>>()
    for (const event of session.events) {
      if (event.type === 'compaction/summary') {
        summaryByCompactionId.set(event.data.compactionId, event)
      }
    }
    const wanted = compactionIds === undefined || compactionIds.length === 0
      ? undefined
      : new Set(compactionIds)
    const recapped: Array<{
      compactionId: CompactionId
      tier: number
      seq: number
      shadowedSeqs: readonly number[]
      shadowedTokenCount: number
      summary: string
    }> = []
    const push = (view: {
      compactionId: CompactionId
      seq: number
      tier: number
      shadowedSeqs: readonly number[]
    }): void => {
      const summaryEvent = summaryByCompactionId.get(view.compactionId)
      const text = summaryEvent?.data.summary
        .map(block => block.type === 'text' ? block.text : `[${block.type}]`)
        .join('\n') ?? ''
      recapped.push({
        compactionId: view.compactionId,
        tier: view.tier,
        seq: view.seq,
        shadowedSeqs: view.shadowedSeqs,
        shadowedTokenCount: summaryEvent?.data.shadowedTokenCount ?? 0,
        summary: text,
      })
    }

    if (wanted === undefined) {
      for (const view of checkpointViews(session)) {
        if (tier !== undefined && view.tier !== tier) continue
        push(view)
      }
      return recapped
    }

    // Explicit ids may name checkpoints that later tiers consumed: resolve
    // them from the full log instead of only the current surface.
    const tiers = tierSnapshot(session)
    const byCompactionId = new Map<string, number>()
    for (const event of session.events) {
      if (event.type !== 'user/message') continue
      const source = event.data.source as MessageSource & { compactionId?: string }
      // Restored transcripts also carry compactionId; only checkpoint
      // sources own a recap entry.
      if (source.compactionId !== undefined && isCompactCheckpointSource(source)) {
        byCompactionId.set(source.compactionId, event.seq)
      }
    }
    const reported = new Set<string>()
    for (const id of compactionIds ?? []) {
      if (reported.has(id)) continue
      reported.add(id)
      const seq = byCompactionId.get(id)
      if (seq === undefined) continue
      const resolvedTier = tiers.tierBySeq.get(seq) ?? 0
      if (tier !== undefined && resolvedTier !== tier) continue
      push({
        compactionId: CompactionId(id),
        seq,
        tier: resolvedTier,
        shadowedSeqs: tiers.shadowedBySeq.get(seq) ?? [],
      })
    }
    return recapped
  }

  /** Full context status for `context_status`. */
  async status(agent: Agent): Promise<ContextStatus> {
    const session = agent.session
    const meter = this.ctx.tokenMeter
    const measurement = meter.measure(session)
    const contextWindow = await this.contextWindowOfAsync(session)
    const tiers = tierSnapshot(session)
    const usage = tierTokenUsage(session, measurement)
    const tierTokens: ContextStatus['tierTokens'] = {}
    for (const [tier, tokens] of usage) {
      if (tier > 0) tierTokens[tier] = tokens
    }

    // Where the current request's tokens are spent: the non-conversation part
    // of the baseline (system prompt plus tool schemas, which the meter does
    // not split) vs the live conversation surface. The model uses this to see
    // which category dominates and compress that first — tool outputs are
    // usually the largest conversation-side item.
    const breakdown = measurement.baseline.kind === 'estimated' ? {
      systemTokens: Math.max(0, measurement.baseline.tokens - measurement.surfaceTokens),
      messageTokens: measurement.surfaceTokens,
    } : undefined

    const summaryByCompactionId = new Map<string, SessionEvent<'compaction/summary'>>()
    const summarySeqs: Array<{ compactionId: string; seq: number; author: 'model' | 'fallback' }> = []
    for (const event of session.events) {
      if (event.type === 'compaction/summary') {
        summaryByCompactionId.set(event.data.compactionId, event)
        // The upstream flag marks a call through the LLM seam: model-written
        // summaries never carry it.
        summarySeqs.push({
          compactionId: event.data.compactionId,
          seq: event.seq,
          author: event.data.llmStreamCall === true ? 'fallback' : 'model',
        })
      }
    }

    const checkpoints = checkpointViews(session).map(view => {
      const summaryEvent = summaryByCompactionId.get(view.compactionId)
      let summaryChars = 0
      for (const block of summaryEvent?.data.summary ?? []) {
        if (block.type === 'text') summaryChars += Array.from(block.text).length
      }
      return {
        compactionId: view.compactionId,
        seq: view.seq,
        tier: view.tier,
        shadowedSeqs: view.shadowedSeqs,
        shadowedTokenCount: summaryEvent?.data.shadowedTokenCount ?? 0,
        summaryChars,
        author: summaryEvent?.data.llmStreamCall === true ? 'fallback' as const : 'model' as const,
      }
    })

    // "Protected" in the model-facing report means "cannot be part of a
    // valid compress range": the explicit protection policy plus the recent
    // tail fence and tier-cap checkpoints.
    const protectedSet = new Set(session.surface.nodes.filter(seq => isProtectedNode(session, seq, this.config)))
    const tailBoundary = Math.max(0, session.surface.nodes.length - this.config.protection.retainRecentMessages)
    for (let index = tailBoundary; index < session.surface.nodes.length; index += 1) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- index is in bounds
      protectedSet.add(session.surface.nodes[index]!)
    }
    for (const seq of session.surface.nodes) {
      if ((tiers.tierBySeq.get(seq) ?? 0) >= this.config.tiers.maxTier) protectedSet.add(seq)
    }
    const protectedSeqs = session.surface.nodes.filter(seq => protectedSet.has(seq))

    const recentStart = Math.max(0, session.surface.nodes.length - STATUS_RECENT_NODES)
    const recentNodes = session.surface.nodes.slice(-STATUS_RECENT_NODES).map((seq, offset) => (
      this.surfaceNodePreview(session, measurement, tiers, seq, recentStart + offset, protectedSet.has(seq))
    ))

    const lastCompression = summarySeqs.sort((left, right) => left.seq - right.seq).at(-1)

    return {
      sessionId: session.id,
      totalTokens: measurement.totalTokens,
      surfaceTokens: measurement.surfaceTokens,
      baselineKind: measurement.baseline.kind,
      baselineTokens: measurement.baseline.tokens,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...contextWindow === undefined ? {} : { usagePercent: Math.round((measurement.totalTokens * 100) / contextWindow) },
      surfaceNodes: session.surface.nodes.length,
      ...breakdown === undefined ? {} : { breakdown },
      checkpoints,
      tierTokens,
      protectedSeqs,
      recommendations: recommendRanges(session, measurement, this.config),
      recentNodes,
      ...lastCompression === undefined
        ? {}
        : {
          lastCompression: {
            compactionId: CompactionId(lastCompression.compactionId),
            author: lastCompression.author,
          },
        },
    }
  }

  /** Inject a nudge when the policy decides one is due. */
  private async maybeNudge(agent: Agent): Promise<void> {
    const session = agent.session
    const meter = this.ctx.tokenMeter
    const measurement = meter.measure(session)
    const state = this.nudgeStates.get(session) ?? freshNudgeState()
    if (state.lastBaselineTokens === undefined) {
      // First observation: record the baseline and do not nudge.
      this.nudgeStates.set(session, applyNudgeBaseline(
        measurement.totalTokens,
        tierTokenUsage(session, measurement),
      ))
      return
    }
    const contextWindow = await this.contextWindowOfAsync(session)
    // Each pre-step evaluation advances the step counter before deciding.
    const stepped = { ...state, stepsSinceBaseline: state.stepsSinceBaseline + 1 }
    const decision = decideNudge({ session, measurement, config: this.config, contextWindow, state: stepped })
    if (decision.kind === 'none') {
      this.nudgeStates.set(session, stepped)
      return
    }
    const text = buildNudgeText({
      decision,
      totalTokens: measurement.totalTokens,
      surfaceTokens: measurement.surfaceTokens,
      contextWindow,
      config: this.config,
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: nudgeSource(),
    }), { surfaceOp: 'append' })
    // Re-measure AFTER the append: the nudge's own tokens must not show up
    // as "growth since the last check" on the very next step.
    try {
      const after = meter.measure(session)
      this.nudgeStates.set(session, applyNudgeBaseline(
        after.totalTokens,
        tierTokenUsage(session, after),
      ))
    } catch (error: unknown) {
      this.ctx.logger.warn(`agentic compaction: nudge baseline update failed: ${errorMessage(error)}`)
    }
  }

  /** Update the nudge baselines after a committed compression. */
  private applyPostCompressionBaseline(session: Session, tier: number): void {
    try {
      const measurement = this.ctx.tokenMeter.measure(session)
      const state = this.nudgeStates.get(session) ?? freshNudgeState()
      this.nudgeStates.set(session, applyCompressionBaseline(
        state,
        measurement.totalTokens,
        tier,
        tierTokenUsage(session, measurement),
      ))
    } catch (error: unknown) {
      // The compression is already durable; transient baseline bookkeeping
      // must never turn a successful commit into a reported failure.
      this.ctx.logger.warn(`agentic compaction: nudge baseline update failed: ${errorMessage(error)}`)
    }
  }

  /** Reset the transient nudge baseline after an in-place restore. */
  private applyPostRestoreBaseline(session: Session): void {
    try {
      const measurement = this.ctx.tokenMeter.measure(session)
      this.nudgeStates.set(session, applyNudgeBaseline(
        measurement.totalTokens,
        tierTokenUsage(session, measurement),
      ))
    } catch (error: unknown) {
      this.ctx.logger.warn(`agentic compaction: restore baseline update failed: ${errorMessage(error)}`)
    }
  }

  /** Run the deterministic fallback: LLM summary then the durable commit. */
  private async commitFallback(
    start: number,
    end: number,
    agent: CompactionAgentContext,
    options: {
      owner: 'current-turn' | null
      stability: 'whole-surface' | 'selected-span'
      sourceCommandId?: CommandId
      flush?: () => Promise<void>
    },
    signal?: AbortSignal,
  ): Promise<CommitResult> {
    const session = agent.session
    const selection = validateSurfaceRange(session, start, end)
    // The fallback is deterministic, not exempt: explicit manual ranges must
    // respect the same protection and tier-cap policy as model requests.
    const ineligibility = rangeIneligibility(session, selection, this.config)
    if (ineligibility !== undefined) {
      throw new Error(rangeIneligibilityMessage(ineligibility))
    }
    const header = session.requestHeader()
    const input = {
      ...header?.system === undefined ? {} : { system: header.system },
      ...header?.tools === undefined ? {} : { tools: header.tools },
      messages: regionMessages(session, selection.shadowedSeqs),
    }
    const result = await summarizeWithLlm(this.ctx, this.config, input, agent, signal)
    const committed = await commitSurfaceCompaction(
      { meter: this.ctx.tokenMeter },
      session,
      start,
      end,
      {
        kind: 'llm',
        summary: result.summary,
        provider: result.provider,
        model: result.model,
        maxTokens: result.maxTokens,
        rawOutput: result.rawOutput,
        ...result.usage === undefined ? {} : { usage: result.usage },
      },
      {
        owner: options.owner,
        stability: options.stability,
        policy: this.config,
        expectedShadowedSeqs: selection.shadowedSeqs,
        ...options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId },
        ...options.flush === undefined ? {} : { flush: options.flush },
      },
      signal,
    )
    // Tell the model what happened: an automatic compaction replaced history
    // it may not have chosen to compress. The notice is a plugin-sourced user
    // message, so it is durable, model-visible, and replayable.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text:
        `[context-management] System compacted seqs ${committed.shadowedRange.start}..`
        + `${committed.shadowedRange.end} (~${committed.shadowedTokenCount} tokens) `
        + 'after a context-overflow or manual compaction. Use context_decompress '
        + 'to restore the original content if needed.' }],
      source: overflowNoticeSource(),
    }), { surfaceOp: 'append' })
    this.applyPostCompressionBaseline(session, committed.tier)
    return committed
  }

  /** Evaluate the quality gate for one plan against the live session. */
  private evaluatePlan(
    session: Session,
    plan: { range: ModelCompressionRange; selection: ReturnType<typeof validateSurfaceRange> },
  ): QualityReport {
    const originalText = serializeMessages(regionMessages(session, plan.selection.shadowedSeqs))
    const measurement = this.ctx.tokenMeter.measure(session)
    const shadowedTokens = plan.selection.shadowedSeqs.reduce((sum, seq) => {
      const node = measurement.nodes.find(candidate => candidate.seq === seq)
      return sum + (node?.tokens ?? 0)
    }, 0)
    const summaryMessage = createUserMessage({
      content: frameSummary([{ type: 'text', text: plan.range.summary }]),
      source: { kind: 'plugin', plugin: PLUGIN_NAME },
    })
    // Distillation is a deliberate lossy transform of already-summarized
    // content: apply the tier-1 floors only to raw capture. Tier >= 2
    // summaries are gated on their own length/retention floors, and the
    // keyword-coverage layer is waived because the rules for that tier
    // require dropping lower-level process vocabulary.
    const tiers = tierSnapshot(session)
    const resultingTier = 1 + plan.selection.shadowedSeqs.reduce((maxTier, seq) => {
      const tier = tiers.tierBySeq.get(seq) ?? 0
      return Math.max(maxTier, tier)
    }, 0)
    const gateConfig: Required<QualityGateConfig> = resultingTier >= 2
      ? {
        ...this.config.qualityGate,
        layer1MinChars: this.config.qualityGate.distillationMinChars,
        layer1MinRetentionPct: this.config.qualityGate.distillationMinRetentionPct,
        layer2MaxRougeF1: 0,
        layer2MaxTop20Recall: 0,
      }
      : this.config.qualityGate
    return evaluateQuality(
      {
        originalText,
        shadowedTokens,
        summaryText: plan.range.summary,
        // The gate must price what the commit will actually land: the framed
        // checkpoint node, not the raw summary message.
        summaryTokens: this.ctx.tokenMeter.estimateMessage(summaryMessage),
      },
      gateConfig,
    )
  }

  /** Current protected surface seqs under the resolved policy. */
  private protectedSeqs(session: Session): Set<number> {
    return new Set(session.surface.nodes.filter(seq => isProtectedNode(session, seq, this.config)))
  }

  /**
   * Surface seqs the deterministic fallback must never select: protected
   * nodes, checkpoints at the tier cap, and the retained recent tail. The
   * fallback uses a token retention budget for the verbatim tail, but the
   * configured node-count tail is a hard fence on top of that budget.
   */
  private fallbackBlockedSeqs(session: Session): Set<number> {
    const blocked = this.protectedSeqs(session)
    const tiers = tierSnapshot(session)
    const nodes = session.surface.nodes
    const tailBoundary = Math.max(0, nodes.length - this.config.protection.retainRecentMessages)
    for (let index = 0; index < nodes.length; index += 1) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- index is in bounds
      const seq = nodes[index]!
      if (index >= tailBoundary || (tiers.tierBySeq.get(seq) ?? 0) >= this.config.tiers.maxTier) {
        blocked.add(seq)
      }
    }
    return blocked
  }

  /**
   * Resolve the token retention budget for deterministic fallback selection
   * from the exact routed target and its context window. When the route or
   * capacity is unknown, returns 0 — the hard recent-tail fence still applies.
   */
  private async fallbackRetainTokens(agent: CompactionAgentContext): Promise<number> {
    const session = agent.session
    const target = routedTarget(session) ?? (agent.options.provider !== undefined
      && agent.options.provider.length > 0
      && agent.options.model !== undefined
      && agent.options.model.length > 0
      ? { provider: agent.options.provider, model: agent.options.model }
      : undefined)
    if (target === undefined) return 0
    const contextWindow = await this.contextWindowOfAsync(session, target)
    if (contextWindow === undefined) return 0
    try {
      return resolveCompactSpec(
        resolveTargetPolicy(this.config, target),
        contextWindow,
      ).retainTokens
    } catch (error: unknown) {
      throw new TargetPolicyConfigError(
        `${target.provider}/${target.model}`,
        `cannot resolve the fallback retention budget: ${errorMessage(error)}`,
      )
    }
  }

  /**
   * Routed context-window capacity, resolving through the LLM seam when
   * unlogged. `fallbackTarget` supplies the route when the session has no
   * durable request header of its own. A logged capacity is used only when
   * it belongs to the same route being measured.
   */
  private async contextWindowOfAsync(
    session: Session,
    fallbackTarget?: { provider: string; model: string },
  ): Promise<number | undefined> {
    const target = routedTarget(session) ?? fallbackTarget
    if (target === undefined) return undefined
    const logged = session.requestContext()
    if (logged !== undefined
      && logged.provider === target.provider
      && logged.model === target.model
      && logged.contextWindow !== undefined
      && logged.contextWindow > 0) {
      return logged.contextWindow
    }
    try {
      const resolved = (await this.ctx.llm.resolveModelInfo(target.provider, target.model)).context?.contextWindow
      return resolved !== undefined && resolved > 0 ? resolved : undefined
    } catch {
      // An unresolvable capacity only disables ratio-based nudges; nothing to propagate.
      return undefined
    }
  }

  /** One recent-node preview line. */
  private surfaceNodePreview(
    session: Session,
    measurement: TokenMeasurement,
    tiers: ReturnType<typeof tierSnapshot>,
    seq: number,
    position: number,
    protectedNode: boolean,
  ): SurfaceNodePreview {
    const kind = nodeKindOf(session, seq)
    const node = measurement.nodes.find(candidate => candidate.seq === seq)
    const event = session.events[seq]
    let preview = ''
    if (event !== undefined) {
      const message = session.deriveEventMessage(event)
      if (message !== null) {
        preview = textPreview(
          message.content.map(blockText).join(' ').trim(),
          STATUS_NODE_PREVIEW_CHARS,
        )
      }
    }
    return {
      seq,
      position,
      kind,
      tokens: node?.tokens ?? 0,
      tier: tiers.tierBySeq.get(seq) ?? 0,
      protected: protectedNode,
      preview,
    }
  }
}

/** Human-readable ineligibility reason. */
function rangeIneligibilityMessage(
  ineligibility: { reason: string; seq?: number; position?: number; tier?: number },
): string {
  switch (ineligibility.reason) {
    case 'protected':
      return `range includes protected node seq ${ineligibility.seq}`
    case 'recent-tail':
      return `range reaches into the retained recent tail (position ${ineligibility.position})`
    case 'max-tier':
      return `range includes a tier-${ineligibility.tier} checkpoint at the tier cap`
    default:
      return `range is not eligible (${ineligibility.reason})`
  }
}

/**
 * Render the measured gate metrics into the rejection detail so the model
 * can see exactly why the summary failed and what to fix: too short, too
 * little retention, or missing key terms.
 * @param metrics - the measured values and thresholds.
 * @returns a compact human-readable failure detail.
 */
function qualityGateDetail(metrics: QualityMetrics): string {
  const parts: string[] = []
  if (metrics.summaryChars < metrics.layer1MinChars) {
    parts.push(`${metrics.summaryChars} chars < ${metrics.layer1MinChars}-char floor`)
  }
  if (metrics.retentionPct < metrics.layer1MinRetentionPct) {
    parts.push(`retention ${metrics.retentionPct.toFixed(2)}% < ${metrics.layer1MinRetentionPct}% floor`)
  }
  if (metrics.rouge1F1 < metrics.layer2MaxRougeF1
    && metrics.top20Recall < metrics.layer2MaxTop20Recall) {
    parts.push(
      `ROUGE-1 ${metrics.rouge1F1.toFixed(3)} < ${metrics.layer2MaxRougeF1} `
      + `and recall ${metrics.top20Recall.toFixed(2)} < ${metrics.layer2MaxTop20Recall} `
      + '(key terms missing)',
    )
  }
  return parts.join('; ') || 'summary below quality floors'
}

/**
 * Attach actionable guidance to a compress failure so the model can repair
 * its request instead of guessing: unbalanced tool-pairing failures name the
 * nearest balanced span, and every failure points at `context_status` for the
 * current surface.
 * @param session - session owning the surface.
 * @param range - the model's requested range.
 * @param error - the failure that rejected it.
 * @returns the failure message, extended with guidance when applicable.
 */
function failureWithGuidance(
  session: Session,
  range: ModelCompressionRange,
  error: unknown,
): string {
  const message = errorMessage(error)
  if (!message.includes('balanced boundary')) return message
  const expanded = nearestBalancedRange(session, range.startSeq, range.endSeq)
  const hint = expanded === null
    ? '; run context_status to see the current surface and its recommended ranges'
    : `; the nearest balanced span is seqs ${expanded.start}..${expanded.end} `
      + '(run context_status to see the current surface and its recommended ranges)'
  return `${message}${hint}`
}
