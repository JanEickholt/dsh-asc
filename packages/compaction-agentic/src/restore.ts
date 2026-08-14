/**
 * Decompression by replaying the log.
 *
 * A checkpoint's shadowed events remain in the session log forever, so
 * restoring compressed content costs zero stored state: resolve the target
 * checkpoint, expand its shadow chain (one tier by default, `full` to the
 * raw bottom), replay the leaf events into derived messages, serialize them,
 * and return the transcript for the tool result. The transcript therefore
 * lands in the `tool/result` event that immediately follows the assistant's
 * tool-call — an interleaved user message would violate the provider's
 * tool-call pairing contract — and the model sees the full restored content
 * in the next request, mirroring the upstream decompression semantics.
 *
 * @module @dsh-asc/compaction-agentic/restore
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { CompactionId } from '@deepseek-ai/dsh-compaction'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { Session } from '@deepseek-ai/dsh-session'
import type { DecompressTarget, ResolvedConfig } from './types.ts'
import { checkpointViews, eventForSeq } from './protected.ts'
import { tierSnapshot } from './tier.ts'
import { serializeMessages, textPreview } from './text.ts'

/** The plugin name used in nudge message sources. */
export const PLUGIN_NAME = 'dsh-asc'

const NUDGE_SOURCE = Object.freeze({ kind: 'plugin', plugin: PLUGIN_NAME, purpose: 'nudge' } as const)

/** Message provenance carried by an injected nudge. */
export type NudgeSource = typeof NUDGE_SOURCE

/**
 * Create nudge provenance for an injected guidance message.
 * @returns immutable nudge source.
 */
export function nudgeSource(): NudgeSource {
  return NUDGE_SOURCE
}

const OVERFLOW_NOTICE_SOURCE = Object.freeze({
  kind: 'plugin',
  plugin: PLUGIN_NAME,
  purpose: 'overflow-notice',
} as const)

/** Message provenance carried by an automatic-compaction notice. */
export type OverflowNoticeSource = typeof OVERFLOW_NOTICE_SOURCE

/**
 * Create provenance for the visible notice that follows an automatic
 * (fallback) compaction, so the model knows history was replaced without
 * its explicit choice.
 * @returns immutable notice source.
 */
export function overflowNoticeSource(): OverflowNoticeSource {
  return OVERFLOW_NOTICE_SOURCE
}

/** The preview length included in tool results. */
export const RESTORE_PREVIEW_CHARS = 500

/** One resolved decompression target. */
export interface RestoreTarget {
  readonly compactionId: CompactionId
  readonly tier: number
  readonly checkpointSeq: number
  readonly shadowedSeqs: readonly number[]
}

/**
 * Resolve decompression targets from the log by compaction ids, by a surface
 * position range, or by both (ids take precedence).
 * @param session - session owning the log.
 * @param compactionIds - exact checkpoint ids to restore.
 * @param range - optional surface span; every checkpoint whose shadowed span
 *   overlaps it is restored.
 * @returns resolved targets in surface order and unknown ids.
 */
export function resolveRestoreTargets(
  session: Session,
  compactionIds: readonly string[] | undefined,
  range: { startSeq: number; endSeq: number } | undefined,
): { targets: RestoreTarget[]; unknown: readonly string[] } {
  const views = checkpointViews(session)
  if (compactionIds !== undefined && compactionIds.length > 0) {
    const wanted = new Set(compactionIds)
    const targets: RestoreTarget[] = []
    const unknown: string[] = []
    const seen = new Set<string>()
    for (const view of views) {
      if (!wanted.has(view.compactionId)) continue
      if (seen.has(view.compactionId)) continue
      seen.add(view.compactionId)
      targets.push({
        compactionId: view.compactionId,
        tier: view.tier,
        checkpointSeq: view.seq,
        shadowedSeqs: view.shadowedSeqs,
      })
    }
    for (const id of compactionIds) {
      if (!seen.has(id)) unknown.push(id)
    }
    return { targets, unknown }
  }

  if (range !== undefined) {
    const nodes = session.surface.nodes
    const startIdx = nodes.indexOf(range.startSeq)
    const endIdx = nodes.indexOf(range.endSeq)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
      throw new Error(
        `range ${range.startSeq}..${range.endSeq} is not a valid surface span `
        + '(both seqs must be on the current surface, in order)',
      )
    }
    const targets: RestoreTarget[] = []
    for (const view of views) {
      const nodeIdx = nodes.indexOf(view.seq)
      const shadowedIdx = view.shadowedSeqs
        .map(seq => nodes.indexOf(seq))
        .filter(index => index !== -1)
      const minIdx = shadowedIdx.length === 0 ? nodeIdx : Math.min(nodeIdx, ...shadowedIdx)
      const maxIdx = shadowedIdx.length === 0 ? nodeIdx : Math.max(nodeIdx, ...shadowedIdx)
      if (minIdx <= endIdx && maxIdx >= startIdx) {
        targets.push({
          compactionId: view.compactionId,
          tier: view.tier,
          checkpointSeq: view.seq,
          shadowedSeqs: view.shadowedSeqs,
        })
      }
    }
    return { targets, unknown: [] }
  }

  throw new Error('decompress requires compactionIds or a startSeq/endSeq range')
}

