import { describe, expect, it } from 'vitest'
import SessionStore, { Session } from '@deepseek-ai/dsh-session'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AgenticCompactionEngine } from '../src/engine/engine.ts'
import { resolveConfig } from '../src/config.ts'
import { validateSurfaceRange } from '../src/policy/protected.ts'
import { scanSessionUsage } from '../src/analytics/scan.ts'
import {
  appendContextToolPair,
  agentOf,
  closedSession,
  conversationSession,
  createContext,
} from './helpers.ts'
import { PLUGIN_SOURCE_KIND, restoredSource } from '../src/events.ts'

const SUMMARY = 'consolidated checkpoint preserving file paths, decisions, commands, and the pending next step in full detail'

/** A working engine over a fresh session, mirroring tests/engine.spec.ts. */
function engineWith(): { engine: AgenticCompactionEngine; session: Session } {
  const ctx = createContext(100_000, 'fallback summary that keeps essential file paths and decisions')
  void new SessionStore(ctx)
  const engine = new AgenticCompactionEngine(ctx, {
    protection: { retainRecentMessages: 0, protectFirstUserMessage: false },
    qualityGate: { enabled: false },
  } as Parameters<typeof resolveConfig>[0])
  ctx.provide('tools', {
    register: (): (() => void) => (): void => { /* recorded only */ },
  } as never)
  return { engine, session: conversationSession(4) }
}

/** Commit one model fold over the first half of the surface. */
async function foldFirstHalf(
  engine: AgenticCompactionEngine,
  session: Session,
  topic?: string,
): Promise<string> {
  const agent = agentOf(session)
  const nodes = [...session.surface.nodes]
  const selection = validateSurfaceRange(session, nodes[0]!, nodes[Math.floor(nodes.length / 2)]!)
  const result = await engine.compressByModel(agent, [{
    startSeq: selection.start,
    endSeq: selection.end,
    summary: SUMMARY,
    ...topic === undefined ? {} : { topic },
  }])
  expect(result.failures).toEqual([])
  return result.compressed[0]!.compactionId
}

