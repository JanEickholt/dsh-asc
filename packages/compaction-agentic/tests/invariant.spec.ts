import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { InvariantRegistry, InvariantError } from '@deepseek-ai/dsh-invariants'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import * as invariantCompanion from '../src/invariant.ts'
import { nudgeSource, restoreSource } from '../src/restore.ts'
import { conversationSession, MODEL } from './helpers.ts'

async function contextWithInvariants(): Promise<Context> {
  const ctx = new Context()
  void new SessionStore(ctx)
  void new InvariantRegistry(ctx)
  // Plain test contexts have no scope fork: register with non-global listeners.
  await ctx.plugin({ name: invariantCompanion.name, inject: invariantCompanion.inject, apply: invariantCompanion.apply }, { global: false })
  return ctx
}

describe('compaction-agentic invariant companion', () => {
  it('accepts a valid nudge adjacency', async () => {
    const ctx = await contextWithInvariants()
    const session = conversationSession(2)
    ctx.sessions.enter(session)
    session.append('context/nudge', {
      kind: 'pressure',
      totalTokens: 10,
      surfaceTokens: 10,
      growthSinceBaseline: 5,
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[context-management] nudge' }],
      source: nudgeSource(),
    }), { surfaceOp: 'append', sourceEventSeqs: [session.events.at(-1)!.seq] })
    expect(session.events.at(-1)!.type).toBe('user/message')
  })

  it('rejects a nudge record not followed by its adjacent message', async () => {
    const ctx = await contextWithInvariants()
    const session = conversationSession(2)
    ctx.sessions.enter(session)
    session.append('context/nudge', {
      kind: 'pressure',
      totalTokens: 10,
      surfaceTokens: 10,
      growthSinceBaseline: 5,
    })
    expect(() => session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'ordinary message' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })).toThrow(InvariantError)
  })

  it('rejects a decompress record not followed by its restore message', async () => {
    const ctx = await contextWithInvariants()
    const session = conversationSession(2)
    ctx.sessions.enter(session)
    const id = CompactionId('c1')
    session.append('context/decompress', {
      compactionId: id,
      tier: 1,
      full: false,
      restoredSeqs: [1],
      restoredTokens: 10,
      restoredChars: 20,
    })
    expect(() => session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'wrong' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })).toThrow(InvariantError)
  })

  it('accepts a decompress record followed by its restore message', async () => {
    const ctx = await contextWithInvariants()
    const session = conversationSession(2)
    ctx.sessions.enter(session)
    const id = CompactionId('c2')
    session.append('context/decompress', {
      compactionId: id,
      tier: 1,
      full: false,
      restoredSeqs: [1],
      restoredTokens: 10,
      restoredChars: 20,
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'restored' }],
      source: restoreSource(id, 1, false),
    }), { surfaceOp: 'append', sourceEventSeqs: [1] })
    expect(session.events.at(-1)!.type).toBe('user/message')
  })

  it('rejects a context/compress outside its bracket', async () => {
    const ctx = await contextWithInvariants()
    const session = conversationSession(2)
    ctx.sessions.enter(session)
    expect(() => session.append('context/compress', {
      compactionId: CompactionId('c3'),
      author: 'model',
      tier: 1,
      totalTokens: 5,
    })).toThrow(InvariantError)
  })

  it('rejects a context/compress before its compaction/summary', async () => {
    const ctx = await contextWithInvariants()
    const session = conversationSession(2)
    ctx.sessions.enter(session)
    const id = CompactionId('c4')
    session.append('compaction/start', { compactionId: id, turn: null })
    expect(() => session.append('context/compress', {
      compactionId: id,
      author: 'model',
      tier: 1,
      totalTokens: 5,
    })).toThrow(/must follow the compaction\/summary/)
  })

  it('accepts a context/compress between summary and end, once per bracket', async () => {
    const ctx = await contextWithInvariants()
    const session = conversationSession(2)
    ctx.sessions.enter(session)
    const id = CompactionId('c5')
    session.append('compaction/start', { compactionId: id, turn: null })
    session.append('compaction/summary', {
      compactionId: id,
      summary: [{ type: 'text', text: 's' }],
      shadowedRange: { start: 2, end: 2 },
      shadowedSeqs: [2],
      shadowedTokenCount: 100,
      provider: MODEL,
      model: MODEL,
    })
    session.append('context/compress', {
      compactionId: id,
      author: 'model',
      tier: 1,
      totalTokens: 5,
    })
    expect(() => session.append('context/compress', {
      compactionId: id,
      author: 'model',
      tier: 1,
      totalTokens: 5,
    })).toThrow(/only once per compaction bracket/)
    session.append('compaction/end', { compactionId: id, turn: null })
  })

  it('rejects a compaction/end with a mismatched id', async () => {
    const ctx = await contextWithInvariants()
    const session = conversationSession(2)
    ctx.sessions.enter(session)
    const id = CompactionId('c6')
    session.append('compaction/start', { compactionId: id, turn: null })
    expect(() => session.append('compaction/end', { compactionId: CompactionId('other'), turn: null }))
      .toThrow(InvariantError)
  })

  it('validates seeded sessions at mount time', async () => {
    const ctx = new Context()
    void new SessionStore(ctx)
    void new InvariantRegistry(ctx)
    const session = conversationSession(2)
    ctx.sessions.enter(session)
    session.append('context/nudge', {
      kind: 'pressure',
      totalTokens: 10,
      surfaceTokens: 10,
      growthSinceBaseline: 5,
    })
    // The companion must refuse the corrupt seed.
    await expect(ctx.plugin({
      name: invariantCompanion.name,
      inject: invariantCompanion.inject,
      apply: invariantCompanion.apply,
    }, { global: false })).rejects.toThrow(InvariantError)
  })
})

