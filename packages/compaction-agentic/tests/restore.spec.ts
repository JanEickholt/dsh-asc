import { describe, expect, it } from 'vitest'
import {
  commitSurfaceCompaction,
  type CommitResult,
} from '../src/region.ts'
import {
  expandRestoreSeqs,
  resolveRestoreTargets,
  restoreTargets,
  buildRestoredContent,
} from '../src/restore.ts'
import { validateSurfaceRange } from '../src/protected.ts'
import { resolveConfig } from '../src/config.ts'
import { createContext, conversationSession, eventOf, MODEL } from './helpers.ts'

const SUMMARY = 'checkpoint that keeps file paths, decisions, and the pending next step in full detail'

function commitT1(
  session: import('@deepseek-ai/dsh-session').Session,
  meter: import('@deepseek-ai/dsh-token-meter').TokenMeter,
  count = 2,
): Promise<CommitResult> {
  const nodes = session.surface.nodes
  const end = nodes[Math.min(count, nodes.length - 1)]!
  const selection = validateSurfaceRange(session, nodes[0]!, end)
  return commitSurfaceCompaction(
    { meter },
    session,
    selection.start,
    selection.end,
    { kind: 'model', summary: SUMMARY, provider: MODEL, model: MODEL },
    { owner: 'current-turn', stability: 'whole-surface' },
  )
}

describe('resolveRestoreTargets', () => {
  it('resolves by compaction id and reports unknown ids', async () => {
    const ctx = createContext()
    const session = conversationSession(4)
    const result = await commitT1(session, ctx.tokenMeter)
    const { targets, unknown } = resolveRestoreTargets(session, [result.compactionId, 'missing-id'], undefined)
    expect(targets).toHaveLength(1)
    expect(targets[0]!.compactionId).toBe(result.compactionId)
    expect(targets[0]!.shadowedSeqs).toEqual(result.shadowedSeqs)
    expect(unknown).toEqual(['missing-id'])
  })

  it('resolves by overlapping surface range', async () => {
    const ctx = createContext()
    const session = conversationSession(4)
    const result = await commitT1(session, ctx.tokenMeter)
    const nodes = session.surface.nodes
    const checkpointIdx = nodes.findIndex(seq => session.events[seq]?.type === 'user/message')
    const { targets } = resolveRestoreTargets(session, undefined, {
      startSeq: nodes[checkpointIdx]!,
      endSeq: nodes[nodes.length - 1]!,
    })
    expect(targets.some(target => target.compactionId === result.compactionId)).toBe(true)
  })

  it('rejects an invalid range', () => {
    const ctx = createContext()
    const session = conversationSession(4)
    const nodes = session.surface.nodes
    expect(() => resolveRestoreTargets(session, undefined, {
      startSeq: nodes[nodes.length - 1]!,
      endSeq: nodes[0]!,
    })).toThrow(/not a valid surface span/)
  })

  it('requires a targeting mode', () => {
    const session = conversationSession(4)
    expect(() => resolveRestoreTargets(session, undefined, undefined)).toThrow(/requires/)
  })
})

describe('expandRestoreSeqs', () => {
  it('restores one tier up by default and all the way with full', async () => {
    const ctx = createContext()
    const session = conversationSession(6)
    await commitT1(session, ctx.tokenMeter, 2)
    const nodes = session.surface.nodes
    const second = await commitSurfaceCompaction(
      { meter: ctx.tokenMeter },
      session,
      nodes[0]!,
      nodes[1]!,
      { kind: 'model', summary: `${SUMMARY} distilled into bare facts`, provider: MODEL, model: MODEL },
      { owner: 'current-turn', stability: 'whole-surface' },
    )
    expect(second.tier).toBe(2)
    const { targets } = resolveRestoreTargets(session, [second.compactionId], undefined)
    // Default: reveal the tier-1 checkpoint, not raw content.
    const leaves = expandRestoreSeqs(session, targets[0]!.shadowedSeqs, false)
    expect(leaves).toEqual([...second.shadowedSeqs])
    // full: expand the tier-1 checkpoint to its raw leaves.
    const fullLeaves = expandRestoreSeqs(session, targets[0]!.shadowedSeqs, true)
    expect(fullLeaves.length).toBeGreaterThan(leaves.length)
    expect(fullLeaves).not.toEqual(leaves)
  })
})

describe('buildRestoredContent and restoreTargets', () => {
  it('replays the shadowed transcript and commits a durable restore', async () => {
    const ctx = createContext()
    const session = conversationSession(4)
    const result = await commitT1(session, ctx.tokenMeter)
    const config = resolveConfig({})
    const { targets } = resolveRestoreTargets(session, [result.compactionId], undefined)
    const { restored, skipped } = restoreTargets(session, targets, false, ctx.tokenMeter, config)
    expect(skipped).toEqual([])
    expect(restored).toHaveLength(1)
    expect(restored[0]!.compactionId).toBe(result.compactionId)
    expect(restored[0]!.restoredTokens).toBeGreaterThan(0)
    expect(restored[0]!.preview.length).toBeGreaterThan(0)

    const record = eventOf(session.events, session.events.length - 2, 'context/decompress')
    const message = eventOf(session.events, session.events.length - 1, 'user/message')
    expect(record.data.compactionId).toBe(result.compactionId)
    expect(record.data.restoredSeqs).toEqual(restored[0]!.restoredSeqs)
    const source = message.data.source as { op?: string; compactionId?: string }
    expect(source.op).toBe('decompress')
    expect(source.compactionId).toBe(result.compactionId)
    expect(message.surfaceOp).toBe('append')
    // The restored content contains the original user prompt text.
    const text = message.data.content
      .filter(block => block.type === 'text')
      .map(block => (block as { text: string }).text)
      .join('')
    expect(text).toContain('user 1')
  })

  it('skips targets over the restore budget', async () => {
    const ctx = createContext()
    const session = conversationSession(6)
    const result = await commitT1(session, ctx.tokenMeter, 4)
    const config = resolveConfig({ decompress: { maxTokens: 1 } })
    const { targets } = resolveRestoreTargets(session, [result.compactionId], undefined)
    const { restored, skipped } = restoreTargets(session, targets, false, ctx.tokenMeter, config)
    expect(restored).toEqual([])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toContain('exceeds')
  })

  it('builds content with estimated tokens', async () => {
    const ctx = createContext()
    const session = conversationSession(4)
    const result = await commitT1(session, ctx.tokenMeter)
    const { targets } = resolveRestoreTargets(session, [result.compactionId], undefined)
    const content = buildRestoredContent(session, targets[0]!, false, ctx.tokenMeter)
    expect(content.text.length).toBeGreaterThan(0)
    expect(content.tokens).toBeGreaterThan(0)
    expect(content.chars).toBe(Array.from(content.text).length)
  })
})
