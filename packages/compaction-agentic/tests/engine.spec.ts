import { describe, expect, it } from 'vitest'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session } from '@deepseek-ai/dsh-session'
import { AgenticCompactionEngine, CompressRejectedError } from '../src/engine.ts'
import { registerContextTools } from '../src/tools.ts'
import { resolveConfig } from '../src/config.ts'
import { validateSurfaceRange, rangeIneligibility, checkpointViews } from '../src/protected.ts'
import { createContext, conversationSession, closedSession, agentOf, eventOf, MODEL } from './helpers.ts'

const SUMMARY = 'consolidated checkpoint preserving file paths, decisions, commands, and the pending next step in full detail'
/** Short enough to be strictly smaller than any shadowed tool result. */
const TURN_SUMMARY = 'tool results preserved'

/** A recording tools-registry stub; engine tests exercise the engine, not the tool pipeline. */
function stubTools(ctx: ReturnType<typeof createContext>): string[] {
  const registered: string[] = []
  const disposers: Array<() => void> = []
  ctx.provide('tools', {
    register: (tool: { name: string }) => {
      registered.push(tool.name)
      const dispose = (): void => { /* recorded only */ }
      disposers.push(dispose)
      return dispose
    },
  } as never)
  return registered
}

function engineWith(config: Parameters<typeof resolveConfig>[0] = {}): {
  ctx: ReturnType<typeof createContext>
  engine: AgenticCompactionEngine
} {
  const ctx = createContext(100_000, 'fallback summary that keeps essential file paths and decisions')
  void new SessionStore(ctx)
  const engine = new AgenticCompactionEngine(ctx, {
    // Small test sessions: disable the recent-tail fence, first-prompt
    // protection, and the quality gate so ranges commit; each policy has
    // dedicated tests.
    protection: { retainRecentMessages: 0, protectFirstUserMessage: false },
    qualityGate: { enabled: false },
    ...config,
  })
  stubTools(ctx)
  registerContextTools(ctx, engine)
  return { ctx, engine }
}

