/**
 * Session-log usage scanner: derive a `UsageReport` from committed events.
 *
 * Pure fold over `session.snapshotEvents()` — no mutation, no side state, no
 * LLM calls. Every number is reproducible by replaying the log.
 *
 * @module dsh-asc/analytics/scan
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type {
  CheckpointUsage,
  DecompressOutcomeKind,
  DecompressUsage,
  ToolCallUsage,
  UsageReport,
} from './types.ts'
import { tierSnapshot } from '../engine/tier.ts'
import { PLUGIN_SOURCE_KIND } from '../events.ts'

/** The six `context_*` tools the scanner tracks. */
const CONTEXT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'context_compress',
  'context_decompress',
  'context_recap',
  'context_retrieve',
  'context_search',
  'context_status',
])

/** Summary text blocks carry the topic label under this prefix. */
const TOPIC_PREFIX = '## Topic: '

/** Payload of one `compaction/summary` event, narrowed through its event type. */
interface SummaryEventData {
  readonly compactionId: string
  readonly summary: readonly ContentBlock[]
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
  readonly llmStreamCall?: true
}

/** Text of one text block, or undefined for non-text blocks. */
function textOf(block: ContentBlock): string | undefined {
  return block.type === 'text' ? block.text : undefined
}

/** Extract the topic label from a summary's text blocks (first match wins). */
function topicOf(summary: readonly ContentBlock[]): string | undefined {
  for (const block of summary) {
    const text = textOf(block)
    if (text !== undefined && text.startsWith(TOPIC_PREFIX)) {
      return text.slice(TOPIC_PREFIX.length).trim()
    }
  }
  return undefined
}

