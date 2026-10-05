/**
 * Post-execute reversible projection + context_retrieve behavior tests.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ToolResultProjectionService } from '../src/projection/service.ts'
import { buildMarker, contentHash, planProjection } from '../src/projection/projection.ts'
import { compressStructured } from '../src/projection/structured.ts'
import { agentOf, createContext, eventOf, SIGNAL } from './helpers.ts'

let sessionCounter = 0
let callCounter = 0

/** A large log-shaped text: 400 distinct-ish lines with a compressible shape. */
function bigLogText(lines = 400): string {
  const out: string[] = []
  for (let i = 0; i < lines; i++) {
    out.push(`2026-01-01 10:00:${String(i % 60).padStart(2, '0')} INFO request ${i} handled path=/api/${i % 7}`)
  }
  return out.join('\n')
}

/** The inner content blocks of one tool-result event, without casts in tests. */
function innerContentOf(event: SessionEvent): ContentBlock[] {
  if (event.type !== 'tool/result') throw new Error(`event ${event.seq} is not a tool/result`)
  const blocks = event.data.message.content
  if (!Array.isArray(blocks)) throw new Error(`event ${event.seq} has no inner content`)
  return blocks as ContentBlock[]
}

function innerTextOf(blocks: readonly ContentBlock[]): string {
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Build the durable call/result pair the agent loop commits for one call. */
function appendToolResult(
  session: Session,
  text: string,
  turn = 1,
  step = 1,
): { callId: ToolCallId; resultSeq: number } {
  const callId = ToolCallId(`call-${callCounter++}`)
  session.append('tool/call', {
    turn,
    step,
    callId,
    name: 'bash',
    arguments: '"run"',
  })
  const callSeq = SessionSeq(session.seq - 1)
  const event = session.append('tool/result', {
    turn,
    step,
    message: toolResultMessage(callId, [{ type: 'text', text }], false),
  }, {
    surfaceOp: 'append',
    sourceEventSeqs: [callSeq],
  })
  return { callId, resultSeq: event.seq }
}

/** The exact message shape the agent loop materializes for a tool result. */
function toolResultMessage(
  callId: ToolCallId,
  content: ContentBlock[],
  isError: boolean,
): ToolResultMessage {
  return createToolResultMessage({ callId, content, isError })
}

/** A minimal post-execute waterfall pass with an unchanged default decision. */
async function runPostExecute(
  ctx: Context,
  session: Session,
  callId: ToolCallId,
  text: string,
  toolName = 'bash',
): Promise<void> {
  const exec = {
    callId,
    rootCallId: callId,
    name: toolName,
    arguments: {},
    agent: agentOf(session),
    signal: SIGNAL,
    token: {},
  }
  const result = {
    isError: false,
    value: null,
    content: [{ type: 'text', text }] as ContentBlock[],
  }
  await ctx.waterfall('tools/post-execute', exec as never, result as never, () => Promise.resolve({ kind: 'accept' } as never))
}

/** Materialize the settled result exactly as the agent-loop commit does. */
function materializeResult(
  session: Session,
  callId: ToolCallId,
  text: string,
  callSeq: number,
): number {
  return session.append('tool/result', {
    turn: 1,
    step: 1,
    message: toolResultMessage(callId, [{ type: 'text', text }], false),
  }, { surfaceOp: 'append', sourceEventSeqs: [SessionSeq(callSeq)] }).seq
}

/** Drain the firehose's queued commit microtask. */
function flush(): Promise<void> {
  return new Promise(resolve => queueMicrotask(() => queueMicrotask(resolve)))
}

/**
 * Drive the real loop ordering against one fixture session: open the call,
 * run post-execute (the service stashes the candidate), materialize the
 * settled result, then drain the queued commit microtask.
 */
async function projectFixture(
  ctx: Context,
  text: string,
  toolName = 'bash',
): Promise<{ session: Session; callId: ToolCallId; resultSeq: number }> {
  const session = fixtureSession(ctx)
  const callId = ToolCallId(`call-${callCounter++}`)
  session.append('tool/call', { turn: 1, step: 1, callId, name: toolName, arguments: '"run"' })
  const callSeq = SessionSeq(session.seq - 1)
  await runPostExecute(ctx, session, callId, text, toolName)
  const resultSeq = materializeResult(session, callId, text, callSeq)
  await flush()
  return { session, callId, resultSeq }
}

/**
 * One fixture session with an open turn, ENTERED into a session store:
 * `session/event` observers fire only for store-attached sessions.
 */
function fixtureSession(ctx: Context): Session {
  const store = new SessionStore(ctx)
  const session = store.create(SessionId(`projection-${sessionCounter++}`))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  return session
}

describe('structured reducers', () => {
  it('reduces a large log by collapsing adjacent duplicate lines', () => {
    const text = [...Array.from({ length: 30 }, () => 'INFO service started ok'), 'INFO line two'].join('\n')
    const result = compressStructured(text)
    expect(result.contentType).toBe('log')
    expect(result.text).not.toBeNull()
    expect(result.text!.length).toBeLessThan(text.length)
    expect(result.text).toContain('context_retrieve')
  })

  it('returns null for text with no reducer match', () => {
    expect(compressStructured('just one line of text')).toEqual({ text: null, contentType: 'text' })
  })

  it('returns null when the fallback window leaves the text unchanged', () => {
    // Ten short distinct lines: strip/dedupe/trim are no-ops and the
    // fallback window (head 40 / tail 20) covers them all.
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')
    expect(compressStructured(text)).toEqual({ text: null, contentType: 'cli-output' })
  })

  it('threads the failed flag into the failure-window reducer', () => {
    // Forty distinct kept lines exceed both windows: the summarize window
    // (head 10 / tail 12) keeps 22, the failure window (head 16 / tail 18)
    // keeps 34 — so the failed flag must widen the reduction.
    const text = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0
        ? `FAILED tests/spec-${i}.ts expected ${i} to be ${i + 1}`
        : `ERROR at src/svc.ts:${i}: boom`,
    ).join('\n')
    const normal = compressStructured(text, 'bash', false)
    const failed = compressStructured(text, 'bash', true)
    expect(normal.text).not.toBeNull()
    expect(failed.text).not.toBeNull()
    expect(failed.text!.length).toBeGreaterThan(normal.text!.length)
  })
})

