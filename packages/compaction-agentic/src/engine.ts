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
 * @module @dsh-asc/compaction-agentic/engine
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
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import type { Agent, PreStepDecision, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
// Type-only: the optional pruner service; our own event vocabulary is empty by design.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { resolveConfig } from './config.ts'
import type { AgenticCompactionConfig, ResolvedConfig } from './types.ts'
import {
  commitSurfaceCompaction,
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
} from './nudge.ts'
import { evaluateQuality } from './quality-gate.ts'
import {
  checkpointViews,
  isProtectedNode,
  rangeIneligibility,
  validateSurfaceRange,
} from './protected.ts'
import { nodeKindOf, tierSnapshot, tierTokenUsage } from './tier.ts'
import { nudgeSource, PLUGIN_NAME, resolveRestoreTargets, restoreTargets } from './restore.ts'
import { serializeMessages, textPreview } from './text.ts'
import type {
  CompressionFailure,
  CompressionOutcome,
  ContextStatus,
  DecompressResult,
  ModelCompressResult,
  ModelCompressionRange,
  QualityReport,
  SurfaceNodePreview,
} from './types.ts'

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

  constructor(ctx: Context, config: AgenticCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.auto) this._registerAutomatic()
  }

  /**
   * Register automatic listeners: step-boundary nudge injection and
   * provider-confirmed overflow recovery with prune + deterministic
   * fallback compaction.
   */
  private _registerAutomatic(): void {
    const { ctx } = this

    ctx.on('agent/pre-step', async (
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
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })

    // A successful response starts a fresh overflow-recovery sequence even
    // when tool calls continue the same turn into another request.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowRetries.delete(agent)
    })

    ctx.on('agent/request-error', async (
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
        ctx.logger.warn(
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
    })
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
        const range = selectCompactableRange(session, measurement, 0, this.protectedSeqs(session))
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
            0,
            this.protectedSeqs(session),
          )
          if (range === null) return null
          return await this.commitFallback(range.start, range.end, agent, {
            owner: null,
            stability: 'whole-surface',
            ...sourceCommandId === undefined ? {} : { sourceCommandId },
            flush: async () => {
              await this.ctx.sessions.flush(session)
            },
          }, operationSignal)
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError('cancelled', 'manual compaction was cancelled', { cause: error })
          }
          operationSignal.throwIfAborted()
          throw error
        }
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
    const plans: { range: ModelCompressionRange; selection: ReturnType<typeof validateSurfaceRange> }[] = []
    for (const [index, range] of ranges.entries()) {
      try {
        const selection = validateSurfaceRange(session, range.startSeq, range.endSeq)
        const ineligibility = rangeIneligibility(session, selection, this.config)
        if (ineligibility !== undefined) {
          throw new Error(rangeIneligibilityMessage(ineligibility))
        }
        if (typeof range.summary !== 'string' || range.summary.trim().length === 0) {
          throw new Error('summary must be a non-empty string')
        }
        plans.push({ range, selection })
      } catch (error: unknown) {
        failures.push({ index, reason: errorMessage(error) })
      }
    }
    if (plans.length === 0) return { compressed: [], failures }

    const rangesKey = JSON.stringify(ranges.map(range => [range.startSeq, range.endSeq]))
    const gate = this.config.qualityGate
    const gateReports = new Map<number, QualityReport>()
    let gateBlocked = false

    if (gate.enabled) {
      const pending = this.qualityPending.get(session)
      if (options.acknowledgeRisk === true) {
        if (pending === undefined) {
          throw new Error('no quality-gate rejection is pending; remove acknowledgeRisk')
        }
        if (pending.rangesKey !== rangesKey) {
          throw new Error('a quality-gate rejection is pending for a different range set')
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
          const message = `quality gate rejected the compression plan (${first?.note ?? 'unknown reason'}); `
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
          plan.range.startSeq,
          plan.range.endSeq,
          {
            kind: 'model',
            summary: plan.range.summary,
            provider: target?.provider ?? agent.options.provider ?? '',
            model: target?.model ?? agent.options.model ?? '',
            ...report === undefined ? {} : { quality: report },
          },
          { owner: 'current-turn', stability: 'whole-surface' },
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
   * the log, and append the restored transcript as a durable user message.
   * @param agent - agent whose session is read and mutated.
   * @param target - compaction ids and/or a surface range, plus `full`.
   * @param signal - optional cancellation.
   * @returns restored targets and skipped records.
   */
  async decompressByModel(
    agent: Agent,
    target: { compactionIds?: string[]; startSeq?: number; endSeq?: number; full?: boolean },
    signal?: AbortSignal,
  ): Promise<DecompressResult> {
    signal?.throwIfAborted()
    const session = agent.session
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
    const restored = restoreTargets(session, targets, target.full === true, this.ctx.tokenMeter, this.config)
    return { restored: restored.restored, skipped: [...unknown, ...restored.skipped] }
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
      const checkpointEvent = session.events[view.seq]
      let summaryChars = 0
      if (checkpointEvent?.type === 'user/message') {
        for (const block of checkpointEvent.data.content) {
          if (block.type === 'text') summaryChars += Array.from(block.text).length
        }
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

    const protectedSeqs = session.surface.nodes.filter(seq => isProtectedNode(session, seq, this.config))

    const recentNodes = session.surface.nodes.slice(-STATUS_RECENT_NODES).map(seq => (
      this.surfaceNodePreview(session, measurement, tiers, seq)
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
    this.nudgeStates.set(session, applyNudgeBaseline(
      measurement.totalTokens,
      tierTokenUsage(session, measurement),
    ))
  }

  /** Update the nudge baselines after a committed compression. */
  private applyPostCompressionBaseline(session: Session, tier: number): void {
    const measurement = this.ctx.tokenMeter.measure(session)
    const state = this.nudgeStates.get(session) ?? freshNudgeState()
    this.nudgeStates.set(session, applyCompressionBaseline(
      state,
      measurement.totalTokens,
      tier,
      tierTokenUsage(session, measurement),
    ))
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
        ...options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId },
        ...options.flush === undefined ? {} : { flush: options.flush },
      },
      signal,
    )
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
      content: [{ type: 'text', text: plan.range.summary }],
      source: { kind: 'plugin', plugin: PLUGIN_NAME },
    })
    return evaluateQuality(
      {
        originalText,
        shadowedTokens,
        summaryText: plan.range.summary,
        summaryTokens: this.ctx.tokenMeter.estimateMessage(summaryMessage),
      },
      this.config.qualityGate,
    )
  }

  /** Current protected surface seqs under the resolved policy. */
  private protectedSeqs(session: Session): Set<number> {
    return new Set(session.surface.nodes.filter(seq => isProtectedNode(session, seq, this.config)))
  }

  /** Routed context-window capacity, resolving through the LLM seam when unlogged. */
  private async contextWindowOfAsync(session: Session): Promise<number | undefined> {
    const logged = session.requestContext()?.contextWindow
    if (logged !== undefined) return logged
    const target = routedTarget(session)
    if (target === undefined) return undefined
    try {
      return (await this.ctx.llm.resolveModelInfo(target.provider, target.model)).context?.contextWindow
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
  ): SurfaceNodePreview {
    const kind = nodeKindOf(session, seq)
    const node = measurement.nodes.find(candidate => candidate.seq === seq)
    const event = session.events[seq]
    let preview = ''
    if (event !== undefined) {
      const message = session.deriveEventMessage(event)
      if (message !== null) {
        preview = textPreview(
          message.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join(' ').trim(),
          STATUS_NODE_PREVIEW_CHARS,
        )
      }
    }
    return {
      seq,
      kind,
      tokens: node?.tokens ?? 0,
      tier: tiers.tierBySeq.get(seq) ?? 0,
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
