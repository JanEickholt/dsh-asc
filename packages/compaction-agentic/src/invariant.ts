/**
 * Package-owned invariant companion: our events' adjacency and bracket
 * relations over the session log.
 *
 * The `compaction/*` bracket structure itself is enforced by the
 * `@deepseek-ai/dsh-compaction/invariant` companion; this companion owns
 * only the relations of `context/nudge`, `context/decompress`, and
 * `context/compress`:
 *
 * - every `context/nudge` is immediately followed by a `user/message` whose
 *   source is `{ kind: 'plugin', plugin: 'dsh-asc', purpose: 'nudge' }`;
 * - every `context/decompress` is immediately followed by a `user/message`
 *   whose source is the decompress marker with the same `compactionId`;
 * - every `context/compress` matches the enclosing open compaction bracket
 *   and appears only after its `compaction/summary` and before its
 *   `compaction/end`, exactly once per bracket.
 *
 * @module @dsh-asc/compaction-agentic/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from './events.ts'

const PACKAGE_NAME = '@dsh-asc/compaction-agentic'

/** Cordis companion plugin name. */
export const name = 'compaction-agentic-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

interface SessionTrace {
  /** The open compaction bracket's id, when one is open. */
  openCompactionId: string | undefined
  /** Whether the open bracket already recorded its summary. */
  openSummarized: boolean
  /** Whether the open bracket already recorded our authorship event. */
  openRecorded: boolean
  /** A pending nudge record awaiting its adjacent user message. */
  pendingNudge: boolean
  /** A pending decompress record awaiting its adjacent user message. */
  pendingDecompress: string | undefined
}

function seedTrace(session: Session, fail: InvariantFailure): SessionTrace {
  const trace: SessionTrace = {
    openCompactionId: undefined,
    openSummarized: false,
    openRecorded: false,
    pendingNudge: false,
    pendingDecompress: undefined,
  }
  for (const event of session.events) {
    validateEvent(trace, event, fail)
    applyEvent(trace, event)
  }
  return trace
}

/** Validate one event against the trace without mutating it. */
function validateEvent(trace: SessionTrace, event: SessionEvent, fail: InvariantFailure): void {
  if (trace.pendingNudge) {
    const source = event.type === 'user/message'
      ? event.data.source as { kind?: string; plugin?: string; purpose?: string }
      : undefined
    if (source === undefined
      || source.kind !== 'plugin'
      || source.plugin !== 'dsh-asc'
      || source.purpose !== 'nudge') {
      fail('context/nudge must be immediately followed by the adjacent dsh-asc nudge user message')
    }
  }
  if (trace.pendingDecompress !== undefined) {
    const source = event.type === 'user/message'
      ? event.data.source as { kind?: string; plugin?: string; op?: string; compactionId?: string }
      : undefined
    if (source === undefined
      || source.kind !== 'plugin'
      || source.plugin !== 'dsh-asc'
      || source.op !== 'decompress'
      || source.compactionId !== trace.pendingDecompress) {
      fail(`context/decompress for ${trace.pendingDecompress} must be immediately followed by the adjacent dsh-asc restore user message`)
    }
  }

  switch (event.type) {
    case 'compaction/summary':
      if (trace.openCompactionId !== event.data.compactionId) {
        fail(`compaction/summary id ${event.data.compactionId} does not match the open compaction`)
      }
      break
    case 'context/compress': {
      if (trace.openCompactionId !== event.data.compactionId) {
        fail(`context/compress id ${event.data.compactionId} does not match the open compaction`)
      }
      if (!trace.openSummarized) {
        fail('context/compress must follow the compaction/summary of its bracket')
      }
      if (trace.openRecorded) {
        fail('context/compress may appear only once per compaction bracket')
      }
      break
    }
    case 'compaction/end':
      if (trace.openCompactionId !== event.data.compactionId) {
        fail(`compaction/end id ${event.data.compactionId} does not match the open compaction`)
      }
      break
    default:
      break
  }
}

/** Apply one event's trace mutations after it commits. */
function applyEvent(trace: SessionTrace, event: SessionEvent): void {
  switch (event.type) {
    case 'context/nudge':
      trace.pendingNudge = true
      break
    case 'context/decompress':
      trace.pendingDecompress = event.data.compactionId
      break
    case 'compaction/start':
      trace.openCompactionId = event.data.compactionId
      trace.openSummarized = false
      trace.openRecorded = false
      break
    case 'compaction/summary':
      trace.openSummarized = true
      break
    case 'context/compress':
      trace.openRecorded = true
      break
    case 'compaction/end':
      trace.openCompactionId = undefined
      trace.openSummarized = false
      trace.openRecorded = false
      break
    default:
      break
  }
  if (trace.pendingNudge && event.type === 'user/message') trace.pendingNudge = false
  if (trace.pendingDecompress !== undefined && event.type === 'user/message') {
    trace.pendingDecompress = undefined
  }
}

/* jscpd:ignore-start */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const traces = new WeakMap<Session, SessionTrace>()
  const staged = new WeakMap<SessionEvent, { session: Session }>()
  const traceFor = (session: Session): SessionTrace => traces.get(session) ?? seedTrace(session, fail)

  for (const session of ctx.sessions.list()) seedTrace(session, fail)
  ctx.on('session/created', (session) => { seedTrace(session, fail) }, { global: true })
  ctx.on('session/event', (session, event) => {
    const trace = traceFor(session)
    const candidate = staged.get(event)
    if (candidate === undefined || candidate.session !== session) {
      fail('context/* event published without pre-commit validation')
    }
    staged.delete(event)
    applyEvent(trace, event)
  }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const trace = traceFor(session)
    validateEvent(trace, event, fail)
    staged.set(event, { session })
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the package invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
