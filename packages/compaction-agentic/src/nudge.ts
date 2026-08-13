/**
 * Nudge state machine.
 *
 * The nudge decision combines the current token-meter measurement with a
 * transient per-session baseline: growth since the last baseline (a nudge
 * or a compression) decides when to inject compression guidance. State is
 * in-memory because this harness release has no registration surface for
 * out-of-tree plugin events (the persistence layer refuses unknown event
 * types); a fresh process re-establishes the baseline before nudging again,
 * so a restart can never double-fire. Every nudge itself is a durable
 * `user/message` with source `{ kind: 'plugin', plugin: 'dsh-asc',
 * purpose: 'nudge' }`, so "model-visible ⟺ logged" holds and the cost of
 * guidance is measurable from the log.
 *
 * Baseline semantics: a nudge resets its own cadence; a compression resets
 * the baseline of the tier it CONSUMED (a tier-2 checkpoint reduces the
 * tier-1 pile), while a tier-1 capture only grows the tier-1 pile and must
 * not reset it — otherwise tier distillation could never accumulate growth.
 *
 * @module @dsh-asc/compaction-agentic/nudge
 */

import { toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { ResolvedConfig, RecommendedRange } from './types.ts'
import { isProtectedNode } from './protected.ts'
import { nodeKindOf, tierSnapshot, tierTokenUsage } from './tier.ts'

/** Nudge kinds. */
export type NudgeKind = 'pressure' | 'iteration' | 'tier'

/** Transient per-session nudge state. */
export interface NudgeState {
  /** Token-meter total at the last baseline, or undefined before the first observation. */
  readonly lastBaselineTokens: number | undefined
  /** Per-tier token totals at the last baseline that recorded them. */
  readonly tierBaselines: ReadonlyMap<number, number>
  /** Number of steps since the last baseline. */
  readonly stepsSinceBaseline: number
}

/** A fresh session state: no baseline yet. */
export function freshNudgeState(): NudgeState {
  return {
    lastBaselineTokens: undefined,
    tierBaselines: new Map(),
    stepsSinceBaseline: 0,
  }
}

/**
 * Record a compression's baseline effect: the new total becomes the growth
 * baseline, and a distillation (tier >= 2) additionally resets the cadence
 * of the tier it consumed.
 * @param state - session nudge state.
 * @param totalTokens - token-meter total after the replacement.
 * @param tier - the new checkpoint's tier.
 * @param tierTokens - per-tier token totals after the replacement.
 * @returns the updated state.
 */
export function applyCompressionBaseline(
  state: NudgeState,
  totalTokens: number,
  tier: number,
  tierTokens: ReadonlyMap<number, number>,
): NudgeState {
  const tierBaselines = new Map(state.tierBaselines)
  if (tier > 1) {
    const consumedTier = tier - 1
    const consumed = tierTokens.get(consumedTier)
    if (consumed !== undefined) tierBaselines.set(consumedTier, consumed)
  }
  return {
    lastBaselineTokens: totalTokens,
    tierBaselines,
    stepsSinceBaseline: 0,
  }
}

/**
 * Record a nudge's baseline effect: the nudge resets its own cadence and
 * every tier baseline.
 * @param state - session nudge state.
 * @param totalTokens - token-meter total at emission.
 * @param tierTokens - per-tier token totals at emission.
 * @returns the updated state.
 */
export function applyNudgeBaseline(
  state: NudgeState,
  totalTokens: number,
  tierTokens: ReadonlyMap<number, number>,
): NudgeState {
  const tierBaselines = new Map<number, number>()
  for (const [tier, tokens] of tierTokens) {
    if (tier > 0) tierBaselines.set(tier, tokens)
  }
  return {
    lastBaselineTokens: totalTokens,
    tierBaselines,
    stepsSinceBaseline: 0,
  }
}

/** Inputs for one nudge decision. */
export interface NudgeInput {
  readonly session: Session
  readonly measurement: TokenMeasurement
  readonly config: ResolvedConfig
  /** Routed context-window capacity, when the adapter advertises one. */
  readonly contextWindow: number | undefined
  /** Transient per-session nudge state. */
  readonly state: NudgeState
}

/** One nudge decision. */
export interface NudgeDecision {
  readonly kind: NudgeKind | 'none'
  /** The tier being recommended for distillation, when kind is `tier`. */
  readonly tier?: number
  /** Why the nudge fired. */
  readonly reason: string
  /** Token growth since the current baseline. */
  readonly growth: number
  readonly recommendations: readonly RecommendedRange[]
}

/**
 * Decide whether to inject compression guidance on this step.
 *
 * Priority: over-max pressure (frequency-gated) > tier distillation
 * (growth-gated) > iteration length (threshold-gated). Without a routed
 * context window only tier nudges can fire. Before the first observation
 * (no baseline yet) the decision is always `none` — the caller records the
 * baseline instead.
 * @param input - session, measurement, transient state, and policy.
 * @returns the decision; `kind: 'none'` injects nothing.
 */
export function decideNudge(input: NudgeInput): NudgeDecision {
  const { session, measurement, config, contextWindow, state } = input
  const nudge = config.nudge
  const tiers = config.tiers
  if (!nudge.enabled) return none()
  if (state.lastBaselineTokens === undefined) return none()

  const total = measurement.totalTokens
  const baseline = state.lastBaselineTokens
  const growth = Math.max(0, total - baseline)
  const overMax = contextWindow !== undefined && total >= contextWindow * nudge.maxRatio
  const overMin = contextWindow !== undefined && total >= contextWindow * nudge.minRatio

  if (overMax && state.stepsSinceBaseline >= nudge.frequency) {
    return {
      kind: 'pressure',
      reason: `context ${percent(total, contextWindow)}% is at or above the max ratio `
        + `${Math.round(nudge.maxRatio * 100)}%`,
      growth,
      recommendations: recommendRanges(session, measurement, config),
    }
  }

  if (tiers.enabled) {
    const usage = tierTokenUsage(session, measurement)
    for (let inputTier = 1; inputTier < tiers.maxTier; inputTier += 1) {
      const tierTokens = usage.get(inputTier) ?? 0
      const tierBaseline = state.tierBaselines.get(inputTier) ?? tierTokens
      if (tierTokens - tierBaseline >= tiers.growthTokens
        && hasConsumableCheckpoint(session, inputTier, config)) {
        return {
          kind: 'tier',
          tier: inputTier + 1,
          reason: `tier-${inputTier} summaries grew by `
            + `${tierTokens - tierBaseline} tokens since the last baseline`,
          growth,
          recommendations: recommendTierRanges(session, measurement, config, inputTier),
        }
      }
    }
  }

  if (overMin && state.stepsSinceBaseline >= 1) {
    const sinceUser = nodesSinceLastUser(session)
    if (sinceUser >= nudge.iterationThreshold) {
      return {
        kind: 'iteration',
        reason: `${sinceUser} messages since the last user prompt (threshold ${nudge.iterationThreshold})`,
        growth,
        recommendations: recommendRanges(session, measurement, config),
      }
    }
  }

  return none()
}

function none(): NudgeDecision {
  return { kind: 'none', reason: '', growth: 0, recommendations: [] }
}

function percent(tokens: number, window: number | undefined): number {
  return window === undefined ? 0 : Math.round((tokens * 100) / window)
}

/** Whether at least one current checkpoint at `tier` is consumable. */
function hasConsumableCheckpoint(session: Session, tier: number, config: ResolvedConfig): boolean {
  const snap = tierSnapshot(session)
  for (const seq of session.surface.nodes) {
    if ((snap.tierBySeq.get(seq) ?? 0) !== tier) continue
    if (!isProtectedNode(session, seq, config)) return true
  }
  return false
}

/** Number of surface nodes after the last human user message. */
export function nodesSinceLastUser(session: Session): number {
  const nodes = session.surface.nodes
  let lastUserIdx = -1
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index is in bounds
    const event = session.events[nodes[index]!]
    if (event?.type === 'user/message'
      && (event.data.source as { kind: string }).kind === 'user') {
      lastUserIdx = index
      break
    }
  }
  if (lastUserIdx === -1) return 0
  return nodes.length - lastUserIdx - 1
}

