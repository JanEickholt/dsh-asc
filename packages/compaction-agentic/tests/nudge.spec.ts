import { describe, expect, it } from 'vitest'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  commitSurfaceCompaction,
} from '../src/region.ts'
import { validateSurfaceRange } from '../src/protected.ts'
import {
  applyCompressionBaseline,
  applyNudgeBaseline,
  buildNudgeText,
  decideNudge,
  freshNudgeState,
  nodesSinceLastUser,
  recommendRanges,
} from '../src/nudge.ts'
import { resolveConfig } from '../src/config.ts'
import type { NudgeInput } from '../src/nudge.ts'
import { createContext, conversationSession, MODEL } from './helpers.ts'

function nudgeInput(
  session: import('@deepseek-ai/dsh-session').Session,
  ctx: import('@deepseek-ai/cordis').Context,
  config: ReturnType<typeof resolveConfig> = resolveConfig({}),
  contextWindow = 100_000,
  state = freshNudgeState(),
): NudgeInput {
  return {
    session,
    measurement: ctx.tokenMeter.measure(session),
    config,
    contextWindow,
    state,
  }
}

describe('freshNudgeState and baselines', () => {
  it('starts without a baseline', () => {
    const state = freshNudgeState()
    expect(state.lastBaselineTokens).toBeUndefined()
    expect(state.tierBaselines.size).toBe(0)
    expect(state.stepsSinceBaseline).toBe(0)
  })

  it('records a nudge baseline with tier totals', () => {
    const state = applyNudgeBaseline(1000, new Map([[0, 700], [1, 300]]))
    expect(state.lastBaselineTokens).toBe(1000)
    expect(state.tierBaselines.get(1)).toBe(300)
    expect(state.stepsSinceBaseline).toBe(0)
  })

  it('resets only the consumed tier on a distillation compression', () => {
    const base = applyNudgeBaseline(1000, new Map([[1, 300], [2, 100]]))
    const after = applyCompressionBaseline(base, 500, 2, new Map([[1, 50], [2, 200]]))
    expect(after.lastBaselineTokens).toBe(500)
    expect(after.tierBaselines.get(1)).toBe(50)
    expect(after.tierBaselines.get(2)).toBe(100) // untouched cadence
    // A tier-1 capture only grows the pile: nothing resets.
    const afterCapture = applyCompressionBaseline(base, 800, 1, new Map([[1, 500]]))
    expect(afterCapture.tierBaselines.get(1)).toBe(300)
  })
})

describe('decideNudge', () => {
  it('stays quiet before the first baseline', () => {
    const ctx = createContext()
    const session = conversationSession(2)
    const decision = decideNudge(nudgeInput(session, ctx, resolveConfig({}), 100))
    expect(decision.kind).toBe('none')
  })

  it('fires pressure only after the frequency gate on over-max', () => {
    const ctx = createContext()
    const session = conversationSession(2)
    const config = resolveConfig({
      nudge: { frequency: 5 },
      protection: { retainRecentMessages: 0 },
    })
    let state = applyNudgeBaseline(ctx.tokenMeter.measure(session).totalTokens, new Map())
    // Tiny window: total (~200) >= 0.8 * 100 = 80 → over max, but the step
    // counter (1) is below the frequency gate (5) → quiet.
    const quiet = decideNudge(nudgeInput(session, ctx, config, 100, { ...state, stepsSinceBaseline: 1 }))
    expect(quiet.kind).toBe('none')
    // Four more steps cross the frequency gate → pressure.
    state = { ...state, stepsSinceBaseline: 5 }
    const fired = decideNudge(nudgeInput(session, ctx, config, 100, state))
    expect(fired.kind).toBe('pressure')
    expect(fired.recommendations.length).toBeGreaterThan(0)
  })

  it('fires tier nudge when tier summaries grow past the threshold', async () => {
    const ctx = createContext()
    const session = conversationSession(4)
    // Build a large tier-1 checkpoint so tierTokens(1) is high.
    const nodes = session.surface.nodes
    const selection = validateSurfaceRange(session, nodes[0]!, nodes[Math.floor(nodes.length / 2)]!)
    await commitSurfaceCompaction(
      { meter: ctx.tokenMeter },
      session,
      selection.start,
      selection.end,
      {
        kind: 'model',
        summary: 'detailed checkpoint preserving every file path and decision made during the first half of this session',
        provider: MODEL,
        model: MODEL,
      },
      { owner: 'current-turn', stability: 'whole-surface' },
    )
    // A zero tier-1 baseline makes all tier-1 tokens growth.
    const config = resolveConfig({ tiers: { growthTokens: 1 } })
    const state = applyNudgeBaseline(0, new Map([[1, 0]]))
    const decision = decideNudge(nudgeInput(session, ctx, config, 100_000, state))
    expect(decision.kind).toBe('tier')
    expect(decision.tier).toBe(2)
  })

  it('fires iteration nudge after many messages since the last user prompt', () => {
    const ctx = createContext()
    const session = conversationSession(2)
    for (let i = 0; i < 20; i += 1) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `injected context ${i}` }],
        source: { kind: 'plugin', plugin: 'other' },
      }), { surfaceOp: 'append' })
    }
    const config = resolveConfig({ nudge: { iterationThreshold: 10 } })
    const state = applyNudgeBaseline(0, new Map())
    // Window 600: min 270 < total ~300 < max 480 → over-min, under-max.
    const decision = decideNudge(nudgeInput(session, ctx, config, 600, { ...state, stepsSinceBaseline: 1 }))
    expect(decision.kind).toBe('iteration')
  })

  it('ignores nudges injected by this plugin when counting user messages', () => {
    const session = conversationSession(2)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[context-management] nudge' }],
      source: { kind: 'plugin', plugin: 'dsh-asc', purpose: 'nudge' },
    }), { surfaceOp: 'append' })
    // conversationSession(2) = [u1, a1, u2, a2]; the nudge lands after the
    // last user message, so the count is a2 + nudge = 2 — and appending
    // another nudge must not reset it.
    expect(nodesSinceLastUser(session)).toBe(2)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[context-management] nudge again' }],
      source: { kind: 'plugin', plugin: 'dsh-asc', purpose: 'nudge' },
    }), { surfaceOp: 'append' })
    expect(nodesSinceLastUser(session)).toBe(3)
    // A real user message resets the counter.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'actual prompt' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(nodesSinceLastUser(session)).toBe(0)
  })

  it('respects the nudge master switch', () => {
    const ctx = createContext()
    const session = conversationSession(2)
    const config = resolveConfig({ nudge: { enabled: false } })
    const state = applyNudgeBaseline(0, new Map())
    const decision = decideNudge(nudgeInput(session, ctx, config, 100, state))
    expect(decision.kind).toBe('none')
  })
})

