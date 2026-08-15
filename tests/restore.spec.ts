import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  commitSurfaceCompaction,
  type CommitResult,
} from '../src/engine/region.ts'
import {
  expandRestoreSeqs,
  resolveRestoreTargets,
  restoreTargets,
  buildRestoredContent,
} from '../src/engine/restore.ts'
import { validateSurfaceRange } from '../src/policy/protected.ts'
import { resolveConfig } from '../src/config.ts'
import { createContext, conversationSession, MODEL } from './helpers.ts'

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
    const session = conversationSession(4)
    const nodes = session.surface.nodes
    expect(() => resolveRestoreTargets(session, undefined, {
      startSeq: nodes[nodes.length - 1]!,
      endSeq: nodes[0]!,
    })).toThrow(/not a valid surface span/)
  })

  it('rejects using compaction ids and a range together', async () => {
    const ctx = createContext()
    const session = conversationSession(4)
    const result = await commitT1(session, ctx.tokenMeter)
    const nodes = session.surface.nodes
    expect(() => resolveRestoreTargets(session, [result.compactionId], {
      startSeq: nodes[0]!,
      endSeq: nodes[1]!,
    })).toThrow(/mutually exclusive/)
  })

  it('reports duplicated unknown ids once', () => {
    const session = conversationSession(4)
    const { unknown } = resolveRestoreTargets(session, ['missing', 'missing'], undefined)
    expect(unknown).toEqual(['missing'])
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
  it('restores IN PLACE: replaces the checkpoint node with the transcript', async () => {
    const ctx = createContext()
    const session = conversationSession(4)
    const result = await commitT1(session, ctx.tokenMeter)
    const config = resolveConfig({})
    const { targets } = resolveRestoreTargets(session, [result.compactionId], undefined)
    const checkpointSeq = targets[0]!.checkpointSeq
    expect(session.surface.nodes).toContain(checkpointSeq)
    const { restored, skipped } = restoreTargets(session, targets, false, ctx.tokenMeter, config)
    expect(skipped).toEqual([])
    expect(restored).toHaveLength(1)
    expect(restored[0]!.compactionId).toBe(result.compactionId)
    expect(restored[0]!.restoredTokens).toBeGreaterThan(0)
    // Statistics only: no inline content in the result.
    expect(restored[0]!.content).toBe('')
    expect(restored[0]!.preview.length).toBeGreaterThan(0)
    // The checkpoint node is gone from the surface — replaced in place by
    // the restored transcript, which carries the restored source marker.
    expect(session.surface.nodes).not.toContain(checkpointSeq)
    const restoredSeq = session.surface.nodes.find(seq => {
      const event = session.events[seq]
      return event?.type === 'user/message'
        && (event.data.source as { op?: string }).op === 'decompress'
    })
    expect(restoredSeq).toBeDefined()
    const restoredEvent = session.events[restoredSeq!]
    const text = (restoredEvent as { data: { content: Array<{ text: string }> } }).data.content
      .map(block => block.text).join('')
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
    // The budget prices the exact message that will be appended, not the sum
    // of the original leaf messages.
    expect(content.tokens).toBe(ctx.tokenMeter.estimateMessage(content.message))
    expect(ctx.tokenMeter.estimateMessage(content.message)).toBe(
      ctx.tokenMeter.estimateMessage(createUserMessage({
        content: [{ type: 'text', text: content.text }],
        source: { kind: 'plugin', plugin: 'dsh-asc' },
      })),
    )
  })
})