describe('scanSessionUsage', () => {
  it('returns an empty report for a session with no context activity', () => {
    const session = conversationSession(2)
    const report = scanSessionUsage(session)
    expect(report.sessionId).toBe(session.id)
    expect(report.toolCalls).toEqual([])
    expect(report.decompressCalls).toEqual([])
    expect(report.checkpoints).toEqual([])
    expect(report.lastFoldSeq).toBeUndefined()
    expect(report.scannedToSeq).toBe(session.seq)
  })

  it('records a model fold with topic, tier, shadowed metrics, and lastFoldSeq', async () => {
    const { engine, session } = engineWith()
    const id = await foldFirstHalf(engine, session, 'auth decisions')
    const report = scanSessionUsage(session)
    expect(report.checkpoints).toHaveLength(1)
    const checkpoint = report.checkpoints[0]!
    expect(checkpoint.compactionId).toBe(id)
    expect(checkpoint.author).toBe('model')
    expect(checkpoint.topic).toBe('auth decisions')
    expect(checkpoint.tier).toBe(1)
    expect(checkpoint.shadowedCount).toBeGreaterThan(0)
    expect(checkpoint.shadowedTokens).toBeGreaterThan(0)
    expect(checkpoint.decompressCount).toBe(0)
    expect(checkpoint.recapCount).toBe(0)
    expect(report.lastFoldSeq).toBe(checkpoint.summarySeq)
  })

  it('attributes a later decompress to the checkpoint and increments decompressCount', async () => {
    const { engine, session } = engineWith()
    const id = await foldFirstHalf(engine, session)
    const agent = agentOf(session)
    await engine.decompressByModel(agent, { compactionIds: [id] })
    const report = scanSessionUsage(session)
    expect(report.checkpoints[0]!.decompressCount).toBe(1)
    // The in-place restore commits a restored user message, no tool pair.
    expect(report.toolCalls).toEqual([])
    expect(report.decompressCalls).toEqual([])
  })

  it('parses a decompress tool pair and classifies its outcome as restored', async () => {
    const { engine, session } = engineWith()
    const id = await foldFirstHalf(engine, session)
    const callSeq = appendContextToolPair(session, 'context_decompress',
      JSON.stringify({ compactionIds: [id] }),
      { content: [JSON.stringify({ restored: [{ compactionId: id }], skipped: [] })] })
    const report = scanSessionUsage(session)
    expect(report.toolCalls).toEqual([
      { name: 'context_decompress', callSeq, turn: 5 },
    ])
    expect(report.decompressCalls).toEqual([{
      name: 'context_decompress',
      callSeq,
      turn: 5,
      requestedIds: [id],
      restoredIds: [id],
      skippedIds: [],
      outcome: 'restored',
    }])
    expect(report.checkpoints[0]!.decompressCount).toBe(1)
  })

  it('classifies a to-file decompress result as to-file outcome', async () => {
    const { engine, session } = engineWith()
    const id = await foldFirstHalf(engine, session)
    appendContextToolPair(session, 'context_decompress',
      JSON.stringify({ compactionIds: [id], toFile: 'out.txt' }),
      { content: [JSON.stringify({
        restored: [{ compactionId: id, path: 'out.txt' }],
        skipped: [],
      })] })
    const report = scanSessionUsage(session)
    expect(report.decompressCalls[0]!.outcome).toBe('to-file')
    expect(report.decompressCalls[0]!.restoredIds).toEqual([id])
    expect(report.checkpoints[0]!.decompressCount).toBe(1)
  })

  it('classifies a skipped decompress result as skipped outcome', async () => {
    const { engine, session } = engineWith()
    const id = await foldFirstHalf(engine, session)
    appendContextToolPair(session, 'context_decompress',
      JSON.stringify({ compactionIds: [id] }),
      { content: [JSON.stringify({ restored: [], skipped: [`${id} (no restorable message content)`] })] })
    const report = scanSessionUsage(session)
    expect(report.decompressCalls[0]!.outcome).toBe('skipped')
    expect(report.decompressCalls[0]!.skippedIds).toEqual([`${id} (no restorable message content)`])
    expect(report.checkpoints[0]!.decompressCount).toBe(0)
  })

  it('classifies an errored decompress result as failed outcome', async () => {
    const { engine, session } = engineWith()
    const id = await foldFirstHalf(engine, session)
    appendContextToolPair(session, 'context_decompress',
      JSON.stringify({ compactionIds: [id] }),
      { isError: true, content: ['boom'] })
    const report = scanSessionUsage(session)
    expect(report.decompressCalls[0]!.outcome).toBe('failed')
    expect(report.decompressCalls[0]!.restoredIds).toEqual([])
    expect(report.checkpoints[0]!.decompressCount).toBe(0)
  })

  it('records a decompress call whose result never arrives', async () => {
    const { engine, session } = engineWith()
    const id = await foldFirstHalf(engine, session)
    const before = session.seq
    session.append('tool/call', {
      turn: 5,
      step: 1,
      callId: 'call-orphan' as never,
      name: 'context_decompress',
      arguments: JSON.stringify({ compactionIds: [id] }),
    })
    const report = scanSessionUsage(session)
    expect(report.toolCalls).toEqual([{ name: 'context_decompress', callSeq: before, turn: 5 }])
    // No result: no DecompressUsage entry, no counter movement.
    expect(report.decompressCalls).toEqual([])
    expect(report.checkpoints[0]!.decompressCount).toBe(0)
  })

  it('attributes a recap to the named checkpoints', async () => {
    const { engine, session } = engineWith()
    const id = await foldFirstHalf(engine, session)
    appendContextToolPair(session, 'context_recap', JSON.stringify({ compactionIds: [id] }))
    const report = scanSessionUsage(session)
    expect(report.toolCalls).toEqual([
      { name: 'context_recap', callSeq: report.toolCalls[0]!.callSeq, turn: 5 },
    ])
    expect(report.checkpoints[0]!.recapCount).toBe(1)
  })

  it('attributes a fallback-authored fold as fallback author', () => {
    const session = conversationSession(1)
    const summarySeq = session.seq
    session.append('compaction/summary', {
      compactionId: 'c-fallback',
      summary: [{ type: 'text', text: '## Topic: recovery' }, { type: 'text', text: SUMMARY }],
      shadowedSeqs: [1, 2],
      shadowedTokenCount: 42,
      provider: 'p',
      model: 'm',
      rawOutput: [{ type: 'text', text: 'raw' }],
      llmStreamCall: true,
    } as never)
    const report = scanSessionUsage(session)
    expect(report.checkpoints).toEqual([{
      compactionId: 'c-fallback',
      summarySeq,
      tier: 1,
      topic: 'recovery',
      shadowedCount: 2,
      shadowedTokens: 42,
      author: 'fallback',
      decompressCount: 0,
      recapCount: 0,
    }])
    expect(report.lastFoldSeq).toBe(summarySeq)
  })

  it('counts multiple checkpoints oldest-first with per-checkpoint counters', async () => {
    const { engine, session } = engineWith()
    const first = await foldFirstHalf(engine, session, 'first fold')
    // A second fold consumes the first checkpoint's replacement: tier 2.
    const second = await foldFirstHalf(engine, session, 'second fold')
    const report = scanSessionUsage(session)
    expect(report.checkpoints).toHaveLength(2)
    const [cp1, cp2] = report.checkpoints
    expect(cp1!.compactionId).toBe(first)
    expect(cp1!.author).toBe('model')
    expect(cp1!.decompressCount).toBe(0)
    expect(cp2!.compactionId).toBe(second)
    expect(cp2!.tier).toBe(2)
    expect(report.lastFoldSeq).toBe(cp2!.summarySeq)
    // A decompress of the second checkpoint only moves its counter.
    appendContextToolPair(session, 'context_decompress',
      JSON.stringify({ compactionIds: [second] }),
      { content: [JSON.stringify({ restored: [{ compactionId: second }], skipped: [] })] })
    const updated = scanSessionUsage(session)
    expect(updated.checkpoints[0]!.decompressCount).toBe(0)
    expect(updated.checkpoints[1]!.decompressCount).toBe(1)
  })

  it('parses the array-only transport argument shape as requestedIds', async () => {
    const { engine, session } = engineWith()
    const id = await foldFirstHalf(engine, session)
    appendContextToolPair(session, 'context_decompress',
      JSON.stringify({ content: [id] }),
      { content: [JSON.stringify({ restored: [{ compactionId: id }], skipped: [] })] })
    const report = scanSessionUsage(session)
    expect(report.decompressCalls[0]!.requestedIds).toEqual([id])
    expect(report.decompressCalls[0]!.restoredIds).toEqual([id])
  })

  it('accepts malformed arguments and non-JSON results without counting', async () => {
    const { engine, session } = engineWith()
    await foldFirstHalf(engine, session)
    appendContextToolPair(session, 'context_decompress', 'not json', { content: ['restored: yes'] })
    appendContextToolPair(session, 'context_status', 'not json')
    const report = scanSessionUsage(session)
    expect(report.toolCalls).toHaveLength(2)
    expect(report.decompressCalls).toEqual([{
      name: 'context_decompress',
      callSeq: report.decompressCalls[0]!.callSeq,
      turn: 5,
      requestedIds: [],
      restoredIds: [],
      skippedIds: [],
      outcome: 'skipped',
    }])
  })

  it('ignores tool calls for tools outside the context vocabulary', () => {
    const session = conversationSession(1)
    appendContextToolPair(session, 'read_file', '{}')
    const report = scanSessionUsage(session)
    expect(report.toolCalls).toEqual([])
  })

  it('never mutates the session or its event log', async () => {
    const { engine, session } = engineWith()
    const id = await foldFirstHalf(engine, session)
    appendContextToolPair(session, 'context_recap', JSON.stringify({ compactionIds: [id] }))
    const eventsBefore = session.snapshotEvents().length
    const seqBefore = session.seq
    const first = scanSessionUsage(session)
    const second = scanSessionUsage(session)
    expect(second).toEqual(first)
    expect(session.snapshotEvents().length).toBe(eventsBefore)
    expect(session.seq).toBe(seqBefore)
  })
})