describe('planProjection', () => {
  /** A deterministic stub meter for planner units (chars/4 + framing). */
  const budget = (thresholdTokens: number) => ({
    thresholdTokens,
    estimate: (blocks: readonly ContentBlock[]) =>
      4 + blocks.reduce((sum, block) => sum + ('text' in block ? block.text.length : 0), 0) / 4,
  })

  it('returns null when every text block is within the threshold', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'short' }]
    expect(planProjection(blocks, 7, budget(1000))).toBeNull()
  })

  it('plans a structured reduction with a marker naming hash and originalSeq', () => {
    const text = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: i, name: `row-${i}` })))
    const blocks: ContentBlock[] = [{ type: 'text', text }]
    const plan = planProjection(blocks, 42, budget(1000))
    expect(plan).not.toBeNull()
    expect(plan!.originalSeq).toBe(42)
    expect(plan!.hash).toMatch(/^[0-9a-f]{24}$/)
    expect(plan!.hash).toBe(contentHash(blocks))
    expect(plan!.strategy).toBe('structured')
    expect(plan!.tokensAfter).toBeLessThan(plan!.tokensBefore)
    const projectedText = innerTextOf(plan!.blocks)
    expect(projectedText).toContain(`context_retrieve(hash="${plan!.hash}")`)
    expect(projectedText).toContain('seq 42')
    const marker = buildMarker({
      hash: plan!.hash,
      originalSeq: 42,
      kind: plan!.kind,
      tokensBefore: plan!.tokensBefore,
      tokensAfter: plan!.tokensAfter,
    })
    expect(marker).toContain(`context_retrieve(hash="${plan!.hash}")`)
  })

  it('falls back to a meter-priced head/tail slice and lands under the threshold', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: bigLogText() }]
    const plan = planProjection(blocks, 7, budget(2000))
    expect(plan).not.toBeNull()
    expect(plan!.tokensAfter).toBeLessThanOrEqual(2000)
    expect(plan!.hash).toBe(contentHash(blocks))
    const projectedText = innerTextOf(plan!.blocks)
    expect(projectedText).toContain('context_retrieve(hash="')
    expect(projectedText.length).toBeLessThan(bigLogText().length)
  })

  it('returns null when even the minimum slice cannot reach the threshold', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'x'.repeat(300) }]
    expect(planProjection(blocks, 1, budget(1))).toBeNull()
  })
})

