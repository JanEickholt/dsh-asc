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
import { SessionLogOffset, isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { isNudgeSource, isRestoredSource } from '../events.ts'

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

/**
 * Incremental replacement-provenance fold over one session's append-only
 * log: `processed` events have been folded into `nodes` (the surface they
 * produce) and the provenance maps, so a later call folds only new events.
 */
interface TierFold {
  processed: number
  readonly nodes: number[]
  readonly tierBySeq: Map<number, number>
  readonly shadowedBySeq: Map<number, readonly number[]>
  snapshot: TierSnapshot | undefined
}

const tierFolds = new WeakMap<Session, TierFold>()

// Producer-owned provenance lives in ../events.ts; re-exported here so the
// classification predicates and the name stay importable from one module.
export { PLUGIN_NAME, isNudgeSource, isRestoredSource } from '../events.ts'

/**
 * Classify one surface event's node kind.
 * @param session - owning session.
 * @param seq - surface seq of the event.
 * @returns the node kind.
 */
export function nodeKindOf(session: Session, seq: number): SurfaceNodeKind {
  const event = session.snapshotEvents()[seq]
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
 *
 * The provenance fold is incremental: the log is append-only, so each call
 * folds only the events appended since the previous one (a step costs
 * O(new events) instead of a full canonical re-fold of the whole log). It
 * reads only surface membership — appends and positional replacements —
 * so plugin-owned message projections (e.g. `image/offload`), which change
 * content but never membership, need no interpreter here; the session's
 * own surface stays the authority and the fold is checked against it.
 * @param session - session whose surface is folded.
 * @returns the snapshot for the current log.
 */
export function tierSnapshot(session: Session): TierSnapshot {
  let fold = tierFolds.get(session)
  if (fold === undefined || fold.processed > session.seq) {
    fold = { processed: 0, nodes: [], tierBySeq: new Map(), shadowedBySeq: new Map(), snapshot: undefined }
    tierFolds.set(session, fold)
  }
  if (fold.processed < session.seq) {
    const fresh = session.snapshotEvents(SessionLogOffset(fold.processed))
    let surfaceChanged = false
    for (const event of fresh) surfaceChanged = foldTierEvent(fold, event) || surfaceChanged
    fold.processed += fresh.length
    if (surfaceChanged) fold.snapshot = undefined
  }
  if (fold.snapshot !== undefined) return fold.snapshot

  const nodes = session.surface.nodes
  if (nodes.length !== fold.nodes.length || nodes.some((seq, index) => seq !== fold.nodes[index])) {
    // The log is append-only and the fold mirrors the canonical surface
    // operations, so this only fires on a corrupt or foreign log.
    throw new Error('tier snapshot: replacement provenance does not match the session surface')
  }
  const tierBySeq = new Map(fold.tierBySeq)
  const kindBySeq = new Map<number, SurfaceNodeKind>()
  for (const seq of nodes) {
    kindBySeq.set(seq, nodeKindOf(session, seq))
    if (!tierBySeq.has(seq)) tierBySeq.set(seq, 0)
  }
  fold.snapshot = {
    generation: session.surface.replaceGeneration,
    tierBySeq,
    kindBySeq,
    shadowedBySeq: new Map(fold.shadowedBySeq),
  }
  return fold.snapshot
}

/**
 * Fold one event's surface operation into the provenance state.
 * Replacements arrive in log order, so a checkpoint's shadowed tiers are
 * always resolved before the checkpoint that consumed them.
 * @returns whether the event changed surface membership.
 */
function foldTierEvent(fold: TierFold, event: SessionEvent): boolean {
  if (isAppendSurfaceEvent(event)) {
    fold.nodes.push(event.seq)
    return true
  }
  if (!isReplacementSurfaceEvent(event)) return false
  const { startSeq, endSeq } = event.surfaceOp
  const startIdx = fold.nodes.indexOf(startSeq)
  const endIdx = fold.nodes.indexOf(endSeq)
  if (startIdx === -1 || endIdx < startIdx) {
    throw new Error(`tier snapshot: replacement at seq ${event.seq} names a span outside the folded surface`)
  }
  const shadowedSeqs = fold.nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
  fold.shadowedBySeq.set(event.seq, shadowedSeqs)
  const isCheckpoint = event.type === 'user/message'
    && isCompactCheckpointSource(event.data.source)
  if (!isCheckpoint) {
    // Non-checkpoint replacements (restored transcripts, tool-result
    // rewrites) are raw surface content again: they must never inherit the
    // consumed checkpoint's tier.
    fold.tierBySeq.set(event.seq, 0)
    return true
  }
  let maxShadowed = 0
  for (const shadowedSeq of shadowedSeqs) {
    const tier = fold.tierBySeq.get(shadowedSeq) ?? 0
    if (tier > maxShadowed) maxShadowed = tier
  }
  fold.tierBySeq.set(event.seq, maxShadowed + 1)
  return true
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