/** Parse a JSON object from a string, or undefined when not an object. */
function parseJsonObject(json: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(json) as unknown
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

/** String-array field of a parsed JSON object. */
function stringArrayOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

/** Parse the compaction ids a decompress/recap call named in its arguments JSON. */
function requestedIdsOf(argumentsJson: string): readonly string[] {
  const args = parseJsonObject(argumentsJson)
  if (args === undefined) return []
  const ids = args.compactionIds !== undefined ? args.compactionIds : args.content
  return stringArrayOf(ids)
}

/** Concatenate one message's content blocks as text (the transport renderers use). */
function joinedText(message: ToolResultMessage): string {
  return message.content
    .map(block => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join('\n')
}

/**
 * Restored entries of a decompress result payload: compaction id → the file
 * path the entry went to (`toFile` marks every entry with a path).
 */
function restoredEntriesOf(json: Record<string, unknown> | undefined): ReadonlyMap<string, string | undefined> {
  const entries = new Map<string, string | undefined>()
  if (!Array.isArray(json?.restored)) return entries
  for (const entry of json.restored) {
    if (entry === null || typeof entry !== 'object') continue
    const id = (entry as { compactionId?: unknown }).compactionId
    if (typeof id !== 'string') continue
    const path = (entry as { path?: unknown }).path
    entries.set(id, typeof path === 'string' ? path : undefined)
  }
  return entries
}

/** Mutable counter carrier folded into each checkpoint during the scan. */
interface CheckpointAccumulator extends CheckpointUsage {
  decompressCount: number
  recapCount: number
}

/** One tool/call event pending its matching tool/result. */
interface PendingDecompressCall {
  readonly callSeq: number
  readonly turn: number
  readonly requestedIds: readonly string[]
}

/** Whether a user message is this plugin's restored-transcript marker. */
function restoredCheckpointId(source: { kind: string; op?: string; compactionId?: unknown }): string | undefined {
  if (source.kind === PLUGIN_SOURCE_KIND && source.op === 'decompress'
    && typeof source.compactionId === 'string') {
    return source.compactionId
  }
  return undefined
}

/**
 * Scan one session's committed events into a `UsageReport`.
 *
 * The report is a derived observation over the durable log: the same events
 * always produce the same report. Checkpoints appear oldest fold first;
 * decompress/recap counters attribute each invocation to the checkpoints its
 * restored or requested ids name.
 * @param session - session whose full event log is scanned.
 * @returns the usage report for the scanned prefix.
 */
export function scanSessionUsage(session: Session): UsageReport {
  const events = session.snapshotEvents()
  const tiers = tierSnapshot(session)

  const checkpoints: CheckpointAccumulator[] = []
  const byId = new Map<string, CheckpointAccumulator>()
  const toolCalls: ToolCallUsage[] = []
  const decompressCalls: DecompressUsage[] = []
  // callId → pending decompress call awaiting its tool/result. Events are
  // scanned in seq order, so a result always follows its call.
  const pending = new Map<string, PendingDecompressCall>()
  let lastFoldSeq: number | undefined
  let scannedToSeq = 0

  for (const event of events) {
    scannedToSeq = Math.max(scannedToSeq, event.seq + 1)
    switch (event.type) {
      case 'compaction/summary': {
        const data = event.data as unknown as SummaryEventData
        const topic = topicOf(data.summary)
        const entry: CheckpointAccumulator = {
          compactionId: data.compactionId,
          summarySeq: event.seq,
          tier: tiers.tierBySeq.get(event.seq + 1) ?? 1,
          shadowedCount: data.shadowedSeqs.length,
          shadowedTokens: data.shadowedTokenCount,
          author: data.llmStreamCall === true ? 'fallback' : 'model',
          decompressCount: 0,
          recapCount: 0,
          ...topic === undefined ? {} : { topic },
        }
        checkpoints.push(entry)
        byId.set(data.compactionId, entry)
        lastFoldSeq = event.seq
        break
      }
      case 'tool/call': {
        if (!CONTEXT_TOOL_NAMES.has(event.data.name)) break
        toolCalls.push({ name: event.data.name, callSeq: event.seq, turn: event.data.turn })
        if (event.data.name === 'context_decompress') {
          pending.set(event.data.callId, {
            callSeq: event.seq,
            turn: event.data.turn,
            requestedIds: requestedIdsOf(event.data.arguments),
          })
        }
        if (event.data.name === 'context_recap') {
          for (const id of requestedIdsOf(event.data.arguments)) {
            const cp = byId.get(id)
            if (cp !== undefined) cp.recapCount += 1
          }
        }
        break
      }
      case 'tool/result': {
        const waiting = pending.get(event.data.message.toolCallId)
        if (waiting === undefined) break
        pending.delete(event.data.message.toolCallId)
        const json = parseJsonObject(joinedText(event.data.message))
        const restored = restoredEntriesOf(json)
        const restoredIds = [...restored.keys()]
        const skippedIds = stringArrayOf(json?.skipped)
        const failed = event.data.message.isError === true || event.data.error !== undefined
        const outcome: DecompressOutcomeKind = failed
          ? 'failed'
          : restoredIds.length > 0 && [...restored.values()].every(path => path !== undefined)
            ? 'to-file'
            : restoredIds.length > 0
              ? 'restored'
              : 'skipped'
        decompressCalls.push({
          name: 'context_decompress',
          callSeq: waiting.callSeq,
          turn: waiting.turn,
          requestedIds: waiting.requestedIds,
          restoredIds,
          skippedIds,
          outcome,
        })
        for (const id of restoredIds) {
          const cp = byId.get(id)
          if (cp !== undefined) cp.decompressCount += 1
        }
        break
      }
      case 'user/message': {
        // An in-place restore commits a replacement user message carrying
        // the checkpoint's id; it marks the checkpoint decompressed too.
        const id = restoredCheckpointId(event.data.source as { kind: string; op?: string; compactionId?: unknown })
        const cp = id === undefined ? undefined : byId.get(id)
        if (cp !== undefined) cp.decompressCount += 1
        break
      }
      default:
        break
    }
  }

  return {
    sessionId: session.id,
    scannedToSeq,
    toolCalls,
    decompressCalls,
    checkpoints,
    ...lastFoldSeq === undefined ? {} : { lastFoldSeq },
  }
}
