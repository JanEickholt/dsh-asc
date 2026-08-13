/**
 * The four model-facing context tools.
 *
 * `context_compress` commits model-chosen ranges with model-written
 * summaries; `context_decompress` restores compressed content by replaying
 * the log; `context_status` reports usage, checkpoints, tiers, and
 * recommendations; `context_search` runs full-text search over the complete
 * session log — including shadowed (compressed) events.
 *
 * @module @dsh-asc/compaction-agentic/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventSearchRequest, SessionSearchRequest } from '@deepseek-ai/dsh-session-query'
import type { AgenticCompactionEngine } from './engine.ts'
import { textPreview } from './text.ts'

const TOOL_OUTPUT_CHARS = 600

/** The maximum nodes shown in the status tool's recent-surface preview. */
const STATUS_NODES_CAP = 40

/** Render a tool result to plain text without echoing huge payloads. */
function renderText(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: textPreview(JSON.stringify(value, null, 2), TOOL_OUTPUT_CHARS) }]
}

/** The agent-bound execution guard: context tools only run for an agent. */
function requireAgent(exec: ToolRunContext): NonNullable<ToolRunContext['agent']> {
  if (exec.agent === undefined) {
    throw new Error('context tools require an agent-bound tool call')
  }
  return exec.agent
}