/**
 * Build up to three recommended ranges: the head-history span and the two
 * largest eligible tool results.
 * @param session - session owning the surface.
 * @param measurement - current measurement.
 * @param config - resolved policy.
 * @returns recommended ranges in priority order.
 */
export function recommendRanges(
  session: Session,
  measurement: TokenMeasurement,
  config: ResolvedConfig,
): RecommendedRange[] {
  const recommendations: RecommendedRange[] = []
  const head = recommendHeadRange(session, measurement, config)
  if (head !== null) recommendations.push(head)
  for (const big of recommendBigToolResults(session, measurement, config, 2)) {
    recommendations.push(big)
  }
  return recommendations
}

/**
 * Tier-targeted recommendations: contiguous runs of `tier`-level checkpoints
 * in surface order, priced from the measurement.
 * @param session - session owning the surface.
 * @param measurement - current measurement.
 * @param config - resolved policy (eligibility only).
 * @param tier - the checkpoint tier to recommend for consumption.
 * @returns up to three ranges.
 */
export function recommendTierRanges(
  session: Session,
  measurement: TokenMeasurement,
  config: ResolvedConfig,
  tier: number,
): RecommendedRange[] {
  const snap = tierSnapshot(session)
  const recommendations: RecommendedRange[] = []
  let runStartIdx = -1
  let runTokens = 0
  const flush = (): void => {
    if (runStartIdx === -1) return
    const startSeq = measurement.nodes[runStartIdx]?.seq
    let runEndIdx = runStartIdx
    for (let index = runStartIdx; index < measurement.nodes.length; index += 1) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- index is in bounds
      const node = measurement.nodes[index]!
      if ((snap.tierBySeq.get(node.seq) ?? 0) !== tier) break
      runEndIdx = index
      runTokens += node.tokens
    }
    const endSeq = measurement.nodes[runEndIdx]?.seq
    if (startSeq !== undefined && endSeq !== undefined) {
      recommendations.push({
        startSeq,
        endSeq,
        startPosition: runStartIdx,
        endPosition: runEndIdx,
        tokens: runTokens,
        kind: 'history',
        reason: `tier-${tier} summaries`,
      })
    }
    runStartIdx = -1
    runTokens = 0
  }
  for (let index = 0; index < measurement.nodes.length; index += 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index is in bounds
    const node = measurement.nodes[index]!
    const isTarget = (snap.tierBySeq.get(node.seq) ?? 0) === tier
    if (isTarget && !isProtectedNode(session, node.seq, config)) {
      if (runStartIdx === -1) runStartIdx = index
    } else {
      flush()
    }
  }
  flush()
  return recommendations.slice(0, 3)
}