describe('AgenticCompactionEngine.compressByModel', () => {
  it('commits model-written summaries through the durable transaction', async () => {
    const { engine } = engineWith()
    const session = conversationSession(4)
    const agent = agentOf(session)
    const nodes = [...session.surface.nodes]
    const selection = validateSurfaceRange(session, nodes[0]!, nodes[Math.floor(nodes.length / 2)]!)
    const result = await engine.compressByModel(agent, [{
      startSeq: selection.start,
      endSeq: selection.end,
      summary: SUMMARY,
    }])
    expect(result.failures).toEqual([])
    expect(result.compressed).toHaveLength(1)
    const outcome = result.compressed[0]!
    expect(outcome.tier).toBe(1)
    expect(outcome.author).toBe('model')
    expect(outcome.compactionId.length).toBeGreaterThan(0)
    expect(outcome.summaryTokenCount).toBeLessThan(outcome.shadowedTokenCount)
    // The model-visible surface now derives the checkpoint.
    const messages = session.deriveMessages()
    expect(messages.some(message => message.content.some(block => block.type === 'text'
      && (block as { text: string }).text.includes(SUMMARY)))).toBe(true)
  })

  it('reports per-entry failures without committing invalid ranges', async () => {
    const { engine } = engineWith()
    const session = conversationSession(4)
    const agent = agentOf(session)
    const nodes = [...session.surface.nodes]
    const result = await engine.compressByModel(agent, [
      { startSeq: 9999, endSeq: 9998, summary: SUMMARY },
      { startSeq: nodes[0]!, endSeq: nodes[0]!, summary: '' },
    ])
    expect(result.compressed).toEqual([])
    expect(result.failures).toHaveLength(2)
    expect(result.failures[0]!.reason).toContain('not on the current surface')
    expect(result.failures[1]!.reason).toContain('non-empty')
  })

  it('rejects ranges that include protected or recent-tail content', async () => {
    const { engine } = engineWith({ protection: { retainRecentMessages: 2 } })
    const session = conversationSession(4)
    const agent = agentOf(session)
    const nodes = [...session.surface.nodes]
    // The whole surface reaches into the retained recent tail.
    const result = await engine.compressByModel(agent, [{
      startSeq: nodes[0]!,
      endSeq: nodes[nodes.length - 1]!,
      summary: TURN_SUMMARY,
    }])
    expect(result.compressed).toEqual([])
    expect(result.failures[0]!.reason).toContain('recent tail')
  })

  it('blocks on the quality gate and requires acknowledgeRisk to retry', async () => {
    const { engine } = engineWith({ qualityGate: { enabled: true } })
    // acknowledgeRisk without a prior rejection is an error.
    const fresh = conversationSession(4)
    const freshAgent = agentOf(fresh)
    const freshNodes = fresh.surface.nodes
    await expect(engine.compressByModel(freshAgent, [
      { startSeq: freshNodes[0]!, endSeq: freshNodes[1]!, summary: 'x' },
    ], { acknowledgeRisk: true })).rejects.toThrow(/no quality-gate rejection is pending/)

    // The gate blocks the plan...
    const session = conversationSession(4)
    const agent = agentOf(session)
    const nodes = [...session.surface.nodes]
    const selection = validateSurfaceRange(session, nodes[0]!, nodes[Math.floor(nodes.length / 2)]!)
    const ranges = [{ startSeq: selection.start, endSeq: selection.end, summary: 'x' }]
    await expect(engine.compressByModel(agent, ranges)).rejects.toThrow(CompressRejectedError)
    // ...and the exact-range retry with acknowledgeRisk bypasses it.
    const retried = await engine.compressByModel(agent, ranges, { acknowledgeRisk: true })
    expect(retried.compressed).toHaveLength(1)
  })

  it('records non-blocking gate outcomes without rejecting', async () => {
    const { engine } = engineWith({ qualityGate: { blocking: false } })
    const session = conversationSession(4)
    const agent = agentOf(session)
    const nodes = [...session.surface.nodes]
    const selection = validateSurfaceRange(session, nodes[0]!, nodes[Math.floor(nodes.length / 2)]!)
    const result = await engine.compressByModel(agent, [{
      startSeq: selection.start,
      endSeq: selection.end,
      summary: 'x',
    }])
    expect(result.compressed).toHaveLength(1)
    expect(result.compressed[0]!.quality?.passed).toBe(false)
  })

  it('rejects a summary that is not smaller than the shadowed content', async () => {
    const { engine } = engineWith({ qualityGate: { enabled: false } })
    const session = conversationSession(2)
    const agent = agentOf(session)
    const nodes = [...session.surface.nodes]
    const result = await engine.compressByModel(agent, [{
      startSeq: nodes[0]!,
      endSeq: nodes[0]!,
      summary: 'gigantic '.repeat(2000),
    }])
    expect(result.compressed).toEqual([])
    expect(result.failures[0]!.reason).toContain('not smaller')
  })

  it('derives tier 2 when consuming a tier-1 checkpoint', async () => {
    const { engine } = engineWith()
    const session = conversationSession(6)
    const agent = agentOf(session)
    const nodes = [...session.surface.nodes]
    const first = await engine.compressByModel(agent, [{
      startSeq: nodes[0]!,
      endSeq: nodes[1]!,
      summary: TURN_SUMMARY,
    }])
    expect(first.compressed[0]!.tier).toBe(1)
    const firstCheckpointSeq = checkpointViews(session)[0]!.seq
    const after = session.surface.nodes
    const second = await engine.compressByModel(agent, [{
      startSeq: after[0]!,
      endSeq: after[1]!,
      summary: `${SUMMARY} distilled into bare facts`,
    }])
    expect(second.compressed[0]!.tier).toBe(2)
    expect(second.compressed[0]!.shadowedSeqs).toContain(firstCheckpointSeq)
  })
})

