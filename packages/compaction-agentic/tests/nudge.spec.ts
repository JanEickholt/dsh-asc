import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  commitSurfaceCompaction,
} from '../src/region.ts'
import { validateSurfaceRange } from '../src/protected.ts'
import { foldNudgeState, decideNudge, buildNudgeText, nodesSinceLastUser, recommendRanges } from '../src/nudge.ts'
import { resolveConfig } from '../src/config.ts'
import type { NudgeInput } from '../src/nudge.ts'
import { createContext, conversationSession, MODEL } from './helpers.ts'

function nudgeInput(
  session: import('@deepseek-ai/dsh-session').Session,
  ctx: import('@deepseek-ai/cordis').Context,
  config: ReturnType<typeof resolveConfig> = resolveConfig({}),
  contextWindow = 100_000,
  transientTierBaselines?: Map<number, number>,
): NudgeInput {
  return {
    session,
    measurement: ctx.tokenMeter.measure(session),
    config,
    contextWindow,
    state: foldNudgeState(session.events),
    transientBaseline: 0,
    transientTierBaselines: transientTierBaselines ?? new Map(),
  }
}

describe('foldNudgeState', () => {
  it('folds baselines from nudge and compress records', () => {
    const session = conversationSession(2)
    session.append('context/nudge', {
      kind: 'pressure',
      totalTokens: 1000,
      surfaceTokens: 900,
      growthSinceBaseline: 500,
      tierTokens: [{ tier: 1, tokens: 300 }],
    })
    session.append('step/start', { turn: 2, step: 2 })
    session.append('step/end', { turn: 2, step: 2 })
    const state = foldNudgeState(session.events)
    expect(state.lastBaseline).toMatchObject({ kind: 'nudge', totalTokens: 1000 })
    expect(state.tierBaselines.get(1)).toBe(300)
    expect(state.stepsSinceBaseline).toBe(1)
  })

  it('counts steps before any baseline from session start', () => {
    const session = conversationSession(2)
    const state = foldNudgeState(session.events)
    expect(state.lastBaseline).toBeUndefined()
    // one step/start per closed turn
    expect(state.stepsSinceBaseline).toBe(2)
  })
})

describe('decideNudge', () => {
  it('stays quiet below the min ratio', () => {
    const ctx = createContext()
    const session = conversationSession(2)
    const decision = decideNudge(nudgeInput(session, ctx))
    expect(decision.kind).toBe('none')
  })

  it('fires pressure only after the frequency gate on over-max', () => {
    const ctx = createContext()
    const session = conversationSession(2)
    // Zero recent-tail retention so recommendations exist for small sessions.
    const config = resolveConfig({ nudge: { frequency: 5 }, protection: { retainRecentMessages: 0 } })
    // Tiny window: total (~200) >= 0.8 * 100 = 80 → over max, but only 2
    // steps have passed (< frequency 5) → quiet.
    const quiet = decideNudge(nudgeInput(session, ctx, config, 100))
    expect(quiet.kind).toBe('none')
    // Three more steps cross the frequency gate → pressure.
    for (let i = 0; i < 3; i += 1) {
      session.append('step/start', { turn: 2, step: 2 + i })
      session.append('step/end', { turn: 2, step: 2 + i })
    }
    const fired = decideNudge(nudgeInput(session, ctx, config, 100))
    expect(fired.kind).toBe('pressure')
    expect(fired.recommendations.length).toBeGreaterThan(0)
  })

  it('fires tier nudge when tier summaries grow past the threshold', () => {
    const ctx = createContext()
    const session = conversationSession(4)
    // Build a large tier-1 checkpoint so tierTokens(1) is high.
    const nodes = session.surface.nodes
    const selection = validateSurfaceRange(session, nodes[0]!, nodes[Math.floor(nodes.length / 2)]!)
    void commitSurfaceCompaction(
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
    // A transient tier-1 baseline of 0 makes all tier-1 tokens growth.
    const config = resolveConfig({ tiers: { growthTokens: 1 } })
    const decision = decideNudge(nudgeInput(session, ctx, config, 100_000, new Map([[1, 0]])))
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
    // Window 600: min 270 < total ~300 < max 480 → over-min, under-max.
    const decision = decideNudge(nudgeInput(session, ctx, config, 600))
    expect(decision.kind).toBe('iteration')
  })

  it('ignores nudges injected by this plugin when counting user messages', () => {
    const ctx = createContext()
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
    const decision = decideNudge(nudgeInput(session, ctx, config, 100))
    expect(decision.kind).toBe('none')
  })
})

describe('buildNudgeText', () => {
  it('contains pinned model-facing phrases', () => {
    const ctx = createContext()
    const session = conversationSession(2)
    const config = resolveConfig({ nudge: { frequency: 1 }, protection: { retainRecentMessages: 0 } })
    const input = nudgeInput(session, ctx, config, 100)
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
    const input = nudgeInput(session, ctx, config, 100)
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
    // after it.
    expect(ranges[0]!.startSeq).not.toBe(session.surface.nodes[0])
  })
})
