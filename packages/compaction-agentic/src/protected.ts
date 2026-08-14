/**
 * Protected-node policy.
 *
 * A compression range must never shadow protected content: human prompts
 * (when configured), the first user message, recent working context, the
 * calls/results of protected tools, or injected content from protected
 * plugin sources.
 *
 * The `context_compress`/`context_decompress` tool calls themselves are NOT
 * force-protected: the summaries and audit trail live in log-only
 * `compaction/*` events that never enter the surface, so consuming the
 * surface call records loses nothing — the audit stays in the session file,
 * exactly like any other compression target. (This differs from ACP, where
 * the summary lives inside the compress call itself and the call must be
 * preserved; here the durable record is the event, not the call.)
 *
 * @module @dsh-asc/compaction-agentic/protected
 */

import {
  CompactionId,
  isCompactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig } from './types.ts'
import { nodeKindOf, tierSnapshot } from './tier.ts'

/** Tool-call blocks inside one assistant message. */
export interface ToolCallFacts {
  readonly callId: string
  readonly name: string
}

/** Extract tool-call facts from an assistant message's content blocks. */
export function toolCallsOf(blocks: readonly ContentBlock[]): ToolCallFacts[] {
  const calls: ToolCallFacts[] = []
  for (const block of blocks) {
    if (block.type === 'tool-call') {
      calls.push({ callId: block.id, name: block.name })
    }
  }
  return calls
}

/** CallId → tool name for every current surface node. */
export interface ToolNameIndex {
  /** callId → tool name. */
  readonly byCallId: ReadonlyMap<string, string>
  /** Surface seq of the assistant node holding each call. */
  readonly callSeqByCallId: ReadonlyMap<string, number>
}

interface ToolNameCacheEntry {
  readonly generation: number
  readonly index: ToolNameIndex
}

const toolNameCache = new WeakMap<Session, ToolNameCacheEntry>()

/**
 * Build or fetch the callId → tool-name index for the current surface.
 * @param session - session whose surface nodes are indexed.
 * @returns the index for the current surface generation.
 */
export function toolNameIndex(session: Session): ToolNameIndex {
  const generation = session.surface.replaceGeneration
  const cached = toolNameCache.get(session)
  if (cached !== undefined && cached.generation === generation) return cached.index
  const byCallId = new Map<string, string>()
  const callSeqByCallId = new Map<string, number>()
  for (const seq of session.surface.nodes) {
    const event = session.events[seq]
    if (event?.type !== 'assistant/message') continue
    for (const call of toolCallsOf(event.data.message.content)) {
      byCallId.set(call.callId, call.name)
      callSeqByCallId.set(call.callId, seq)
    }
  }
  const index: ToolNameIndex = { byCallId, callSeqByCallId }
  toolNameCache.set(session, { generation, index })
  return index
}

/** Protected-tool name set from configuration (no force-protected tools). */
export function protectedToolSet(config: ResolvedConfig): Set<string> {
  return new Set(config.protection.protectedTools)
}

/** Whether one surface node is protected from compression. */
export function isProtectedNode(
  session: Session,
  seq: number,
  config: ResolvedConfig,
): boolean {
  const event = session.events[seq]
  if (event === undefined) return true
  const kind = nodeKindOf(session, seq)
  if (kind === 'nudge') return false
  if (kind === 'restored') return false
  if (kind === 'checkpoint') return false
  switch (event.type) {
    case 'user/message': {
      const source = event.data.source as { kind: string; plugin?: string }
      if (source.kind === 'user') {
        if (config.protection.protectUserMessages) return true
        if (config.protection.protectFirstUserMessage && seq === firstUserMessageSeq(session)) {
          return true
        }
        return false
      }
      if (source.kind === 'plugin') {
        return config.protection.protectedSources.includes(source.plugin ?? '')
      }
      return false
    }
    case 'assistant/message': {
      const tools = protectedToolSet(config)
      if (tools.size === 0) return false
      return toolCallsOf(event.data.message.content).some(call => tools.has(call.name))
    }
    case 'tool/result': {
      const source = event.data.message.source as { kind: string; callId?: string }
      if (source.kind !== 'tool' || source.callId === undefined) return false
      const name = toolNameIndex(session).byCallId.get(source.callId)
      return name !== undefined && protectedToolSet(config).has(name)
    }
    default:
      return false
  }
}

/** Seq of the first human user message on the surface, if any. */
export function firstUserMessageSeq(session: Session): number | undefined {
  for (const seq of session.surface.nodes) {
    const event = session.events[seq]
    if (event?.type === 'user/message'
      && (event.data.source as { kind: string }).kind === 'user') {
      return seq
    }
  }
  return undefined
}

/** One validated surface range. */
export interface ValidatedRange {
  readonly start: number
  readonly end: number
  readonly startIdx: number
  readonly endIdx: number
  readonly shadowedSeqs: readonly number[]
}