describe('AgenticCompactionEngine auto tool-pair expansion', () => {
  it('extends a lone tool/result request to the minimal complete tool turn', async () => {
    const { engine } = engineWith()
    const session = toolTurnSession()
    const agent = agentOf(session)
    // The assistant message carrying the tool call precedes the result.
    const nodes = [...session.surface.nodes]
    const callNodeIdx = nodes.findLastIndex(seq => session.events[seq]?.type === 'assistant/message')
    const resultNodeIdx = nodes.findLastIndex(seq => session.events[seq]?.type === 'tool/result')
    expect(callNodeIdx).toBeGreaterThanOrEqual(0)
    expect(resultNodeIdx).toBeGreaterThan(callNodeIdx)
    // Request ONLY the tool result: the balanced span must pull in the call.
    const result = await engine.compressByModel(agent, [{
      startSeq: nodes[resultNodeIdx]!,
      endSeq: nodes[resultNodeIdx]!,
      summary: TURN_SUMMARY,
    }])
    expect(result.failures).toEqual([])
    const outcome = result.compressed[0]!
    expect(outcome.expandedFrom).toEqual({
      startSeq: nodes[resultNodeIdx]!,
      endSeq: nodes[resultNodeIdx]!,
    })
    expect(outcome.shadowedSeqs).toContain(nodes[callNodeIdx]!)
    expect(outcome.shadowedSeqs).toContain(nodes[resultNodeIdx]!)
  })

  it('extends a lone assistant/message request forward to its results', async () => {
    const { engine } = engineWith()
    const session = toolTurnSession(2)
    const agent = agentOf(session)
    const nodes = [...session.surface.nodes]
    const callNodeIdx = nodes.findLastIndex(seq => session.events[seq]?.type === 'assistant/message')
    const resultNodeIdxs = nodes
      .map((seq, index) => ({ seq, index }))
      .filter(({ seq }) => session.events[seq]?.type === 'tool/result')
    expect(resultNodeIdxs.length).toBe(2)
    // Request only the assistant message; both results must be included.
    const result = await engine.compressByModel(agent, [{
      startSeq: nodes[callNodeIdx]!,
      endSeq: nodes[callNodeIdx]!,
      summary: TURN_SUMMARY,
    }])
    expect(result.failures).toEqual([])
    const outcome = result.compressed[0]!
    expect(outcome.expandedFrom).toEqual({
      startSeq: nodes[callNodeIdx]!,
      endSeq: nodes[callNodeIdx]!,
    })
    for (const { seq } of resultNodeIdxs) expect(outcome.shadowedSeqs).toContain(seq)
  })

  it('leaves an already-balanced range untouched and reports no expansion', async () => {
    const { engine } = engineWith()
    const session = toolTurnSession(1)
    const agent = agentOf(session)
    const nodes = [...session.surface.nodes]
    const callNodeIdx = nodes.findLastIndex(seq => session.events[seq]?.type === 'assistant/message')
    const resultNodeIdx = nodes.findLastIndex(seq => session.events[seq]?.type === 'tool/result')
    // The complete turn is already balanced: no expansion is reported.
    const result = await engine.compressByModel(agent, [{
      startSeq: nodes[callNodeIdx]!,
      endSeq: nodes[resultNodeIdx]!,
      summary: TURN_SUMMARY,
    }])
    expect(result.failures).toEqual([])
    expect(result.compressed[0]!.expandedFrom).toBeUndefined()
  })

  it('rejects unbalanced ranges when auto-expansion is disabled', async () => {
    const { engine } = engineWith({ compress: { autoExpandToolPairs: false } })
    const session = toolTurnSession(1)
    const agent = agentOf(session)
    const nodes = [...session.surface.nodes]
    const resultNodeIdx = nodes.findLastIndex(seq => session.events[seq]?.type === 'tool/result')
    const result = await engine.compressByModel(agent, [{
      startSeq: nodes[resultNodeIdx]!,
      endSeq: nodes[resultNodeIdx]!,
      summary: TURN_SUMMARY,
    }])
    expect(result.compressed).toEqual([])
    expect(result.failures[0]!.reason).toContain('balanced boundary')
  })
})

/**
 * A session whose final turn contains one assistant message carrying tool
 * calls followed by the matching tool/result nodes.
 */
function toolTurnSession(results = 1): Session {
  const session = conversationSession(2)
  const turn = 3
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'run the tool' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  const calls = Array.from({ length: results }, (_, index) => CallId(`call-${index}`))
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [
        { type: 'text', text: 'calling' },
        ...calls.map(id => ({
          type: 'tool-call' as const,
          id,
          name: 'probe',
          arguments: '{}',
        })),
      ],
      source: { provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  for (const callId of calls) {
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: `result ${callId} `.repeat(500) }] }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn, step: 1 })
  return session
}

