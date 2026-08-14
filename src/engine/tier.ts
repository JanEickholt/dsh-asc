/**
 * Checkpoint tier derivation.
 *
 * A checkpoint's tier is a pure function of the log: tier 1 checkpoints
 * shadow raw nodes, tier 2 checkpoints shadow tier-1 checkpoints (possibly
 * mixed with raw nodes), and so on. The tier of a node is therefore
 * `1 + max(tier of its shadowed nodes)`, computed in surface order because a
 * replacement always shadows earlier nodes. No side state exists to drift.
 *
 * @module dsh-asc/tier
 */

import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { foldSurface } from '@deepseek-ai/dsh-session'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'

/** Kind of one surface node, for previews and eligibility. */
export type SurfaceNodeKind = 'user' | 'assistant' | 'tool' | 'checkpoint' | 'nudge' | 'restored'

/** Tier and kind of every current surface node. */
export interface TierSnapshot {
  /** Surface rewrite generation this snapshot describes. */
  readonly generation: number
  /** Tier by surface seq; raw nodes are tier 0. */
  readonly tierBySeq: ReadonlyMap<number, number>
  /** Kind by surface seq. */
  readonly kindBySeq: ReadonlyMap<number, SurfaceNodeKind>
  /** Shadowed seqs by checkpoint seq (replacement provenance). */
  readonly shadowedBySeq: ReadonlyMap<number, readonly number[]>
}

const tierCache = new WeakMap<Session, TierSnapshot>()

/** The plugin name used in decompression message sources. */
export const PLUGIN_NAME = 'dsh-asc'

/** Whether a user-message source is one of our nudge injections. */
export function isNudgeSource(source: { kind: string; plugin?: string; purpose?: string }): boolean {
  return source.kind === 'plugin' && source.plugin === PLUGIN_NAME && source.purpose === 'nudge'
}

/** Whether a user-message source is one of our decompression injections. */
export function isRestoredSource(source: { kind: string; plugin?: string; op?: string }): boolean {
  return source.kind === 'plugin' && source.plugin === PLUGIN_NAME && source.op === 'decompress'
}

/**
 * Classify one surface event's node kind.
 * @param session - owning session.
 * @param seq - surface seq of the event.
 * @returns the node kind.
 */
export function nodeKindOf(session: Session, seq: number): SurfaceNodeKind {
  const event = session.events[seq]
  if (event === undefined) return 'user'
  switch (event.type) {
    case 'user/message': {
      const source = event.data.source as MessageSource & { purpose?: string; op?: string }
      if (isNudgeSource(source)) return 'nudge'
      if (isRestoredSource(source)) return 'restored'
      if (isCompactCheckpointSource(source)) return 'checkpoint'
      return 'user'
    }
    case 'assistant/message':
      return 'assistant'
    case 'tool/result':
      return 'tool'
    default:
      return 'user'
  }
}

/**
 * Compute or fetch the tier snapshot for a session's current surface.
 *
 * Tiers are derived from replacement provenance in LOG order, so a consumed
 * checkpoint that is no longer on the surface keeps its tier (a tier-2
 * checkpoint shadows the tier-1 checkpoint it consumed, and the derivation
 * must still resolve that chain).
 * @param session - session whose surface is folded.
 * @returns the snapshot for the current replace generation.
 */
export function tierSnapshot(session: Session): TierSnapshot {
  const surface = session.surface
  const generation = surface.replaceGeneration
  const cached = tierCache.get(session)
  if (cached !== undefined && cached.generation === generation) return cached

  const folded = foldSurface(session.events)
  const shadowedBySeq = new Map<number, readonly number[]>()
  const tierBySeq = new Map<number, number>()
  // Replacements arrive in log order, so a checkpoint's shadowed tiers are
  // always resolved before the checkpoint that consumed them.
  for (const replacement of folded.replacements) {
    let maxShadowed = 0
    for (const shadowedSeq of replacement.shadowedSeqs) {
      const tier = tierBySeq.get(shadowedSeq) ?? 0
      if (tier > maxShadowed) maxShadowed = tier
    }
    tierBySeq.set(replacement.seq, maxShadowed + 1)
    shadowedBySeq.set(replacement.seq, replacement.shadowedSeqs)
  }

  const kindBySeq = new Map<number, SurfaceNodeKind>()
  for (const seq of surface.nodes) {
    const kind = nodeKindOf(session, seq)
    kindBySeq.set(seq, kind)
    if (!tierBySeq.has(seq)) tierBySeq.set(seq, 0)
  }

  const snapshot: TierSnapshot = {
    generation,
    tierBySeq,
    kindBySeq,
    shadowedBySeq,
  }
  tierCache.set(session, snapshot)
  return snapshot
}

/**
 * Sum surface tokens per tier from one measurement.
 * @param session - session supplying the tier snapshot.
 * @param measurement - token-meter measurement aligned with the current surface.
 * @returns a map from tier to token total; raw nodes accumulate under tier 0.
 */
export function tierTokenUsage(
  session: Session,
  measurement: TokenMeasurement,
): Map<number, number> {
  const tiers = tierSnapshot(session)
  const usage = new Map<number, number>()
  for (const node of measurement.nodes) {
    const tier = tiers.tierBySeq.get(node.seq) ?? 0
    usage.set(tier, (usage.get(tier) ?? 0) + node.tokens)
  }
  return usage
}
