import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AgenticCompactionEngine } from '../src/engine/engine.ts'
import { registerContextTools } from '../src/tools/tools.ts'
import { createContext } from './helpers.ts'

interface RecordedTool {
  readonly name: string
  readonly description: string
  /** Compiled JSON-schema parameter object. */
  readonly parameters: {
    type?: string
    properties?: Record<string, {
      type?: string
      required?: boolean
      enum?: string[]
    }>
    required?: string[]
  }
  readonly output: {
    render(args: unknown, value: unknown): { type: string; text: string }[]
  }
}

/** A recording registry that captures registrations and honors disposal. */
function recordingRegistry(ctx: Context): { tools: RecordedTool[]; disposeAll(): void } {
  const tools: RecordedTool[] = []
  const disposers: Array<() => void> = []
  ctx.provide('tools', {
    register: (tool: RecordedTool & { output: { render?: (args: unknown, value: unknown) => unknown[] } }) => {
      const recorded: RecordedTool = {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        output: tool.output as RecordedTool['output'],
      }
      tools.push(recorded)
      const dispose = (): void => {
        const index = tools.indexOf(recorded)
        if (index !== -1) tools.splice(index, 1)
      }
      disposers.push(dispose)
      return dispose
    },
  } as never)
  return {
    tools,
    disposeAll: () => { for (const dispose of disposers) dispose() },
  }
}

describe('registerContextTools', () => {
  it('registers the five context tools with model-facing schemas', () => {
    const ctx = createContext()
    const registry = recordingRegistry(ctx)
    const engine = new AgenticCompactionEngine(ctx, { auto: false })
    registerContextTools(ctx, engine)

    expect(registry.tools.map(tool => tool.name).sort()).toEqual([
      'context_compress',
      'context_decompress',
      'context_recap',
      'context_search',
      'context_status',
    ])

    const compress = registry.tools.find(tool => tool.name === 'context_compress')!
    const content = compress.parameters.properties?.content
    expect(compress.parameters.type).toBe('object')
    expect(content?.type).toBe('array')
    expect(compress.parameters.required).toContain('content')
    expect(compress.description).toContain('context_status')

    const search = registry.tools.find(tool => tool.name === 'context_search')!
    expect(search.parameters.required).toContain('query')
    expect(search.parameters.properties?.scope?.enum).toEqual(['session', 'workspace'])
  })

  it('unregisters every tool on disposal', () => {
    const ctx = createContext()
    const registry = recordingRegistry(ctx)
    const engine = new AgenticCompactionEngine(ctx, { auto: false })
    const dispose = registerContextTools(ctx, engine)
    expect(registry.tools).toHaveLength(5)
    dispose()
    expect(registry.tools).toHaveLength(0)
    dispose()
    expect(registry.tools).toHaveLength(0)
    void registry.disposeAll
  })

  it('renders the canonical VALUE, not the arguments', () => {
    const ctx = createContext()
    const registry = recordingRegistry(ctx)
    const engine = new AgenticCompactionEngine(ctx, { auto: false })
    registerContextTools(ctx, engine)
    const status = registry.tools.find(tool => tool.name === 'context_status')!
    const search = registry.tools.find(tool => tool.name === 'context_search')!
    const value = { scope: 'session', query: 'needle', hits: [{ seq: 1, surface: 'shadowed' }] }
    // defineTool calls render(args, value): a one-argument renderer would
    // serialize the args and silently drop the actual result.
    const rendered = search.output.render({}, value as never)
    const text = rendered.map(block => (block as { text: string }).text).join('')
    expect(text).toContain('"hits"')
    expect(text).toContain('"shadowed"')
    expect(text).not.toContain('"scope":"workspace"')
    void status
    void engine
  })

  it('renders context_status with recent nodes first and one line per node', () => {
    const ctx = createContext()
    const registry = recordingRegistry(ctx)
    const engine = new AgenticCompactionEngine(ctx, { auto: false })
    registerContextTools(ctx, engine)
    const status = registry.tools.find(tool => tool.name === 'context_status')!
    const value = {
      sessionId: 's1',
      usage: { totalTokens: 100, surfaceTokens: 40 },
      recentNodes: [{
        seq: 7,
        position: 0,
        kind: 'tool',
        tokens: 55,
        tier: 0,
        protected: false,
        preview: 'huge output body',
      }],
      recommendations: [],
      checkpoints: [],
      tierTokens: {},
      protectedSeqs: [],
    }
    const text = status.output.render({}, value)
      .map(block => (block as { text: string }).text).join('')
    expect(text.indexOf('Recent surface nodes')).toBeLessThan(text.indexOf('Usage'))
    expect(text).toContain('seq 7 pos 0 tool 55t tier 0')
    expect(text).toContain('huge output body')
  })

  it('renders toFile restores as written paths, not in-place restores', () => {
    const ctx = createContext()
    const registry = recordingRegistry(ctx)
    const engine = new AgenticCompactionEngine(ctx, { auto: false })
    registerContextTools(ctx, engine)
    const decompress = registry.tools.find(tool => tool.name === 'context_decompress')!
    const entry = {
      compactionId: 'cp-1',
      tier: 1,
      checkpointSeq: 10,
      restoredSeqs: [1, 2],
      restoredTokens: 100,
      restoredChars: 400,
      preview: 'written to /tmp/restore-1.txt (400 chars)',
      path: '/tmp/restore-1.txt',
    }
    const text = decompress.output.render({}, { restored: [entry], skipped: [] })
      .map(block => (block as { text: string }).text).join('')
    expect(text).toContain('/tmp/restore-1.txt')
    expect(text).toContain('the checkpoint stays compressed')
    expect(text).not.toContain('content is back in the surface')
  })
})