describe('buildNudgeText', () => {
  it('contains pinned model-facing phrases', () => {
    const ctx = createContext()
    const session = conversationSession(2)
    const config = resolveConfig({
      nudge: { frequency: 1 },
      protection: { retainRecentMessages: 0 },
    })
    const state = applyNudgeBaseline(0, new Map())
    const input = nudgeInput(session, ctx, config, 100, { ...state, stepsSinceBaseline: 1 })
    const decision = decideNudge(input)
    expect(decision.kind).not.toBe('none')
    const text = buildNudgeText({
      decision,
      totalTokens: input.measurement.totalTokens,
      surfaceTokens: input.measurement.surfaceTokens,
      contextWindow: 100,
      config,
    })
    expect(text).toContain('[context-management]')
    expect(text).toContain('context_compress')
    expect(text).toContain('context_decompress')
    expect(text).toContain('Recommended ranges')
  })

  it('renders strong wording for strong force', () => {
    const ctx = createContext()
    const session = conversationSession(2)
    const config = resolveConfig({ nudge: { force: 'strong', frequency: 1 } })
    const state = applyNudgeBaseline(0, new Map())
    const input = nudgeInput(session, ctx, config, 100, { ...state, stepsSinceBaseline: 1 })
    const decision = decideNudge(input)
    const text = buildNudgeText({
      decision,
      totalTokens: input.measurement.totalTokens,
      surfaceTokens: input.measurement.surfaceTokens,
      contextWindow: 100,
      config,
    })
    expect(text).toContain('Context is high')
  })
})

describe('recommendRanges', () => {
  it('recommends a head range bounded by the recent tail', () => {
    const ctx = createContext()
    const session = conversationSession(5)
    const config = resolveConfig({ protection: { retainRecentMessages: 0 } })
    const ranges = recommendRanges(session, ctx.tokenMeter.measure(session), config)
    expect(ranges.length).toBeGreaterThan(0)
    expect(ranges[0]!.kind).toBe('history')
    // The first user message is protected by default; the head range starts
    // after it, and positions mirror recentNodes order.
    expect(ranges[0]!.startSeq).not.toBe(session.surface.nodes[0])
    expect(ranges[0]!.startPosition).toBeLessThan(ranges[0]!.endPosition)
  })

  it('marks every recommendation commit-ready and balanced', () => {
    const ctx = createContext()
    const session = conversationSession(5)
    const config = resolveConfig({ protection: { retainRecentMessages: 0 } })
    const ranges = recommendRanges(session, ctx.tokenMeter.measure(session), config)
    expect(ranges.length).toBeGreaterThan(0)
    for (const range of ranges) {
      expect(range.balanced).toBe(true)
      // A model acting on the recommendation must never hit a rejection.
      expect(() => validateSurfaceRange(session, range.startSeq, range.endSeq)).not.toThrow()
    }
  })

  it('never recommends a single tool/result node without its paired call', () => {
    const ctx = createContext()
    const session = toolSession()
    const config = resolveConfig({ protection: { retainRecentMessages: 0 } })
    const ranges = recommendRanges(session, ctx.tokenMeter.measure(session), config)
    for (const range of ranges) {
      expect(() => validateSurfaceRange(session, range.startSeq, range.endSeq)).not.toThrow()
    }
  })
})

/**
 * A session whose tail holds one assistant tool call plus a large result.
 */
function toolSession(): ReturnType<typeof conversationSession> {
  const session = conversationSession(2)
  const turn = 3
  const callId = CallId('call-0')
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'inspect' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: callId, name: 'probe', arguments: '{}' },
      ],
      source: { provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'huge output '.repeat(200) }] }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  return session
}