/** Register the four context tools on a context. */
export function registerContextTools(ctx: Context, engine: AgenticCompactionEngine): () => void {
  const disposers = [
    ctx.tools.register(defineTool({
      name: 'context_compress',
      description: [
        'Compress ranges of the conversation surface by replacing them with model-written checkpoints.',
        'This is the core context-management tool: pick ranges of surface seqs (see context_status for the current surface and recommendations) whose content is no longer needed verbatim, and write a dense summary for each. The original content stays in the session log and can be restored later with context_decompress.',
        '',
        'Rules:',
        '- Each range must be within the current surface; both seqs must be listed by context_status.',
        '- Ranges cannot include protected content (recent tail, protected tools, protected sources) — such ranges are rejected with a reason.',
        '- The framed checkpoint must be smaller than the shadowed content; too-long summaries are rejected.',
        '- A quality gate may reject catastrophic summaries; retry with acknowledgeRisk: true only if you judge the summary acceptable.',
        '- Compressing a checkpoint of tier N creates a tier N+1 checkpoint (distillation); checkpoints at the tier cap cannot be consumed.',
        '- Never compress the current user instruction or content you still need exactly.',
      ].join('\n'),
      parameters: {
        content: {
          type: 'array',
          required: true,
          description: 'Ranges to compress; each entry carries a topic, an inclusive startSeq/endSeq surface span, and the summary that replaces it.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              topic: { type: 'string', description: 'Short label for the compressed span.' },
              startSeq: { type: 'number', required: true, description: 'First surface seq, inclusive.' },
              endSeq: { type: 'number', required: true, description: 'Last surface seq, inclusive.' },
              summary: { type: 'string', required: true, description: 'The checkpoint summary replacing the range. Preserve file paths, identifiers, decisions, and next steps.' },
            },
          },
        },
        acknowledgeRisk: {
          type: 'boolean',
          description: 'Accept a blocked quality-gate rejection for this exact range set and commit anyway.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            compressed: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  compactionId: { type: 'string', required: true },
                  tier: { type: 'number', required: true },
                  startSeq: { type: 'number', required: true },
                  endSeq: { type: 'number', required: true },
                  shadowedSeqs: { type: 'array', required: true, items: { type: 'number' } },
                  shadowedTokenCount: { type: 'number', required: true },
                  summaryTokenCount: { type: 'number', required: true },
                  author: { type: 'string', required: true },
                },
              },
            },
            failures: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  index: { type: 'number', required: true },
                  reason: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const lines: string[] = []
          for (const entry of value.compressed) {
            lines.push(
              `compressed seqs ${entry.startSeq}..${entry.endSeq} (${entry.shadowedSeqs.length} nodes, `
              + `~${entry.shadowedTokenCount} tokens) into checkpoint ${entry.compactionId} `
              + `(tier ${entry.tier}, ~${entry.summaryTokenCount} summary tokens)`,
            )
          }
          for (const failure of value.failures) {
            lines.push(`entry ${failure.index} failed: ${failure.reason}`)
          }
          if (lines.length === 0) lines.push('nothing compressed')
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args, exec: ToolRunContext) {
        const agent = requireAgent(exec)
        const result = await engine.compressByModel(agent, args.content, {
          ...args.acknowledgeRisk === undefined ? {} : { acknowledgeRisk: args.acknowledgeRisk },
        }, exec.signal)
        return {
          compressed: result.compressed.map(entry => ({
            compactionId: entry.compactionId,
            tier: entry.tier,
            startSeq: entry.startSeq,
            endSeq: entry.endSeq,
            shadowedSeqs: [...entry.shadowedSeqs],
            shadowedTokenCount: entry.shadowedTokenCount,
            summaryTokenCount: entry.summaryTokenCount,
            author: entry.author,
          })),
          failures: result.failures.map(failure => ({ ...failure })),
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'context_decompress',
      description: [
        'Restore previously compressed content into the visible conversation.',
        'Compressed content is never lost: it stays in the session log and is restored by replay. Use this when you need exact details a checkpoint summary cannot provide.',
        '',
        'Two targeting modes (mutually exclusive):',
        '- compactionIds: exact checkpoint ids from context_status (e.g. ["bd2a1c5e-..."]).',
        '- startSeq/endSeq: every checkpoint whose shadowed span overlaps the given surface range is restored.',
        '',
        'Tier-aware restore: by default a checkpoint is restored one tier up (a tier-2 checkpoint reveals its tier-1 summaries). Pass full: true to expand recursively all the way to the original raw content — expensive, use only when necessary.',
        'Restoring inflates context: the combined restored transcript must stay within the configured budget; over-budget targets are skipped and reported.',
      ].join('\n'),
      parameters: {
        compactionIds: {
          type: 'array',
          description: 'Checkpoint ids to restore, from context_status.',
          items: { type: 'string' },
        },
        startSeq: { type: 'number', description: 'Range start (surface seq); restores every overlapping checkpoint.' },
        endSeq: { type: 'number', description: 'Range end (surface seq).' },
        full: {
          type: 'boolean',
          description: 'Expand recursively to raw content. Default false (restore one tier up).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            restored: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  compactionId: { type: 'string', required: true },
                  tier: { type: 'number', required: true },
                  checkpointSeq: { type: 'number', required: true },
                  restoredSeqs: { type: 'array', required: true, items: { type: 'number' } },
                  restoredTokens: { type: 'number', required: true },
                  restoredChars: { type: 'number', required: true },
                  preview: { type: 'string', required: true },
                },
              },
            },
            skipped: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args, value) => {
          const lines: string[] = []
          for (const entry of value.restored) {
            lines.push(
              `restored checkpoint ${entry.compactionId} (tier ${entry.tier}): ${entry.restoredSeqs.length} `
              + `events, ~${entry.restoredTokens} tokens, ${entry.restoredChars} chars`,
            )
            if (entry.preview.length > 0) lines.push(entry.preview)
          }
          for (const skip of value.skipped) lines.push(`skipped: ${skip}`)
          if (lines.length === 0) lines.push('nothing restored')
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args, exec: ToolRunContext) {
        const agent = requireAgent(exec)
        const result = await engine.decompressByModel(agent, {
          ...args.compactionIds === undefined ? {} : { compactionIds: args.compactionIds },
          ...args.startSeq === undefined ? {} : { startSeq: args.startSeq },
          ...args.endSeq === undefined ? {} : { endSeq: args.endSeq },
          ...args.full === undefined ? {} : { full: args.full },
        }, exec.signal)
        return {
          restored: result.restored.map(entry => ({
            compactionId: entry.compactionId,
            tier: entry.tier,
            checkpointSeq: entry.checkpointSeq,
            restoredSeqs: [...entry.restoredSeqs],
            restoredTokens: entry.restoredTokens,
            restoredChars: entry.restoredChars,
            preview: entry.preview,
          })),
          skipped: [...result.skipped],
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'context_status',
      description: [
        'Report the current context state: token usage, surface nodes, compression checkpoints by tier, protected content, and recommended compression ranges.',
        'Use this before context_compress to find valid surface seqs, and after compressing to confirm the new checkpoint.',
        'The recent surface nodes list gives each node its seq, kind, token estimate, tier, and a content preview so you can choose compression ranges.',
      ].join('\n'),
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: renderText,
      },
      async execute(_args, exec: ToolRunContext) {
        const status = await engine.status(requireAgent(exec))
        return summarizeStatus(status) as unknown as JsonValue
      },
    })),

    ctx.tools.register(defineTool({
      name: 'context_search',
      description: [
        'Full-text search over the session log, including content that was compressed (shadowed) into checkpoints.',
        'Compression never deletes content: the original text remains in the log and is fully searchable. A hit reports whether it is still visible on the surface, shadowed by a checkpoint (with the checkpoint id), or log-only.',
        'Scope: "session" searches the current session; "workspace" searches all sessions.',
      ].join('\n'),
      parameters: {
        query: { type: 'string', required: true, description: 'Search text, interpreted as data (not query syntax).' },
        scope: {
          type: 'string',
          enum: ['session', 'workspace'],
          description: 'Search scope. Default "session".',
        },
        limit: { type: 'number', description: 'Maximum hits. Default 20, max 100.' },
      },
      output: {
        schema: { type: 'json' },
        render: renderText,
      },
      async execute(args, exec: ToolRunContext) {
        const agent = requireAgent(exec)
        return searchContext(ctx, agent.session.id, exec, args) as unknown as JsonValue
      },
    })),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** The canonical status payload kept small for the model. */