describe('AgenticCompactionEngine.decompressByModel', () => {
  it('restores by compaction id and returns the full transcript', async () => {
    const { engine } = engineWith()
    const session = conversationSession(4)
    const agent = agentOf(session)
    const nodes = [...session.surface.nodes]
    const compressed = await engine.compressByModel(agent, [{
      startSeq: nodes[0]!,
      endSeq: nodes[1]!,
      summary: TURN_SUMMARY,
    }])
    const id = compressed.compressed[0]!.compactionId
    const result = await engine.decompressByModel(agent, { compactionIds: [id] })
    expect(result.skipped).toEqual([])
    expect(result.restored).toHaveLength(1)
    expect(result.restored[0]!.compactionId).toBe(id)
    expect(result.restored[0]!.content).toContain('user 1')
    // The restore writes no session events: the transcript travels in the
    // tool result, keeping the tool-call/result pairing legal.
    expect(session.events.length).toBeLessThan(60)
  })

  it('restores every overlapping checkpoint for a range', async () => {
    const { engine } = engineWith()
    const session = conversationSession(6)
    const agent = agentOf(session)
    const nodes = [...session.surface.nodes]
    const first = await engine.compressByModel(agent, [{
      startSeq: nodes[0]!,
      endSeq: nodes[1]!,
      summary: TURN_SUMMARY,
    }])
    void first
    const after = session.surface.nodes
    const second = await engine.compressByModel(agent, [{
      startSeq: after[0]!,
      endSeq: after[1]!,
      summary: `${SUMMARY} again`,
    }])
    // A range spanning the second checkpoint's own span resolves it; the
    // tier-1 checkpoint beneath it is restored only by expanding (full or
    // one tier up), not as a separate target.
    const result = await engine.decompressByModel(agent, {
      startSeq: after[0]!,
      endSeq: after[1]!,
    })
    expect(result.restored).toHaveLength(1)
    expect(result.restored[0]!.compactionId).toBe(second.compressed[0]!.compactionId)
    expect(result.restored[0]!.tier).toBe(2)
  })

  it('enforces the per-call block budget', async () => {
    const { engine } = engineWith({ decompress: { maxBlocks: 1 } })
    const session = conversationSession(6)
    const agent = agentOf(session)
    const nodes = [...session.surface.nodes]
    await engine.compressByModel(agent, [{ startSeq: nodes[0]!, endSeq: nodes[1]!, summary: SUMMARY }])
    await engine.compressByModel(agent, [{ startSeq: nodes[4]!, endSeq: nodes[5]!, summary: `${SUMMARY} again` }])
    const views = checkpointViews(session)
    expect(views.length).toBe(2)
    await expect(engine.decompressByModel(agent, {
      compactionIds: views.map(view => view.compactionId),
    })).rejects.toThrow(/at most 1 blocks per call/)
  })

  it('reports unknown ids as skipped', async () => {
    const { engine } = engineWith()
    const session = conversationSession(4)
    const agent = agentOf(session)
    const result = await engine.decompressByModel(agent, { compactionIds: ['missing'] })
    expect(result.restored).toEqual([])
    expect(result.skipped).toEqual(['missing'])
  })
})

describe('AgenticCompactionEngine.status', () => {
  it('reports usage, checkpoints, tiers, and recommendations', async () => {
    const { engine } = engineWith({ protection: { retainRecentMessages: 0, protectFirstUserMessage: true } })
    const session = conversationSession(4)
    const agent = agentOf(session)
    await engine.compressByModel(agent, [{
      startSeq: session.surface.nodes[1]!,
      endSeq: session.surface.nodes[2]!,
      summary: TURN_SUMMARY,
    }])
    const status = await engine.status(agent)
    expect(status.sessionId).toBe(session.id)
    expect(status.totalTokens).toBeGreaterThan(0)
    expect(status.contextWindow).toBe(100_000)
    expect(status.usagePercent).toBeGreaterThan(0)
    expect(status.checkpoints).toHaveLength(1)
    expect(status.checkpoints[0]!.tier).toBe(1)
    expect(status.tierTokens[1]).toBeGreaterThan(0)
    expect(status.recentNodes.length).toBeGreaterThan(0)
    expect(status.recentNodes[0]!.seq).toBeDefined()
    expect(status.protectedSeqs).toContain(session.surface.nodes[0])
    expect(status.lastCompression?.author).toBe('model')
  })
})