describe('ToolResultProjectionService end-to-end', () => {
  it('projects an oversized tool result with the pruner shadow+replace pattern', async () => {
    const ctx = createContext()
    const service = new ToolResultProjectionService(ctx, { thresholdTokens: 1000, enabled: true })

    // The post-execute waterfall records the candidate but returns the
    // decision UNCHANGED so the original event can land first; the commit
    // then shadows the original and appends the replacement after it.
    const { session, resultSeq } = await projectFixture(ctx, bigLogText())

    // The original event is still durable in the log, byte-exact.
    const originalEvent = session.snapshotEvents()[resultSeq]
    expect(originalEvent?.type).toBe('tool/result')
    expect(innerTextOf(innerContentOf(originalEvent!))).toBe(bigLogText())

    // A shadow price and a replacement were appended after the original.
    const log = session.snapshotEvents()
    const pruneEvent = log[resultSeq + 1]
    expect(pruneEvent?.type).toBe('compaction/prune')
    const replacement = log[resultSeq + 2]
    expect(replacement?.type).toBe('tool/result')
    const projectedText = innerTextOf(innerContentOf(replacement!))
    expect(projectedText).toContain('context_retrieve(hash="')
    expect(projectedText.length).toBeLessThan(bigLogText().length)

    // The marker's hash resolves the durable original content exactly.
    const originalHash = contentHash(innerContentOf(originalEvent!))
    expect(projectedText).toContain(`hash="${originalHash}"`)
    expect(projectedText).toContain(`seq ${resultSeq}`)

    // The surface shows the replacement, not the shadowed original.
    expect(session.surface.nodes.includes(SessionSeq(resultSeq))).toBe(false)
    expect(session.surface.nodes.includes(replacement!.seq)).toBe(true)

    void service
    void pruneEvent
  })

  it('leaves results under the threshold untouched and emits no marker', async () => {
    const ctx = createContext()
    const service = new ToolResultProjectionService(ctx, { thresholdTokens: 1000, enabled: true })
    const { session } = await projectFixture(ctx, 'small result')
    const log = session.snapshotEvents()
    expect(log.some(event => event.type === 'compaction/prune')).toBe(false)
    expect(log.some(event => event.type === 'tool/result' && event.surfaceOp !== 'append')).toBe(false)
    void service
  })

  it('re-verifies content at commit: a shrunk materialization commits nothing', async () => {
    const ctx = createContext()
    const session = fixtureSession(ctx)
    const callId = ToolCallId(`call-${callCounter++}`)
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '"run"' })
    const callSeq = SessionSeq(session.seq - 1)
    const loggerError = vi.spyOn(ctx.logger, 'error')
    const service = new ToolResultProjectionService(ctx, { thresholdTokens: 1000, enabled: true })
    await runPostExecute(ctx, session, callId, 'x'.repeat(50_000))
    materializeResult(session, callId, 'settled small', callSeq)
    await flush()
    expect(loggerError).not.toHaveBeenCalled()
    const log = session.snapshotEvents()
    expect(log.some(event => event.type === 'compaction/prune')).toBe(false)
    // The small materialization was left alone — no marker, nothing dangling.
    const replacement = log.find(event => event.type === 'tool/result'
      && innerTextOf(innerContentOf(event)) === 'settled small')
    expect(replacement).toBeDefined()
    void service
  })

  it('never projects context_retrieve results — they land byte-exact', async () => {
    const ctx = createContext()
    const service = new ToolResultProjectionService(ctx, { thresholdTokens: 1000, enabled: true })
    // A retrieval result far over the threshold must stay unprojected:
    // projecting it would break the byte-exactness contract it serves.
    const { session, resultSeq } = await projectFixture(ctx, bigLogText(), 'context_retrieve')
    const log = session.snapshotEvents()
    expect(log.some(event => event.type === 'compaction/prune')).toBe(false)
    expect(log.some(event => event.type === 'tool/result' && event.surfaceOp !== 'append')).toBe(false)
    expect(innerTextOf(innerContentOf(log[resultSeq]!))).toBe(bigLogText())
    void service
  })

  it('survives restart: a session rebuilt from the log still holds the original', async () => {
    const ctx = createContext()
    const service = new ToolResultProjectionService(ctx, { thresholdTokens: 1000, enabled: true })
    const { session, resultSeq } = await projectFixture(ctx, bigLogText())

    // Capture the marker hash BEFORE the restart.
    const projectedText = innerTextOf(innerContentOf(session.snapshotEvents()[resultSeq + 2]!))
    const markerHash = projectedText.match(/context_retrieve\(hash="([0-9a-f]{24})"\)/)?.[1]
    expect(markerHash).toBeDefined()

    const events = session.snapshotEvents()
    const restored = Session.create(SessionId(session.id), [...events])
    const original = innerContentOf(restored.snapshotEvents()[resultSeq]!)
    expect(innerTextOf(original)).toBe(bigLogText())
    // The marker's hash still resolves the restored original byte-exact.
    expect(contentHash(original)).toBe(markerHash)
    // The restored surface prices the projected replacement, not the original.
    expect(restored.surface.nodes.includes(SessionSeq(resultSeq))).toBe(false)
    void service
  })

  it('re-lands the full original when only the replacement append fails', async () => {
    const ctx = createContext()
    const service = new ToolResultProjectionService(ctx, { thresholdTokens: 1000, enabled: true })
    const session = fixtureSession(ctx)
    const callId = ToolCallId(`call-${callCounter++}`)
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '"run"' })
    const callSeq = SessionSeq(session.seq - 1)
    const loggerError = vi.spyOn(ctx.logger, 'error')
    await runPostExecute(ctx, session, callId, bigLogText())
    const resultSeq = materializeResult(session, callId, bigLogText(), callSeq)
    // Only the replacement append goes down; the shadow and the compensating
    // re-append succeed, restoring the surface to the full original content.
    const realAppend = session.append.bind(session) as (...args: unknown[]) => unknown
    let replaceFailed = false
    ;(session as unknown as { append: (...args: unknown[]) => unknown }).append = (...args: unknown[]) => {
      const [type, , opts] = args as [string, unknown, { surfaceOp?: unknown } | undefined]
      if (!replaceFailed && type === 'tool/result' && opts?.surfaceOp !== 'append') {
        replaceFailed = true
        throw new Error('append target offline')
      }
      return realAppend(...args)
    }
    try {
      await flush()
    } finally {
      delete (session as unknown as { append?: unknown }).append
    }
    expect(loggerError).toHaveBeenCalled()
    expect(loggerError.mock.calls.some(call => String(call[0]).includes('the full original content was re-appended'))).toBe(true)
    const log = session.snapshotEvents()
    // The shadow landed, no projected replacement exists, and exactly one
    // compensating replacement re-carries the FULL original content.
    expect(log.some(event => event.type === 'compaction/prune'
      && event.seq === resultSeq + 1)).toBe(true)
    expect(log.some(event => event.type === 'tool/result' && event.surfaceOp !== 'append'
      && innerTextOf(innerContentOf(event)).includes('context_retrieve(hash="'))).toBe(false)
    const replaces = log.filter(event => event.type === 'tool/result' && event.surfaceOp !== 'append')
    expect(replaces).toHaveLength(1)
    expect(innerTextOf(innerContentOf(replaces[0]!))).toBe(bigLogText())
    void service
  })

  it('surfaces a partial commit loudly when even the compensating append fails', async () => {
    const ctx = createContext()
    const service = new ToolResultProjectionService(ctx, { thresholdTokens: 1000, enabled: true })
    const session = fixtureSession(ctx)
    const callId = ToolCallId(`call-${callCounter++}`)
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '"run"' })
    const callSeq = SessionSeq(session.seq - 1)
    const loggerError = vi.spyOn(ctx.logger, 'error')
    await runPostExecute(ctx, session, callId, bigLogText())
    const resultSeq = materializeResult(session, callId, bigLogText(), callSeq)
    // The replacement AND the compensating re-append both fail: the partial
    // state (shadow priced, original still current) must be surfaced loudly.
    const realAppend = session.append.bind(session) as (...args: unknown[]) => unknown
    ;(session as unknown as { append: (...args: unknown[]) => unknown }).append = (...args: unknown[]) => {
      const [type, , opts] = args as [string, unknown, { surfaceOp?: unknown } | undefined]
      if (type === 'tool/result' && opts?.surfaceOp !== 'append') {
        throw new Error('append target offline')
      }
      return realAppend(...args)
    }
    try {
      await flush()
    } finally {
      delete (session as unknown as { append?: unknown }).append
    }
    expect(loggerError).toHaveBeenCalled()
    expect(loggerError.mock.calls.some(call => String(call[0]).includes('partial commit at seq'))).toBe(true)
    // The shadow event exists and the original content is still in the log
    // (still the current surface node — nothing was fabricated on top).
    const log = session.snapshotEvents()
    expect(log.some(event => event.type === 'compaction/prune' && event.seq === resultSeq + 1)).toBe(true)
    expect(innerTextOf(innerContentOf(log[resultSeq]!))).toBe(bigLogText())
    expect(log.some(event => event.type === 'tool/result' && event.surfaceOp !== 'append')).toBe(false)
    void service
  })

  it('dispose removes every listener', async () => {
    const ctx = createContext()
    const session = fixtureSession(ctx)
    const { callId } = appendToolResult(session, bigLogText())
    const service = new ToolResultProjectionService(ctx, { thresholdTokens: 1000, enabled: true })
    service.dispose()
    service.dispose()
    await runPostExecute(ctx, session, callId, bigLogText())
    materializeResult(session, callId, bigLogText(), session.seq - 1)
    await flush()
    expect(session.snapshotEvents().some(event => event.type === 'compaction/prune')).toBe(false)
  })

  it('a queued commit after dispose is a no-op', async () => {
    // The candidate is stashed and the commit microtask is already queued
    // when dispose lands: the guard must keep the original byte-exact and
    // append nothing.
    const ctx = createContext()
    const service = new ToolResultProjectionService(ctx, { thresholdTokens: 1000, enabled: true })
    const session = fixtureSession(ctx)
    const { callId } = appendToolResult(session, bigLogText())
    await runPostExecute(ctx, session, callId, bigLogText())
    const resultSeq = materializeResult(session, callId, bigLogText(), session.seq - 1)
    service.dispose()
    await flush()
    const log = session.snapshotEvents()
    expect(log.some(event => event.type === 'compaction/prune')).toBe(false)
    expect(innerTextOf(innerContentOf(log[resultSeq]!))).toBe(bigLogText())
  })

  it('commit failures are loud and keep the original in the log', async () => {
    const ctx = createContext()
    const service = new ToolResultProjectionService(ctx, { thresholdTokens: 1000, enabled: true })
    const session = fixtureSession(ctx)
    const callId = ToolCallId(`call-${callCounter++}`)
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '"run"' })
    const callSeq = SessionSeq(session.seq - 1)
    await runPostExecute(ctx, session, callId, bigLogText())
    const resultSeq = materializeResult(session, callId, bigLogText(), callSeq)
    const loggerError = vi.spyOn(ctx.logger, 'error')
    // The append target goes down between the stash and the queued commit:
    // the commit must fail LOUDLY instead of losing the original silently.
    const realAppend = session.append.bind(session) as (...args: unknown[]) => unknown
    let failing = true
    ;(session as unknown as { append: (...args: unknown[]) => unknown }).append = (...args: unknown[]) => {
      if (failing) throw new Error('append target offline')
      return realAppend(...args)
    }
    try {
      await flush()
    } finally {
      failing = false
      delete (session as unknown as { append?: unknown }).append
    }
    expect(loggerError).toHaveBeenCalled()
    const log = session.snapshotEvents()
    expect(innerTextOf(innerContentOf(log[resultSeq]!))).toBe(bigLogText())
    // No replacement event was fabricated; nothing dangles.
    expect(log.some(event => event.type === 'tool/result' && event.surfaceOp !== 'append')).toBe(false)
    void service
  })
})

describe('hash contract', () => {
  it('contentHash is deterministic, 24 hex, and content-sensitive', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'same' }]
    const other: ContentBlock[] = [{ type: 'text', text: 'other' }]
    expect(contentHash(blocks)).toBe(contentHash([{ type: 'text', text: 'same' }]))
    expect(contentHash(blocks)).toHaveLength(24)
    expect(contentHash(blocks)).not.toBe(contentHash(other))
  })

  it('eventOf narrows log reads for the retrieval seam', () => {
    const ctx = createContext()
    const session = fixtureSession(ctx)
    const { resultSeq } = appendToolResult(session, 'hello')
    const event = eventOf(session.snapshotEvents(), resultSeq, 'tool/result')
    expect(event.data.message.source.callId).toBeDefined()
    void buildMarker
  })
})