/** Validate one inclusive surface-position span without committing anything. */
export function validateSurfaceRange(session: Session, start: number, end: number): ValidatedRange {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  if (startIdx === -1) throw new Error(`start seq ${start} is not on the current surface`)
  if (endIdx === -1) throw new Error(`end seq ${end} is not on the current surface`)
  if (startIdx > endIdx) {
    throw new Error(`start seq ${start} is after end seq ${end} on the surface`)
  }
  if (!toolPairingBalancedBefore(session, nodes[startIdx]!)) {
    throw new Error(`start seq ${start} is not a balanced boundary (would split a tool-call/result pair)`)
  }
  if (!toolPairingBalancedAfter(session, nodes[endIdx]!)) {
    throw new Error(`end seq ${end} is not a balanced boundary (would split a tool-call/result pair)`)
  }
  return { start, end, startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) }
}

/**
 * Extend an unbalanced inclusive span to the nearest balanced boundaries:
 * the minimal complete tool turns containing the requested nodes.
 *
 * A tool-call/result pair can never be split by a compression, and a
 * complete tool turn (the assistant message carrying the calls plus every
 * paired result) is the smallest unit that keeps both edges balanced. The
 * start edge walks forward from the requested span's leading cut to the
 * nearest balanced cut; the end edge walks backward from its trailing cut.
 * Nothing outside the minimal enclosing turns is added.
 *
 * @param session - session owning the surface.
 * @param start - first requested surface seq, inclusive.
 * @param end - last requested surface seq, inclusive.
 * @returns the minimal balanced span, or `null` when no balanced span
 *   encloses the request (e.g. the request already spans the whole surface).
 */
export function nearestBalancedRange(
  session: Session,
  start: number,
  end: number,
): { start: number; end: number } | null {
  const nodes = session.surface.nodes
  let startIdx = nodes.indexOf(start)
  let endIdx = nodes.indexOf(end)
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return null

  // Walk outward until both edges sit on balanced cuts. Each step moves one
  // cut, so an unbalanced assistant node pulls in its results (or the reverse).
  while (!toolPairingBalancedBefore(session, nodes[startIdx]!)) {
    if (startIdx === 0) return null
    startIdx -= 1
  }
  while (!toolPairingBalancedAfter(session, nodes[endIdx]!)) {
    if (endIdx === nodes.length - 1) return null
    endIdx += 1
  }
  // A forward walk can expose a new unbalanced leading cut (the expanded
  // start may sit after an assistant whose results now fall inside the span);
  // re-validate the closed form before returning.
  if (!toolPairingBalancedBefore(session, nodes[startIdx]!)) return null
  if (!toolPairingBalancedAfter(session, nodes[endIdx]!)) return null
  return { start: nodes[startIdx]!, end: nodes[endIdx]! }
}

/** Why a range is not eligible; undefined means eligible. */
export type RangeIneligibility =
  | { reason: 'empty' }
  | { reason: 'protected'; seq: number }
  | { reason: 'recent-tail'; position: number }
  | { reason: 'max-tier'; seq: number; tier: number }

/**
 * Check whether a validated range may be compressed under the protection
 * policy. The range must contain no protected node, must not reach into the
 * retained recent tail, and must not consume a checkpoint at the tier cap.
 * @param session - session owning the range.
 * @param range - validated range (edges balanced, on surface).
 * @param config - resolved protection and tier policy.
 * @returns undefined when eligible, otherwise the ineligibility reason.
 */
export function rangeIneligibility(
  session: Session,
  range: ValidatedRange,
  config: ResolvedConfig,
): RangeIneligibility | undefined {
  if (range.shadowedSeqs.length === 0) return { reason: 'empty' }
  const nodes = session.surface.nodes
  const tailBoundary = nodes.length - config.protection.retainRecentMessages
  if (range.endIdx >= tailBoundary) {
    return { reason: 'recent-tail', position: range.endIdx }
  }
  const tiers = tierSnapshot(session)
  for (const seq of range.shadowedSeqs) {
    if (isProtectedNode(session, seq, config)) return { reason: 'protected', seq }
    const tier = tiers.tierBySeq.get(seq) ?? 0
    if (tier >= config.tiers.maxTier) return { reason: 'max-tier', seq, tier }
  }
  return undefined
}

/** Resolve one surface event for a seq, failing on corrupt membership. */
export function eventForSeq(events: readonly SessionEvent[], seq: number): SessionEvent {
  const event = events[seq]
  if (event === undefined || event.seq !== seq) {
    throw new Error(`surface seq ${seq} has no matching session event (corrupt surface)`)
  }
  return event
}

/** All current checkpoint nodes in surface order with their shadowed seqs. */
export function checkpointViews(session: Session): Array<{
  seq: number
  compactionId: CompactionId
  tier: number
  shadowedSeqs: readonly number[]
}> {
  const tiers = tierSnapshot(session)
  const views: Array<{
    seq: number
    compactionId: CompactionId
    tier: number
    shadowedSeqs: readonly number[]
  }> = []
  for (const seq of session.surface.nodes) {
    if (tiers.kindBySeq.get(seq) !== 'checkpoint') continue
    const event = session.events[seq]
    if (event?.type !== 'user/message') continue
    const source = event.data.source as MessageSource & { compactionId?: string }
    if (source.compactionId === undefined || !isCompactCheckpointSource(source)) continue
    views.push({
      seq,
      compactionId: CompactionId(source.compactionId),
      tier: tiers.tierBySeq.get(seq) ?? 0,
      shadowedSeqs: tiers.shadowedBySeq.get(seq) ?? [],
    })
  }
  return views
}