describe('AgenticCompactionEngine automatic behavior', () => {
  it('establishes a baseline then injects a durable nudge on pressure', async () => {
    const ctx = createContext(100_000)
    const engine = new AgenticCompactionEngine(ctx, {
      nudge: { minRatio: 0.0005, maxRatio: 0.001, frequency: 1 },
      protection: { retainRecentMessages: 0 },
    })
    const session = conversationSession(2)
    const agent = agentOf(session)
    // First observation: baseline only, no nudge message.
    const first = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
    expect(first).toBeNull()
    expect(session.events.some(event => event.type === 'user/message'
      && (event.data.source as { purpose?: string }).purpose === 'nudge')).toBe(false)
    // Grow the surface so total exceeds 10% of the window and nudge fires.
    for (let i = 0; i < 30; i += 1) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `more context ${i} `.repeat(40) }],
        source: { kind: 'plugin', plugin: 'other' },
      }), { surfaceOp: 'append' })
    }
    const second = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
    expect(second).toBeNull()
    const nudgeIdx = session.events.findIndex(event => event.type === 'user/message'
      && (event.data.source as { purpose?: string }).purpose === 'nudge')
    expect(nudgeIdx).toBeGreaterThanOrEqual(0)
    const nudgeMessage = eventOf(session.events, nudgeIdx, 'user/message')
    expect((nudgeMessage.data.content as { text: string }[])[0]!.text).toContain('[context-management]')
  })

  it('compacts automatically on context overflow through the fallback summarizer', async () => {
    const { engine } = engineWith()
    const session = conversationSession(4)
    const agent = agentOf(session)
    const before = session.surface.nodes.length
    const result = await engine.compactIfNeeded(agent, 'context-overflow', new AbortController().signal)
    expect(result).not.toBeNull()
    expect(session.surface.nodes.length).toBeLessThan(before)
    // The fallback authorship is recoverable from the upstream summary
    // event's llmStreamCall flag.
    const summaryIdx = session.events.findIndex(event => event.type === 'compaction/summary')
    const summary = eventOf(session.events, summaryIdx, 'compaction/summary')
    expect(summary.data.llmStreamCall).toBe(true)
    expect(summary.data.shadowedSeqs.length).toBeGreaterThan(0)
    expect(result!.shadowedSeqs.length).toBeGreaterThan(0)
  })

  it('skips overflow compaction when the fallback is disabled', async () => {
    const { engine } = engineWith({ fallback: { enabled: false } })
    const session = conversationSession(4)
    const agent = agentOf(session)
    const result = await engine.compactIfNeeded(agent, 'context-overflow', new AbortController().signal)
    expect(result).toBeNull()
  })

  it('compactRegion commits through the fallback summarizer', async () => {
    const { engine } = engineWith()
    const session = conversationSession(4)
    const agent = agentOf(session)
    const nodes = [...session.surface.nodes]
    const result = await engine.compactRegion(nodes[0]!, nodes[1]!, agent) as import('../src/region.ts').CommitResult
    expect(result.author).toBe('fallback')
    expect(result.shadowedSeqs).toHaveLength(2)
  })

  it('compactNow requires an idle agent and commits standalone brackets', async () => {
    const { ctx, engine } = engineWith()
    const session = closedSession(3)
    ctx.sessions.enter(session)
    let taskRan = false
    const agent = {
      ...agentOf(session),
      runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => {
        taskRan = true
        return task(new AbortController().signal)
      },
    } as never
    const result = await engine.compactNow(agent as never, new AbortController().signal)
    expect(taskRan).toBe(true)
    expect(result).not.toBeNull()
    const events = session.events
    expect(events.some(event => event.type === 'compaction/start' && event.data.turn === null)).toBe(true)
    expect(events.some(event => event.type === 'compaction/end' && event.data.turn === null)).toBe(true)
  })

  it('manual compaction fails loudly when the agent is busy', () => {
    const { engine } = engineWith()
    const session = conversationSession(4)
    const agent = {
      ...agentOf(session),
      runMaintenance: () => {
        throw new Error('busy')
      },
    } as never
    // compactNow throws synchronously when the idle phase is claimed.
    expect(() => engine.compactNow(agent as never, new AbortController().signal))
      .toThrow(/requires an idle agent/)
  })

  it('range eligibility honors the tier cap', async () => {
    const { engine } = engineWith({ tiers: { maxTier: 1 } })
    const session = conversationSession(4)
    const agent = agentOf(session)
    const nodes = [...session.surface.nodes]
    const selection = validateSurfaceRange(session, nodes[0]!, nodes[1]!)
    const config = engine.config
    expect(rangeIneligibility(session, selection, config)).toBeUndefined()
    await engine.compressByModel(agent, [{ startSeq: nodes[0]!, endSeq: nodes[1]!, summary: SUMMARY }])
    const after = session.surface.nodes
    const second = validateSurfaceRange(session, after[0]!, after[1]!)
    expect(rangeIneligibility(session, second, config)?.reason).toBe('max-tier')
  })
})
