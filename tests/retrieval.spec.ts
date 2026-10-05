/**
 * context_retrieve behavior tests: byte-exact hash/seq lookup over the
 * session log, shadowed-original reads, and diagnostics instead of
 * fabricated content.
 */

import { describe, expect, it } from 'vitest'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq, SessionStore } from '@deepseek-ai/dsh-session'
import { AgenticCompactionEngine } from '../src/engine/engine.ts'
import { registerContextTools } from '../src/tools/tools.ts'
import { contentHash } from '../src/projection/projection.ts'
import { createContext } from './helpers.ts'

let sessionCounter = 0
let callCounter = 0

interface RecordedTool {
  readonly name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
}

function recordingRegistry(ctx: Parameters<typeof registerContextTools>[0]): {
  handler(name: string): ((args: unknown, exec: unknown) => Promise<unknown>) | undefined
  tool(name: string): {
    output: { render(args: unknown, value: unknown): { type: string; text: string }[] }
  } | undefined
} {
  const handlers = new Map<string, (args: unknown, exec: unknown) => Promise<unknown>>()
  const records = new Map<string, { output: { render(args: unknown, value: unknown): { type: string; text: string }[] } }>()
  ctx.provide('tools', {
    register: (tool: { name: string; execute?: (args: unknown, exec: unknown) => Promise<unknown>; output: { render?: (args: unknown, value: unknown) => unknown[] } }) => {
      if (tool.execute !== undefined) handlers.set(tool.name, tool.execute)
      records.set(tool.name, tool as never)
      return () => undefined
    },
  } as never)
  return { handler: name => handlers.get(name), tool: name => records.get(name) }
}

/** A shadowed oversized tool/result: the durable original of a projection. */
function shadowedOriginal(text: string): { session: Session; hash: string; originalSeq: number } {
  const session = Session.create(SessionId(`retrieval-${sessionCounter++}`))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const callId = ToolCallId(`call-${callCounter++}`)
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '"run"' })
  const callSeq = SessionSeq(session.seq - 1)
  const event = session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text }], isError: false }),
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
  const originalSeq = event.seq
  session.append('compaction/prune', {
    shadowedRange: { start: SessionSeq(originalSeq), end: SessionSeq(originalSeq) },
    shadowedSeqs: [SessionSeq(originalSeq)],
    shadowedTokenCount: 5_000,
  })
  const blocks = event.data.message.content as readonly { type: string; text: string }[]
  const hash = contentHash(blocks as never)
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      ...event.data.message,
      content: [{ type: 'text', text: `[dsh-asc projection: log compressed. Full original (seq ${originalSeq}): context_retrieve(hash="${hash}").]` }],
    },
  }, {
    surfaceOp: { op: 'replace', startSeq: SessionSeq(originalSeq), endSeq: SessionSeq(originalSeq) },
    sourceEventSeqs: [SessionSeq(originalSeq)],
  })
  return { session, hash, originalSeq }
}

describe('context_retrieve', () => {
  it('returns the stored original byte-exact by hash', async () => {
    const ctx = createContext()
    const registry = recordingRegistry(ctx)
    registerContextTools(ctx, new AgenticCompactionEngine(ctx, { auto: false }))
    const text = 'original payload '.repeat(500)
    const { session, hash } = shadowedOriginal(text)
    const retrieve = registry.handler('context_retrieve')!
    const value = await retrieve({ hash }, { agent: { session } }) as {
      found: boolean
      content?: { type: string; text: string }[]
      originalSeq: number
      shadowed: boolean
    }
    expect(value.found).toBe(true)
    expect(value.originalSeq).toBeGreaterThan(0)
    expect(value.shadowed).toBe(true)
    const joined = value.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
    expect(joined).toBe(text)
  })

  it('returns the stored original by seq, live or shadowed', async () => {
    const ctx = createContext()
    const registry = recordingRegistry(ctx)
    registerContextTools(ctx, new AgenticCompactionEngine(ctx, { auto: false }))
    const text = 'seq payload '.repeat(400)
    const { session, originalSeq } = shadowedOriginal(text)
    const retrieve = registry.handler('context_retrieve')!
    const value = await retrieve({ seq: originalSeq }, { agent: { session } }) as { found: boolean; originalSeq: number }
    expect(value.found).toBe(true)
    expect(value.originalSeq).toBe(originalSeq)
  })

  it('diagnoses an unknown hash instead of fabricating content', async () => {
    const ctx = createContext()
    const registry = recordingRegistry(ctx)
    registerContextTools(ctx, new AgenticCompactionEngine(ctx, { auto: false }))
    const { session } = shadowedOriginal('present but queried by wrong hash')
    const retrieve = registry.handler('context_retrieve')!
    const value = await retrieve({ hash: '0123456789abcdef01234567' }, { agent: { session } }) as {
      found: boolean
      diagnostic: string
      content?: unknown
    }
    expect(value.found).toBe(false)
    expect(value.diagnostic).toContain('0123456789abcdef01234567')
    expect(value.content).toBeUndefined()
  })

  it('diagnoses an out-of-range seq', async () => {
    const ctx = createContext()
    const registry = recordingRegistry(ctx)
    registerContextTools(ctx, new AgenticCompactionEngine(ctx, { auto: false }))
    const { session } = shadowedOriginal('present')
    const retrieve = registry.handler('context_retrieve')!
    const value = await retrieve({ seq: 9_999 }, { agent: { session } }) as { found: boolean; diagnostic: string }
    expect(value.found).toBe(false)
    expect(value.diagnostic).toContain('no event at seq')
  })

  it('throws when neither hash nor seq is given', async () => {
    const ctx = createContext()
    const registry = recordingRegistry(ctx)
    registerContextTools(ctx, new AgenticCompactionEngine(ctx, { auto: false }))
    const { session } = shadowedOriginal('present')
    const retrieve = registry.handler('context_retrieve')!
    await expect(retrieve({}, { agent: { session } })).rejects.toThrow()
  })

  it('renders found originals and diagnostics as tool text output', async () => {
    const ctx = createContext()
    const registry = recordingRegistry(ctx)
    registerContextTools(ctx, new AgenticCompactionEngine(ctx, { auto: false }))
    const record = registry.tool('context_retrieve')!
    const text = 'render payload '.repeat(50)
    const { session, hash } = shadowedOriginal(text)
    const retrieve = registry.handler('context_retrieve')!
    const found = await retrieve({ hash }, { agent: { session } })
    const foundBlocks = record.output.render({ hash }, found)
    expect(foundBlocks[0]?.type).toBe('text')
    expect(foundBlocks.some(block => block.text.includes('render payload'))).toBe(true)
    const miss = await retrieve({ hash: '0123456789abcdef01234567' }, { agent: { session } })
    const missBlocks = record.output.render({ hash: '0123456789abcdef01234567' }, miss)
    expect(missBlocks[0]?.text).toContain('0123456789abcdef01234567')
  })
})