/**
 * Expand a set of seqs to the leaf seqs to restore: one tier by default,
 * recursively to raw content with `full`. Classification reads the log
 * events directly (a shadowed checkpoint is no longer on the current
 * surface, so surface-indexed lookups would miss it).
 * @param session - session owning the log.
 * @param seqs - seqs to expand.
 * @param full - whether to expand checkpoints recursively.
 * @returns the leaf seqs in surface order.
 */
export function expandRestoreSeqs(
  session: Session,
  seqs: readonly number[],
  full: boolean,
): number[] {
  const tiers = tierSnapshot(session)
  const leaves: number[] = []
  const visit = (seq: number): void => {
    const event = session.events[seq]
    const isCheckpoint = event?.type === 'user/message'
      && isCompactCheckpointSource(event.data.source)
    if (isCheckpoint && full) {
      // Checkpoints may be off-surface (shadowed by a later tier); the
      // replacement provenance map covers every replacement in the log.
      const shadowed = tiers.shadowedBySeq.get(seq) ?? []
      if (shadowed.length === 0) {
        leaves.push(seq)
        return
      }
      for (const child of shadowed) visit(child)
      return
    }
    leaves.push(seq)
  }
  for (const seq of seqs) visit(seq)
  return leaves
}

/**
 * Build the restored transcript for one target.
 * @param session - session owning the log.
 * @param target - resolved target.
 * @param full - whether to expand to raw content.
 * @param meter - token meter pricing the restored messages.
 * @returns the leaf seqs, transcript text, and its estimated token price.
 */
export function buildRestoredContent(
  session: Session,
  target: RestoreTarget,
  full: boolean,
  meter: TokenMeter,
): { restoredSeqs: number[]; text: string; tokens: number; chars: number } {
  const leaves = expandRestoreSeqs(session, target.shadowedSeqs, full)
  const events = session.events
  const messages: Message[] = []
  let tokens = 0
  for (const seq of leaves) {
    const message = session.deriveEventMessage(eventForSeq(events, seq))
    if (message === null) continue
    messages.push(message)
    tokens += meter.estimateMessage(message)
  }
  const text = serializeMessages(messages)
  return { restoredSeqs: leaves, text, tokens, chars: Array.from(text).length }
}

/**
 * Restore a list of targets under the configured budget. The restored
 * transcript is returned for the tool result; no log-only audit event is
 * written because this harness release has no registration surface for
 * out-of-tree event types (the persistence layer refuses unknown types).
 * The transcript itself is durable in the `tool/result` event.
 * @param session - session owning the log.
 * @param targets - resolved targets in restore order.
 * @param full - whether to expand to raw content.
 * @param meter - token meter pricing restored messages.
 * @param config - resolved budget policy.
 * @returns the restored targets (with full content) and skipped ids.
 */
export function restoreTargets(
  session: Session,
  targets: readonly RestoreTarget[],
  full: boolean,
  meter: TokenMeter,
  config: ResolvedConfig,
): { restored: DecompressTarget[]; skipped: string[] } {
  const restored: DecompressTarget[] = []
  const skipped: string[] = []
  let budgetUsed = 0
  for (const target of targets) {
    const { restoredSeqs, text, tokens, chars } = buildRestoredContent(session, target, full, meter)
    if (budgetUsed + tokens > config.decompress.maxTokens) {
      skipped.push(
        `${target.compactionId} (${tokens} tokens; combined ${budgetUsed + tokens} exceeds `
        + `the ${config.decompress.maxTokens}-token restore budget)`,
      )
      continue
    }
    budgetUsed += tokens
    restored.push({
      compactionId: target.compactionId,
      tier: target.tier,
      checkpointSeq: target.checkpointSeq,
      restoredSeqs,
      restoredTokens: tokens,
      restoredChars: chars,
      preview: textPreview(text, RESTORE_PREVIEW_CHARS),
      content: text,
    })
  }
  return { restored, skipped }
}