/** The head-history range bounded by the recent-tail budget. */
function recommendHeadRange(
  session: Session,
  measurement: TokenMeasurement,
  config: ResolvedConfig,
): RecommendedRange | null {
  const nodes = session.surface.nodes
  if (nodes.length === 0) return null
  const tailBoundary = nodes.length - config.protection.retainRecentMessages
  if (tailBoundary <= 0) return null
  const protectedSeqs = new Set(
    nodes.filter(seq => isProtectedNode(session, seq, config)),
  )
  // Start after any leading protected nodes (e.g. a protected first prompt).
  let startIdx = 0
  while (startIdx < tailBoundary && protectedSeqs.has(nodes[startIdx]!)) startIdx += 1
  if (startIdx >= tailBoundary) return null
  let endIdx = tailBoundary - 1
  while (endIdx >= startIdx) {
    const spanProtected = nodes.slice(startIdx, endIdx + 1).some(seq => protectedSeqs.has(seq))
    if (!spanProtected && toolPairingBalancedAfter(session, nodes[endIdx]!)) break
    endIdx -= 1
  }
  if (endIdx < startIdx) return null
  let tokens = 0
  for (const node of measurement.nodes) {
    tokens += node.tokens
    if (node.seq === nodes[endIdx]!) break
  }
  return {
    startSeq: nodes[startIdx]!,
    endSeq: nodes[endIdx]!,
    startPosition: startIdx,
    endPosition: endIdx,
    tokens,
    kind: 'history',
    reason: 'older conversation history',
  }
}

