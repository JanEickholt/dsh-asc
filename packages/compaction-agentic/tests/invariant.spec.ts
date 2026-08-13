import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { InvariantRegistry, InvariantError } from '@deepseek-ai/dsh-invariants'
import * as invariantCompanion from '../src/invariant.ts'

async function contextWithInvariants(): Promise<Context> {
  const ctx = new Context()
  void new SessionStore(ctx)
  void new InvariantRegistry(ctx)
  await ctx.plugin({
    name: invariantCompanion.name,
    inject: invariantCompanion.inject,
    apply: invariantCompanion.apply,
  })
  return ctx
}

describe('compaction-agentic invariant companion', () => {
  it('mounts and registers under the package name', async () => {
    const ctx = await contextWithInvariants()
    expect(ctx.get('invariants')).toBeInstanceOf(InvariantRegistry)
  })

  it('does not veto ordinary log writes (no custom event vocabulary)', async () => {
    const ctx = await contextWithInvariants()
    const session = ctx.sessions.create()
    session.append('user/message', {
      role: 'user',
      id: 'm-1',
      content: [{ type: 'text', text: 'ordinary' }],
      source: { kind: 'user' },
    } as never, { surfaceOp: 'append' })
    expect(session.events).toHaveLength(1)
  })

  it('keeps the upstream compaction bracket enforcement intact', async () => {
    const ctx = await contextWithInvariants()
    const session = ctx.sessions.create()
    // The upstream companion is not mounted here, so an unmatched
    // compaction/start is accepted by ours — the bracket belongs to
    // @deepseek-ai/dsh-compaction/invariant.
    session.append('compaction/start', { compactionId: 'c1' as never, turn: null })
    expect(session.events.at(-1)!.type).toBe('compaction/start')
  })

  it('rejects nothing the base harness rejects (compatibility smoke)', async () => {
    const ctx = await contextWithInvariants()
    const session = ctx.sessions.create()
    expect(() => session.append('user/message', {
      role: 'user',
      id: 'm-2',
      content: [{ type: 'text', text: 'x' }],
      source: { kind: 'user' },
    } as never, { surfaceOp: 'append' })).not.toThrow(InvariantError)
  })
})