function summarizeStatus(status: Awaited<ReturnType<AgenticCompactionEngine['status']>>): object {
  return {
    sessionId: status.sessionId,
    usage: {
      totalTokens: status.totalTokens,
      surfaceTokens: status.surfaceTokens,
      baselineKind: status.baselineKind,
      ...status.contextWindow === undefined ? {} : { contextWindow: status.contextWindow },
      ...status.usagePercent === undefined ? {} : { usagePercent: status.usagePercent },
      surfaceNodes: status.surfaceNodes,
    },
    checkpoints: status.checkpoints,
    tierTokens: status.tierTokens,
    protectedSeqs: status.protectedSeqs,
    recommendations: status.recommendations,
    recentNodes: status.recentNodes.slice(-STATUS_NODES_CAP).map(node => ({
      seq: node.seq,
      kind: node.kind,
      tokens: node.tokens,
      tier: node.tier,
      preview: node.preview,
    })),
    ...status.lastCompression === undefined ? {} : { lastCompression: status.lastCompression },
  }
}

/** Full-text search through the optional session-query service. */
async function searchContext(
  ctx: Context,
  sessionId: SessionId,
  exec: ToolRunContext,
  args: { query: string; scope?: string; limit?: number },
): Promise<Record<string, JsonValue>> {
  const sessionQuery = ctx.get('sessionQuery')
  if (sessionQuery === null || sessionQuery === undefined) {
    throw new Error('context_search requires the session-query service (mount dsh-session-query with a backend)')
  }
  const limit = args.limit === undefined ? 20 : Math.max(1, Math.min(100, Math.trunc(args.limit)))
  const scope = args.scope === 'workspace' ? 'workspace' : 'session'
  if (scope === 'session') {
    const request: SessionEventSearchRequest = { sessionId, query: args.query, limit }
    const page = await sessionQuery.searchEvents(request, { signal: exec.signal })
    return {
      scope: 'session',
      query: args.query,
      hits: page.items.map(item => ({
        seq: item.seq,
        type: item.type,
        surface: item.surface,
        snippet: item.snippet,
      })),
    }
  }
  const request: SessionSearchRequest = { query: args.query, limit }
  const page = await sessionQuery.searchSessions(request, { signal: exec.signal })
  return {
    scope: 'workspace',
    query: args.query,
    hits: page.items.map(item => ({
      sessionId: item.header.id,
      seq: item.bestMatch.seq,
      type: item.bestMatch.type,
      surface: item.bestMatch.surface,
      snippet: item.bestMatch.snippet,
    })),
  }
}
