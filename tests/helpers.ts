/**
 * Shared test fixtures: contexts, sessions, agents, and fake LLM adapters.
 */

import { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmRuntime,
  createAssistantMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

export const MODEL = 'test-model'
export const SIGNAL: AbortSignal = new AbortController().signal

let sessionCounter = 0

/** A context with the LLM seam, token meter, and one registered adapter. */
export function createContext(contextWindow = 100_000, summaryText = ''): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  void new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], new FakeAdapter(contextWindow, summaryText))
  return ctx
}

/** An adapter that reports a window and streams one optional text block. */
class FakeAdapter extends LlmAdapter {
  constructor(
    private readonly contextWindow: number,
    private readonly summaryText: string,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    if (this.summaryText.length > 0) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: this.summaryText }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: this.summaryText } }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A detached session with closed turns plus one open final turn. */
export function conversationSession(
  turns = 4,
  text = 'fixture content '.repeat(30).trim(),
): Session {
  const session = Session.create(SessionId(`conversation-${sessionCounter++}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
      session.append('request/context', { provider: MODEL, model: MODEL, contextWindow: 100_000 })
    }
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `answer ${turn} ` + 'detail '.repeat(20) }],
        source: { provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    if (turn < turns) {
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
  }
  return session
}

/** A fully closed session (no open turn) with the given number of turns. */
export function closedSession(turns = 3, text = 'fixture content '.repeat(30).trim()): Session {
  const session = Session.create(SessionId(`closed-${sessionCounter++}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `answer ${turn}` }],
        source: { provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session
}

/** A minimal agent stub over a session. */
export function agentOf(session: Session, model = MODEL): Agent {
  return { session, options: { provider: model, model } } as Agent
}

/** Narrow one log event to an exact type, failing on mismatch. */
export function eventOf<T extends import('@deepseek-ai/dsh-session').SessionEventType>(
  events: readonly import('@deepseek-ai/dsh-session').SessionEvent[],
  seq: number,
  type: T,
): import('@deepseek-ai/dsh-session').SessionEvent<T> {
  const event = events[seq]
  if (event === undefined || event.type !== type) {
    throw new Error(`expected event ${type} at seq ${seq}, got ${event?.type ?? 'none'}`)
  }
  // The caller asserted the discriminant; tests deliberately read exact payloads.
  return event as import('@deepseek-ai/dsh-session').SessionEvent<T>
}
