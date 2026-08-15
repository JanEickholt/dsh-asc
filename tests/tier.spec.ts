import { describe, expect, it } from 'vitest'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import {
  commitSurfaceCompaction,
  frameSummary,
} from '../src/engine/region.ts'
import { tierSnapshot, tierTokenUsage, nodeKindOf } from '../src/engine/tier.ts'
import { checkpointViews, validateSurfaceRange } from '../src/policy/protected.ts'
import { createContext, conversationSession, eventOf, MODEL } from './helpers.ts'

const M = (text: string): import('@deepseek-ai/dsh-llm').Message =>
  createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: MODEL, model: MODEL } })

describe('tierSnapshot', () => {
  it('classifies raw nodes as tier 0', () => {
    const session = conversationSession(2)
    const snapshot = tierSnapshot(session)
    for (const seq of session.surface.nodes) {
      expect(snapshot.tierBySeq.get(seq)).toBe(0)
    }
  })

  it('derives tier 1 for a checkpoint over raw nodes and tier 2 over checkpoints', async () => {
    const ctx = createContext()
    const session = conversationSession(4)
    const nodes = session.surface.nodes
    const mid = nodes[Math.floor(nodes.length / 2)]!
    const selection = validateSurfaceRange(session, nodes[0]!, mid)
    const first = await commitSurfaceCompaction(
      { meter: ctx.tokenMeter },
      session,
      selection.start,
      selection.end,
      {
        kind: 'model',
        summary: 'consolidated decisions and file paths from the first half, preserved verbatim identifiers, next steps',
        provider: MODEL,
        model: MODEL,
      },
      { owner: 'current-turn', stability: 'whole-surface' },
    )
    expect(first.tier).toBe(1)
    expect(first.author).toBe('model')

    const afterFirst = tierSnapshot(session)
    const checkpointSeq = session.surface.nodes.find(seq => afterFirst.kindBySeq.get(seq) === 'checkpoint')!
    expect(afterFirst.tierBySeq.get(checkpointSeq)).toBe(1)
    expect(nodeKindOf(session, checkpointSeq)).toBe('checkpoint')

    // Consume the tier-1 checkpoint plus following raw nodes: the new
    // checkpoint derives tier 2.
    const nodes2 = session.surface.nodes
    const second = await commitSurfaceCompaction(
      { meter: ctx.tokenMeter },
      session,
      nodes2[0]!,
      nodes2[1]!,
      {
        kind: 'model',
        summary: 'further distilled decisions, facts, and open questions kept as bullet facts',
        provider: MODEL,
        model: MODEL,
      },
      { owner: 'current-turn', stability: 'whole-surface' },
    )
    expect(second.tier).toBe(2)
  })

  it('keeps decompressed and nudge nodes at tier 0', () => {
    const session = conversationSession(2)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[context-management] guidance' }],
      source: { kind: 'plugin', plugin: 'dsh-asc', purpose: 'nudge' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'restored transcript' }],
      source: { kind: 'plugin', plugin: 'dsh-asc', op: 'decompress', compactionId: CompactionId('x'), tier: 1, full: false },
    }), { surfaceOp: 'append' })
    const snapshot = tierSnapshot(session)
    const nodes = session.surface.nodes
    expect(nodeKindOf(session, nodes.at(-2)!)).toBe('nudge')
    expect(nodeKindOf(session, nodes.at(-1)!)).toBe('restored')
    expect(snapshot.tierBySeq.get(nodes.at(-2)!)).toBe(0)
    expect(snapshot.tierBySeq.get(nodes.at(-1)!)).toBe(0)
  })

  it('returns restored replacement transcripts to tier 0, not checkpoint tier + 1', async () => {
    const ctx = createContext()
    const session = conversationSession(4)
    const nodes = session.surface.nodes
    const selection = validateSurfaceRange(session, nodes[0]!, nodes[Math.floor(nodes.length / 2)]!)
    const compacted = await commitSurfaceCompaction(
      { meter: ctx.tokenMeter },
      session,
      selection.start,
      selection.end,
      {
        kind: 'model',
        summary: 'consolidated checkpoint preserving file paths, decisions, and next steps',
        provider: MODEL,
        model: MODEL,
      },
      { owner: 'current-turn', stability: 'whole-surface' },
    )
    const checkpointSeq = checkpointViews(session)[0]!.seq
    const restored = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'the original transcript is back' }],
      source: { kind: 'plugin', plugin: 'dsh-asc', op: 'decompress', compactionId: compacted.compactionId },
    }), {
      surfaceOp: { op: 'replace', start: checkpointSeq, end: checkpointSeq },
      sourceEventSeqs: [checkpointSeq, ...compacted.shadowedSeqs],
    })
    const snapshot = tierSnapshot(session)
    expect(snapshot.tierBySeq.get(restored.seq)).toBe(0)
    expect(nodeKindOf(session, restored.seq)).toBe('restored')
  })

  it('rebuilds the tier snapshot after plain surface appends', () => {
    const session = conversationSession(2)
    void tierSnapshot(session)
    const appended = session.append('assistant/message', {
      turn: 2,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'a newly appended assistant node' }],
        source: { provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    const fresh = tierSnapshot(session)
    expect(fresh.kindBySeq.get(appended.seq)).toBe('assistant')
    expect(fresh.tierBySeq.get(appended.seq)).toBe(0)
  })
})

