import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AgenticCompactionEngine } from '../src/engine.ts'
import { registerContextTools } from '../src/tools.ts'
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
}

/** A recording registry that captures registrations and honors disposal. */
function recordingRegistry(ctx: Context): { tools: RecordedTool[]; disposeAll(): void } {
  const tools: RecordedTool[] = []
  const disposers: Array<() => void> = []
  ctx.provide('tools', {
    register: (tool: RecordedTool) => {
      tools.push(tool)
      const dispose = (): void => {
        const index = tools.indexOf(tool)
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
  it('registers the four context tools with model-facing schemas', () => {
    const ctx = createContext()
    const registry = recordingRegistry(ctx)
    const engine = new AgenticCompactionEngine(ctx, { auto: false })
    registerContextTools(ctx, engine)

    expect(registry.tools.map(tool => tool.name).sort()).toEqual([
      'context_compress',
      'context_decompress',
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
    expect(registry.tools).toHaveLength(4)
    dispose()
    expect(registry.tools).toHaveLength(0)
    dispose()
    expect(registry.tools).toHaveLength(0)
    void registry.disposeAll
  })
})
