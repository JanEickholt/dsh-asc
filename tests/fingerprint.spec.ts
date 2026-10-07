import { describe, expect, it } from 'vitest'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { Session, SessionId, snapshotSessionEvent, type SessionEvent } from '@deepseek-ai/dsh-session'
import { commitSurfaceCompaction, foldFingerprint } from '../src/engine/region.ts'
import { resolveRestoreTargets } from '../src/engine/restore.ts'
import { validateSurfaceRange } from '../src/policy/protected.ts'
import { createContext, conversationSession, eventOf, MODEL } from './helpers.ts'

const SUMMARY = 'consolidated checkpoint preserving file paths, decisions, commands, and the pending next step'

function modelSource(): import('../src/engine/region.ts').SummarySource {
  return { kind: 'model', summary: SUMMARY, provider: MODEL, model: MODEL }
}

/** Commit the head of `session` and return the durable result. */
async function commitHead(
  meter: import('@deepseek-ai/dsh-token-meter').TokenMeter,
  session: Session,
  count = 2,
): Promise<import('../src/engine/region.ts').CommitResult> {
  const nodes = session.surface.nodes
  const selection = validateSurfaceRange(session, nodes[0]!, nodes[Math.min(count, nodes.length - 1)]!)
  return commitSurfaceCompaction(
    { meter },
    session,
    selection.start,
    selection.end,
    modelSource(),
    { owner: 'current-turn', stability: 'whole-surface' },
  )
}

/** The persisted checkpoint source of one committed bracket. */
function checkpointSource(session: Session, result: { summarySeq: number }): Record<string, unknown> {
  const replacement = eventOf(session.snapshotEvents(), result.summarySeq + 1, 'user/message')
  return replacement.data.source as unknown as Record<string, unknown>
}

describe('fold fingerprint', () => {
  it('persists the fingerprint on the checkpoint message source', async () => {
    const ctx = createContext()
    const session = conversationSession(4)
    const result = await commitHead(ctx.tokenMeter, session)
    const source = checkpointSource(session, result)
    expect(isCompactCheckpointSource(source as never)).toBe(true)
    expect(source.fingerprint).toMatch(/^[0-9a-f]{24}$/)
  })

  it('is deterministic across identical compactions in fresh sessions', async () => {
    const ctx = createContext()
    const first = conversationSession(4)
    const second = conversationSession(4)
    const firstResult = await commitHead(ctx.tokenMeter, first)
    const secondResult = await commitHead(ctx.tokenMeter, second)
    const firstPrint = checkpointSource(first, firstResult).fingerprint
    const secondPrint = checkpointSource(second, secondResult).fingerprint
    // Different compaction ids (random per fold), identical fold content.
    expect(firstResult.compactionId).not.toBe(secondResult.compactionId)
    expect(firstPrint).toBe(secondPrint)
  })

  it('is unchanged when the same conversation is re-keyed', async () => {
    const ctx = createContext()
    const session = conversationSession(4)
    const result = await commitHead(ctx.tokenMeter, session)
    const original = checkpointSource(session, result).fingerprint
    // Re-key: detach the same event prefix and replay it under a different
    // session id, the path a resume or fork takes.
    const rekeyed = Session.create(
      SessionId('re-keyed'),
      session.snapshotEvents().map(
        (event) => JSON.parse(JSON.stringify(snapshotSessionEvent(event))) as SessionEvent,
      ),
    )
    const checkpoint = rekeyed.deriveMessages()
      .find((message) => isCompactCheckpointSource(message.source))
    expect(checkpoint).toBeDefined()
    expect((checkpoint!.source as Record<string, unknown>).fingerprint).toBe(original)
    // The fingerprint recomputes identically from the re-keyed session's own
    // shadowed events: identity survives the storage round trip.
    expect(foldFingerprint(rekeyed, result.shadowedSeqs)).toBe(original)
  })

  it('restores old-format logs without a fingerprint field identically', async () => {
    const ctx = createContext()
    const session = conversationSession(4)
    const result = await commitHead(ctx.tokenMeter, session)
    // Old format: strip the fingerprint field, as logs written before the
    // field existed look on disk.
    const events = session.snapshotEvents().map(
      (event) => JSON.parse(JSON.stringify(snapshotSessionEvent(event))) as SessionEvent,
    )
    for (const event of events) {
      if (event.type === 'user/message' && isCompactCheckpointSource(event.data.source)) {
        const source = event.data.source as Record<string, unknown>
        delete source.fingerprint
      }
    }
    const legacy = Session.create(SessionId('legacy'), events)
    // Restore and recap resolve the same fold purely from the durable
    // payload fields — the absent fingerprint is not consulted anywhere.
    const { targets, unknown } = resolveRestoreTargets(legacy, [result.compactionId], undefined)
    expect(unknown).toEqual([])
    expect(targets).toHaveLength(1)
    expect(targets[0]!.shadowedSeqs).toEqual(result.shadowedSeqs)
    const checkpoint = legacy.deriveMessages()
      .find((message) => isCompactCheckpointSource(message.source))
    expect(checkpoint).toBeDefined()
    expect((checkpoint!.source as Record<string, unknown>).fingerprint).toBeUndefined()
  })
})
