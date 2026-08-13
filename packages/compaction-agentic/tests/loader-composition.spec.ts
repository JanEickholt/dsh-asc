import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { InvariantRegistry } from '@deepseek-ai/dsh-invariants'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { AgenticCompactionEngine } from '../src/engine.ts'
import * as pluginEntry from '../src/index.ts'
import * as invariantCompanion from '../src/invariant.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-asc-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-token-meter', TokenMeter],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-invariants', InvariantRegistry],
    ['@deepseek-ai/dsh-compaction-tool-result-pruner', ToolResultPruner],
    ['@dsh-asc/compaction-agentic', pluginEntry],
    ['@dsh-asc/compaction-agentic/invariant', invariantCompanion],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  it('mounts the engine, the four tools, and the invariant companion', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-token-meter'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-invariants'",
      "- name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
      "  config:",
      "    thresholdChars: 20000",
      "    headChars: 5000",
      "    tailChars: 100",
      "- name: '@dsh-asc/compaction-agentic'",
      '  config:',
      '    auto: false',
      '    nudge:',
      '      maxRatio: 0.75',
      "    tiers:",
      "      maxTier: 2",
      "- name: '@dsh-asc/compaction-agentic/invariant'",
    ])

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const engine = loaded.get('compaction') as AgenticCompactionEngine
    expect(engine).toBeInstanceOf(AgenticCompactionEngine)
    expect(engine.config.nudge.maxRatio).toBe(0.75)
    expect(engine.config.tiers.maxTier).toBe(2)
    expect(engine.config.auto).toBe(false)

    const toolNames = loaded.tools.schemas().map(schema => schema.name).sort()
    expect(toolNames).toEqual([
      'context_compress',
      'context_decompress',
      'context_search',
      'context_status',
    ])

    // The pruner is an optional sibling and the engine sees it.
    expect(loaded.get('toolResultPruner')).toBeInstanceOf(ToolResultPruner)
  })

  it('rejects unknown config keys through the engine schema', async () => {
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(SessionStore)
    await context.plugin(TokenMeter)
    await context.plugin(SystemPrompt)
    await context.plugin(ToolRuntime)
    await context.plugin(InvariantRegistry)
    await expect(context.plugin(pluginEntry, {
      bogus: true,
    } as never)).rejects.toThrow(/unknown key "bogus"/)
  })

  it('the invariant companion vetoes corrupt log writes in the composed app', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-token-meter'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-invariants'",
      "- name: '@dsh-asc/compaction-agentic'",
      '  config:',
      '    auto: false',
      "- name: '@dsh-asc/compaction-agentic/invariant'",
    ])
    const session = loaded.sessions.create()
    session.append('context/nudge', {
      kind: 'pressure',
      totalTokens: 10,
      surfaceTokens: 10,
      growthSinceBaseline: 5,
    })
    expect(() => session.append('user/message', {
      role: 'user',
      id: 'm-1',
      content: [{ type: 'text', text: 'ordinary' }],
      source: { kind: 'user' },
    } as never, { surfaceOp: 'append' })).toThrow(/context\/nudge must be immediately followed/)
  })
})
