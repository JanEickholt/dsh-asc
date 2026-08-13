import { describe, expect, it } from 'vitest'
import { CallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { ManualCompactionError, isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import {
  commitSurfaceCompaction,
  selectCompactableRange,
  SummaryNotSmallerError,
} from '../src/region.ts'
import { validateSurfaceRange, rangeIneligibility } from '../src/protected.ts'
import { resolveConfig } from '../src/config.ts'
import { createContext, conversationSession, closedSession, eventOf, MODEL } from './helpers.ts'

const SUMMARY = 'consolidated checkpoint preserving file paths, decisions, commands, and the pending next step'

function modelSource(): import('../src/region.ts').SummarySource {
  return { kind: 'model', summary: SUMMARY, provider: MODEL, model: MODEL }
}

describe('commitSurfaceCompaction', () => {
  it('commits the full durable bracket with correct adjacency', async () => {
    const ctx = createContext()
    const session = conversationSession(4)
    const nodes = session.surface.nodes
    const selection = validateSurfaceRange(session, nodes[0]!, nodes[Math.floor(nodes.length / 2)]!)
    const result = await commitSurfaceCompaction(
      { meter: ctx.tokenMeter },
      session,
      selection.start,
      selection.end,
      modelSource(),
      { owner: 'current-turn', stability: 'whole-surface' },
    )

    expect(result.startSeq).toBeLessThan(result.summarySeq)
    expect(result.summarySeq).toBeLessThan(result.endSeq)
    expect(result.shadowedSeqs).toEqual(selection.shadowedSeqs)
    expect(result.shadowedTokenCount).toBeGreaterThan(0)
    expect(result.summaryTokenCount).toBeLessThan(result.shadowedTokenCount)

    const events = session.events
    const start = eventOf(events, result.startSeq, 'compaction/start')
    const summary = eventOf(events, result.summarySeq, 'compaction/summary')
    const end = eventOf(events, result.endSeq, 'compaction/end')
    expect(start.data.compactionId).toBe(result.compactionId)
    expect(summary.data.compactionId).toBe(result.compactionId)
    expect(summary.data.shadowedSeqs).toEqual(selection.shadowedSeqs)
    expect(summary.data.shadowedTokenCount).toBe(result.shadowedTokenCount)
    expect(end.data.compactionId).toBe(result.compactionId)

    // The replacement is the user message directly after the summary event
    // (shadow-price adjacency) and before the authorship record and end.
    const replacement = eventOf(events, result.summarySeq + 1, 'user/message')
    expect(isCompactCheckpointSource(replacement.data.source)).toBe(true)
    expect(replacement.data.source).toMatchObject({ compactionId: result.compactionId })
    expect(replacement.surfaceOp).toEqual({ op: 'replace', start: selection.start, end: selection.end })
    expect(replacement.sourceEventSeqs).toEqual([
      result.startSeq,
      result.summarySeq,
      ...selection.shadowedSeqs,
    ])
    const compressRecord = eventOf(events, result.summarySeq + 2, 'context/compress')
    expect(compressRecord.data.compactionId).toBe(result.compactionId)
    expect(compressRecord.data.author).toBe('model')
    expect(compressRecord.data.tier).toBe(1)

    // The surface now carries the checkpoint node instead of the range.
    expect(session.surface.nodes).not.toContain(selection.start)
    expect(session.surface.nodes).toContain(replacement.seq)
    expect(session.surface.replaceGeneration).toBeGreaterThan(0)
  })

  it('rejects a summary that is not smaller than the shadowed content', async () => {
    const ctx = createContext()
    const session = conversationSession(2)
    const nodes = session.surface.nodes
    const selection = validateSurfaceRange(session, nodes[0]!, nodes[0]!)
    const giant = 'word '.repeat(4000)
    await expect(commitSurfaceCompaction(
      { meter: ctx.tokenMeter },
      session,
      selection.start,
      selection.end,
      { kind: 'model', summary: giant, provider: MODEL, model: MODEL },
      { owner: 'current-turn', stability: 'whole-surface' },
    )).rejects.toThrow(SummaryNotSmallerError)
    // The failed attempt closed its bracket with an error record.
    const events = session.events
    expect(events.at(-1)!.type).toBe('compaction/end')
    expect((events.at(-1)! as { data: { error?: string } }).data.error).toBeDefined()
  })

  it('rejects ranges that split tool-call/result pairs', async () => {
    const ctx = createContext()
    const session = conversationSession(1)
    // Build one step with a tool call and result.
    const callId = CallId('call-1')
    session.append('step/start', { turn: 1, step: 2 })
    session.append('assistant/message', {
      turn: 1,
      step: 2,
      message: createAssistantMessage({
        content: [{
          type: 'tool-call',
          id: callId,
          name: 'read_file',
          arguments: '{"path":"/tmp/a"}',
        }],
        source: { provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/result', {
      turn: 1,
      step: 2,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'file body' }] }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 2 })

    const nodes = session.surface.nodes
    // nodes = [u1, a1, a2(tool-call), tr1]: cutting after the tool-call
    // assistant message splits the open call/result pair.
    await expect(commitSurfaceCompaction(
      { meter: ctx.tokenMeter },
      session,
      nodes[1]!,
      nodes[2]!,
      modelSource(),
      { owner: 'current-turn', stability: 'whole-surface' },
    )).rejects.toThrow(/balanced boundary/)
  })

  it('enforces the durable lock against concurrent compaction', async () => {
    const ctx = createContext()
    const session = conversationSession(4)
    const nodes = session.surface.nodes
    // Leave an unmatched opening marker.
    const compactionId = 'lock-test' as unknown as import('@deepseek-ai/dsh-compaction').CompactionId
    session.append('compaction/start', { compactionId, turn: null })
    await expect(commitSurfaceCompaction(
      { meter: ctx.tokenMeter },
      session,
      nodes[0]!,
      nodes[1]!,
      modelSource(),
      { owner: 'current-turn', stability: 'whole-surface' },
    )).rejects.toThrow(ManualCompactionError)
  })

  it('classifies manual failures and cancels cleanly', async () => {
    const ctx = createContext()
    const session = closedSession(3)
    const nodes = session.surface.nodes
    const controller = new AbortController()
    controller.abort()
    await expect(commitSurfaceCompaction(
      { meter: ctx.tokenMeter },
      session,
      nodes[0]!,
      nodes[1]!,
      modelSource(),
      { owner: null, stability: 'whole-surface' },
      controller.signal,
    )).rejects.toThrow()
    // Nothing was appended for the aborted request.
    expect(session.events.at(-1)!.type).not.toBe('compaction/start')
  })

  it('rejects standalone compaction while a turn is open', async () => {
    const ctx = createContext()
    const session = conversationSession(4)
    const nodes = session.surface.nodes
    await expect(commitSurfaceCompaction(
      { meter: ctx.tokenMeter },
      session,
      nodes[0]!,
      nodes[1]!,
      modelSource(),
      { owner: null, stability: 'whole-surface' },
    )).rejects.toThrow(/already has an open turn/)
  })

  it('rejects in-turn compaction without an open turn', async () => {
    const ctx = createContext()
    const session = closedSession(3)
    const nodes = session.surface.nodes
    await expect(commitSurfaceCompaction(
      { meter: ctx.tokenMeter },
      session,
      nodes[0]!,
      nodes[1]!,
      modelSource(),
      { owner: 'current-turn', stability: 'whole-surface' },
    )).rejects.toThrow(/must be enclosed in a turn/)
  })

  it('writes the quality record when provided', async () => {
    const ctx = createContext()
    const session = conversationSession(4)
    const nodes = session.surface.nodes
    const result = await commitSurfaceCompaction(
      { meter: ctx.tokenMeter },
      session,
      nodes[0]!,
      nodes[1]!,
      {
        kind: 'model',
        summary: SUMMARY,
        provider: MODEL,
        model: MODEL,
        quality: { gate: 'rouge-recall-v1', passed: true, blocking: true, layer: 'pass' },
      },
      { owner: 'current-turn', stability: 'whole-surface' },
    )
    const record = eventOf(session.events, result.summarySeq + 2, 'context/compress')
    expect(record.data.quality).toMatchObject({ passed: true })
  })
})

describe('selectCompactableRange', () => {
  it('selects a head range within the retention budget', () => {
    const session = conversationSession(5)
    const ctx = createContext()
    const measurement = ctx.tokenMeter.measure(session)
    const range = selectCompactableRange(session, measurement, 0)
    expect(range).not.toBeNull()
    const nodes = session.surface.nodes
    expect(nodes).toContain(range!.start)
    expect(nodes).toContain(range!.end)
  })

  it('returns null for an empty surface', () => {
    const ctx = createContext()
    const session = conversationSession(0)
    expect(selectCompactableRange(session, ctx.tokenMeter.measure(session), 0)).toBeNull()
  })

  it('skips leading protected seqs and selects from the first safe node', () => {
    const session = conversationSession(5)
    const ctx = createContext()
    const nodes = session.surface.nodes
    const range = selectCompactableRange(session, ctx.tokenMeter.measure(session), 0, new Set([nodes[0]!]))
    expect(range).not.toBeNull()
    expect(range!.start).toBe(nodes[1]!)
    expect(nodes.indexOf(range!.start)).toBe(1)
  })
})

describe('rangeIneligibility', () => {
  it('rejects ranges reaching the retained recent tail', () => {
    const session = conversationSession(5)
    const config = resolveConfig({})
    const nodes = session.surface.nodes
    const selection = validateSurfaceRange(session, nodes[0]!, nodes[nodes.length - 1]!)
    const ineligibility = rangeIneligibility(session, selection, config)
    expect(ineligibility?.reason).toBe('recent-tail')
  })

  it('rejects ranges including protected user messages when configured', () => {
    const session = conversationSession(5)
    const config = resolveConfig({
      protection: { protectUserMessages: true, retainRecentMessages: 0 },
    })
    const nodes = session.surface.nodes
    const selection = validateSurfaceRange(session, nodes[0]!, nodes[1]!)
    const ineligibility = rangeIneligibility(session, selection, config)
    expect(ineligibility?.reason).toBe('protected')
  })
})
