/**
 * Deterministic fallback summarization.
 *
 * When overflow recovery or manual compaction needs an automatic summary,
 * the engine falls back to one `ctx.llm.stream()` call whose prefix reuses
 * the conversation's own system prompt, tools, and leading messages — a
 * genuine prefix of the last routed request, so the provider's KV cache is
 * reused instead of invalidated. The summary is then committed through the
 * same durable transaction as a model-written summary.
 *
 * @module dsh-asc/fallback
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  Message,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { CompactionAgentContext } from '@deepseek-ai/dsh-compaction'
import type { ResolvedConfig } from '../types.ts'

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'

/** The summarization directive delivered as the final user message. */
const FALLBACK_INSTRUCTION = [
  'You are the compaction engine for an AI coding assistant. Condense the conversation ABOVE into one structured checkpoint that lets another model continue the work with no loss of essential context.',
  '',
  'Output Markdown with exactly the sections below, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  '## Key Technical Concepts',
  '## Files and Code',
  '## Errors and Fixes',
  '## Pending Jobs',
  '## Current Work',
  '## Next Step',
  '## Critical Context',
  '',
  'Rules:',
  '- Preserve exact file paths, commands, error strings, identifiers, numeric values, and signatures.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do not mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation above already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint: `
  + 'do not copy it forward verbatim — keep still-true facts, drop stale ones, and merge newer '
  + 'information into one consolidated summary under the same structure.',
].join('\n')

/** The replayed conversation prefix the fallback condenses. */
export interface FallbackInput {
  /** The conversation's own system prompt, reused for prefix-cache alignment. */
  readonly system?: string
  /** The conversation's tool schemas, reused for prefix-cache alignment. */
  readonly tools?: readonly ToolSchema[]
  /** The shadowed region, in surface order, that precedes the instruction. */
  readonly messages: readonly Message[]
}

/** Safe summary content plus the exact auxiliary call envelope. */
export interface FallbackSummary {
  readonly summary: ContentBlock[]
  readonly provider: string
  readonly model: string
  readonly maxTokens: number
  /** Provider-reported usage for this summarization request, when emitted. */
  readonly usage?: TokenUsage
  /** Complete provider output before the text-only projection. */
  readonly rawOutput: ContentBlock[]
}

/**
 * Run the cache-reusing fallback summarization call.
 * @param ctx - context providing the LLM service.
 * @param config - resolved backend configuration.
 * @param input - replayed conversation prefix to condense.
 * @param agent - supplies the routed-model history and session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns the safe text-only summary and its call envelope.
 */
export async function summarizeWithLlm(
  ctx: Context,
  config: ResolvedConfig,
  input: FallbackInput,
  agent: CompactionAgentContext,
  signal?: AbortSignal,
): Promise<FallbackSummary> {
  const configured = config.fallback.summarizationProvider.length === 0
    ? undefined
    : { provider: config.fallback.summarizationProvider, model: config.fallback.summarizationModel }
  const latest = agent.session.requestHeader()?.config
  const agentTarget = agent.options.provider !== undefined
    && agent.options.provider.length > 0
    && agent.options.model !== undefined
    && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? latest ?? agentTarget
  if (target === undefined) {
    throw new Error(
      'no provider/model available for fallback summarization: set both fallback '
      + 'summarization fields, route one request, or set both AgentOptions fields',
    )
  }

  const assembler = new BlockAssembler()
  const messages: Message[] = [
    ...input.messages,
    createUserMessage({
      content: [{ type: 'text', text: FALLBACK_INSTRUCTION }],
      source: { kind: 'plugin', plugin: 'dsh-asc' },
    }),
  ]
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages,
    ...input.system === undefined ? {} : { system: input.system },
    ...input.tools === undefined ? {} : { tools: [...input.tools] },
    maxTokens: config.fallback.maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...signal === undefined ? {} : { signal },
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error

  const rawOutput = assembler.blocks()
  const summary = rawOutput.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
  if (!summary.some(block => block.text.trim().length > 0)) {
    throw new Error('fallback summarization produced no text summary content')
  }
  return {
    summary,
    rawOutput,
    provider: options.provider,
    model: options.model,
    maxTokens: config.fallback.maxTokens,
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
  }
}

/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('fallback summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}