/** The largest eligible single-node tool results. */
function recommendBigToolResults(
  session: Session,
  measurement: TokenMeasurement,
  config: ResolvedConfig,
  limit: number,
): RecommendedRange[] {
  const candidates = measurement.nodes
    .filter(node => nodeKindOf(session, node.seq) === 'tool')
    .sort((left, right) => right.tokens - left.tokens)
  const results: RecommendedRange[] = []
  for (const node of candidates) {
    if (results.length >= limit) break
    if (isProtectedNode(session, node.seq, config)) continue
    const position = session.surface.nodes.indexOf(node.seq)
    if (position >= session.surface.nodes.length - config.protection.retainRecentMessages) continue
    results.push({
      startSeq: node.seq,
      endSeq: node.seq,
      startPosition: position,
      endPosition: position,
      tokens: node.tokens,
      kind: 'tool-result',
      reason: 'large tool result',
    })
  }
  return results
}

/** Model-facing nudge text (pinned verbatim; tests assert its phrases). */
export function buildNudgeText(input: {
  decision: NudgeDecision
  totalTokens: number
  surfaceTokens: number
  contextWindow: number | undefined
  config: ResolvedConfig
}): string {
  const { decision, totalTokens, surfaceTokens, contextWindow, config } = input
  const windowText = contextWindow === undefined
    ? 'unknown window'
    : `${percent(totalTokens, contextWindow)}% of ${contextWindow}`
  const lines: string[] = [
    `[context-management] Current context: ${totalTokens} tokens (${windowText}) across `
    + `${surfaceTokens} surface tokens; ${decision.growth} tokens of growth since the last check.`,
  ]
  if (decision.kind === 'pressure') {
    lines.push(
      config.nudge.force === 'strong'
        ? 'Context is high. Compress older spans now with context_compress to avoid overflow; '
          + 'otherwise the deterministic fallback will compact automatically.'
        : 'If older spans are no longer needed verbatim, consider compressing them with context_compress.',
    )
  } else if (decision.kind === 'tier') {
    lines.push(
      `Tier-${decision.tier! - 1} summaries have accumulated. Distill them into a Tier-${decision.tier} `
      + 'checkpoint with context_compress so summaries stay dense.',
    )
  } else if (decision.kind === 'iteration') {
    lines.push(
      'The current work has produced many messages since the last user prompt. '
      + 'If older intermediate results are settled, compress them with context_compress.',
    )
  }
  if (decision.recommendations.length > 0) {
    lines.push('Recommended ranges (surface seqs; positions follow context_status recentNodes order):')
    for (const range of decision.recommendations) {
      lines.push(
        `- seqs ${range.startSeq}..${range.endSeq} (positions ${range.startPosition}..${range.endPosition}, `
        + `~${range.tokens} tokens): ${range.reason}`,
      )
    }
    lines.push('To restore compressed content later, use context_decompress with the compactionId shown by context_status.')
  }
  lines.push('Context management is optional: only compress what you judge safe to summarize.')
  return lines.join('\n')
}