describe('tierTokenUsage', () => {
  it('sums surface tokens per tier', async () => {
    const ctx = createContext()
    const session = conversationSession(4)
    const nodes = session.surface.nodes
    const selection = validateSurfaceRange(session, nodes[0]!, nodes[Math.floor(nodes.length / 2)]!)
    await commitSurfaceCompaction(
      { meter: ctx.tokenMeter },
      session,
      selection.start,
      selection.end,
      {
        kind: 'model',
        summary: 'a consolidated checkpoint that keeps the essential file paths and decisions from the first half',
        provider: MODEL,
        model: MODEL,
      },
      { owner: 'current-turn', stability: 'whole-surface' },
    )
    const usage = tierTokenUsage(session, ctx.tokenMeter.measure(session))
    expect(usage.get(1) ?? 0).toBeGreaterThan(0)
    expect(usage.get(0) ?? 0).toBeGreaterThan(0)
  })
})

describe('checkpointViews', () => {
  it('lists checkpoints with compaction ids and shadowed seqs', async () => {
    const ctx = createContext()
    const session = conversationSession(4)
    const nodes = session.surface.nodes
    const selection = validateSurfaceRange(session, nodes[0]!, nodes[Math.floor(nodes.length / 2)]!)
    const result = await commitSurfaceCompaction(
      { meter: ctx.tokenMeter },
      session,
      selection.start,
      selection.end,
      {
        kind: 'model',
        summary: 'checkpoint summary that retains file paths, decisions, and the pending next step in full detail',
        provider: MODEL,
        model: MODEL,
      },
      { owner: 'current-turn', stability: 'whole-surface' },
    )
    const views = checkpointViews(session)
    expect(views).toHaveLength(1)
    expect(views[0]!.compactionId).toBe(result.compactionId)
    expect(views[0]!.shadowedSeqs).toEqual(result.shadowedSeqs)
    expect(views[0]!.tier).toBe(1)
  })
})

describe('frameSummary', () => {
  it('wraps blocks in the durable checkpoint framing', () => {
    const framed = frameSummary([{ type: 'text', text: 'body' }])
    expect(framed[0]!.type).toBe('text')
    expect((framed[0] as { text: string }).text).toContain('<compacted-summary>')
    expect((framed.at(-1) as { text: string }).text).toBe('</compacted-summary>')
  })

  it('embeds the compaction id so a visible checkpoint can be expanded directly', () => {
    const framed = frameSummary([{ type: 'text', text: 'body' }], CompactionId('cp-direct'))
    expect((framed[0] as { text: string }).text).toContain('Compaction id: cp-direct')
  })
})

void M
void eventOf
