/**
 * The five model-facing context tools.
 *
 * `context_compress` commits model-chosen ranges with model-written
 * summaries; `context_decompress` restores compressed content by replaying
 * the log; `context_recap` re-reads checkpoint summaries; `context_status`
 * reports usage, checkpoints, tiers, and recommendations; `context_search`
 * runs full-text search over the complete session log — including shadowed
 * (compressed) events.
 *
 * @module dsh-asc/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventSearchRequest, SessionSearchRequest } from '@deepseek-ai/dsh-session-query'
import type { AgenticCompactionEngine } from '../engine/engine.ts'
import { tierSnapshot } from '../engine/tier.ts'
import { textPreview } from '../utils/text.ts'

const TOOL_OUTPUT_CHARS = 8000

/** The maximum nodes shown in the status tool's recent-surface preview. */
const STATUS_NODES_CAP = 40

/** Compact JSON renderer: no indentation, so the 8000-char cap fits more rows. */
function renderCompactJson(args: unknown, value: unknown): { type: 'text'; text: string }[] {
  void args
  return [{ type: 'text', text: textPreview(JSON.stringify(value) ?? 'null', TOOL_OUTPUT_CHARS) }]
}

/**
 * One-line-per-node status renderer. `recentNodes` and recommendations come
 * first because they are the fields the model uses to choose compress
 * ranges; pretty JSON would put them at the tail and truncate them.
 */
function renderStatus(args: unknown, value: unknown): { type: 'text'; text: string }[] {
  void args
  const status = value as {
    sessionId?: string
    usage?: Record<string, unknown>
    breakdown?: Record<string, unknown>
    checkpoints?: Array<Record<string, unknown>>
    tierTokens?: Record<string, number>
    protectedSeqs?: number[]
    recommendations?: Array<Record<string, unknown>>
    recentNodes?: Array<Record<string, unknown>>
    lastCompression?: Record<string, unknown>
  }
  const lines: string[] = []
  const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

  if (Array.isArray(status.recentNodes) && status.recentNodes.length > 0) {
    lines.push(`Recent surface nodes (${status.recentNodes.length}):`)
    for (const node of status.recentNodes) {
      lines.push(oneLine(
        `- seq ${String(node.seq)} pos ${String(node.position)} ${String(node.kind)} `
        + `${String(node.tokens)}t tier ${String(node.tier)}${node.protected === true ? ' [protected]' : ''} `
        + `| ${String(node.preview ?? '')}`,
      ))
    }
  }
  if (Array.isArray(status.recommendations) && status.recommendations.length > 0) {
    lines.push('Recommended ranges:')
    for (const range of status.recommendations) {
      lines.push(oneLine(
        `- seqs ${String(range.startSeq)}..${String(range.endSeq)} `
        + `(positions ${String(range.startPosition)}..${String(range.endPosition)}, `
        + `~${String(range.tokens)} tokens): ${String(range.reason)}`,
      ))
    }
  }
  lines.push(`Usage: ${JSON.stringify(status.usage ?? {})}`)
  if (status.breakdown !== undefined) lines.push(`Breakdown: ${JSON.stringify(status.breakdown)}`)
  if (Array.isArray(status.checkpoints) && status.checkpoints.length > 0) {
    lines.push('Checkpoints:')
    for (const checkpoint of status.checkpoints) {
      const shadowed = Array.isArray(checkpoint.shadowedSeqs) ? String(checkpoint.shadowedSeqs) : '[]'
      lines.push(oneLine(
        `- ${String(checkpoint.compactionId)} tier ${String(checkpoint.tier)} `
        + `seq ${String(checkpoint.seq)} author ${String(checkpoint.author)} `
        + `shadowed ${String(checkpoint.shadowedTokenCount)}t ${shadowed} chars ${String(checkpoint.summaryChars)}`,
      ))
    }
  }
  if (status.tierTokens !== undefined) lines.push(`Tier tokens: ${JSON.stringify(status.tierTokens)}`)
  if (Array.isArray(status.protectedSeqs)) lines.push(`Protected seqs: ${status.protectedSeqs.join(',')}`)
  if (status.lastCompression !== undefined) lines.push(`Last compression: ${JSON.stringify(status.lastCompression)}`)
  return [{ type: 'text', text: textPreview(lines.join('\n'), TOOL_OUTPUT_CHARS) }]
}

/** The agent-bound execution guard: context tools only run for an agent. */
function requireAgent(exec: ToolRunContext): NonNullable<ToolRunContext['agent']> {
  if (exec.agent === undefined) {
    throw new Error('context tools require an agent-bound tool call')
  }
  return exec.agent
}

/** Register the five context tools on a context. */
export function registerContextTools(ctx: Context, engine: AgenticCompactionEngine): () => void {
  const disposers: Array<() => void> = []
  try {
    disposers.push(ctx.tools.register(defineTool({
      name: 'context_compress',
      description: [
        'Compress ranges of the conversation surface by replacing them with model-written checkpoints.',
        'This is the core context-management tool: pick ranges of surface seqs (see context_status for the current surface and recommendations) whose content is no longer needed verbatim, and write a dense summary for each. The original content stays in the session log and can be restored later with context_decompress. Up to 64 ranges per call.',
        '',
        'Rules:',
        '- Surface seqs are EVENT SEQUENCE NUMBERS, not positions: they do not sort by size. The current surface order is reported by context_status. Positions are 0-based surface positions (0 = the oldest current surface node); recentNodes only shows the last 40 nodes and each entry carries its own position.',
        '- Each range must be within the current surface; verify seqs with context_status (recentNodes only shows the last 40 nodes — recommendations can cover older ranges).',
        '- Ranges cannot include protected content (recent tail, protected tools, protected sources) — such ranges are rejected with a reason.',
        '- The framed checkpoint must be smaller than the shadowed content; too-long summaries are rejected.',
        '- A quality gate may reject catastrophic summaries; retry with acknowledgeRisk: true only if you judge the summary acceptable. (acknowledgeRisk may be passed as a top-level option or inside each content entry — some transports only carry the array.)',
        '- Compressing a checkpoint of tier N creates a tier N+1 checkpoint (distillation); checkpoints at the tier cap cannot be consumed.',
        '- Never compress the current user instruction or content you still need exactly.',
      ].join('\n'),
      parameters: {
        content: {
          type: 'array',
          required: true,
          description: 'Ranges to compress; each entry carries an optional topic, an inclusive startSeq/endSeq surface span, and the summary that replaces it.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              topic: { type: 'string', description: 'Short label for the compressed span.' },
              startSeq: { type: 'number', required: true, description: 'First surface seq, inclusive.' },
              endSeq: { type: 'number', required: true, description: 'Last surface seq, inclusive.' },
              summary: { type: 'string', required: true, description: 'The checkpoint summary replacing the range. Preserve file paths, identifiers, decisions, and next steps.' },
              acknowledgeRisk: { type: 'boolean', description: 'Accept a blocked quality-gate rejection for this entry and commit anyway.' },
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
                  topic: { type: 'string', description: 'The topic label supplied on this range entry.' },
                  expandedFrom: {
                    type: 'object',
                    additionalProperties: true,
                    properties: {
                      startSeq: { type: 'number', required: true },
                      endSeq: { type: 'number', required: true },
                    },
                  },
                  quality: {
                    type: 'object',
                    additionalProperties: true,
                    description: 'Quality-gate report; present when the gate evaluated this summary.',
                    properties: {
                      gate: { type: 'string', required: true },
                      passed: { type: 'boolean', required: true },
                      blocking: { type: 'boolean' },
                      layer: { type: 'string' },
                      note: { type: 'string' },
                    },
                  },
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
            const expanded = entry.expandedFrom === undefined
              ? ''
              : ` (extended from seqs ${entry.expandedFrom.startSeq}..${entry.expandedFrom.endSeq} `
                + 'to keep tool calls paired with their results)'
            const topic = entry.topic === undefined ? '' : ` [${entry.topic}]`
            const quality = entry.quality === undefined
              ? ''
              : entry.quality.passed
                ? ' (quality gate passed)'
                : ` (quality gate ${entry.quality.blocking ? 'failed (blocking was acknowledged)' : 'recorded a failure'})`
            lines.push(
              `compressed seqs ${entry.startSeq}..${entry.endSeq} (${entry.shadowedSeqs.length} nodes, `
              + `~${entry.shadowedTokenCount} tokens) into checkpoint ${entry.compactionId} `
              + `(tier ${entry.tier}, ~${entry.summaryTokenCount} summary tokens)${topic}${expanded}${quality}`,
            )
          }
          for (const failure of value.failures) {
            lines.push(`entry ${failure.index} failed: ${failure.reason}`)
          }
          if (lines.length === 0) lines.push('nothing compressed')
          if (value.compressed.length > 0 && value.failures.length > 0) {
            lines.push(
              `${value.compressed.length} entr${value.compressed.length === 1 ? 'y' : 'ies'} committed; `
              + `${value.failures.length} failed (see reasons above). Run context_status to re-verify `
              + 'the surface before retrying failed ranges.',
            )
          }
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
            ...entry.topic === undefined ? {} : { topic: entry.topic },
            ...entry.expandedFrom === undefined
              ? {}
              : { expandedFrom: { ...entry.expandedFrom } },
            ...entry.quality === undefined
              ? {}
              : {
                quality: {
                  gate: entry.quality.gate,
                  passed: entry.quality.passed,
                  blocking: entry.quality.blocking,
                  layer: String(entry.quality.layer),
                  ...entry.quality.note === undefined ? {} : { note: entry.quality.note },
                },
              },
          })),
          failures: result.failures.map(failure => ({ ...failure })),
        }
      },
    })));

    disposers.push(ctx.tools.register(defineTool({
      name: 'context_decompress',
      description: [
        'Restore previously compressed content.',
        'Compressed content is never lost: it stays in the session log and is restored by replay. Use this when you need exact details a checkpoint summary cannot provide.',
        'By default the restored transcript is committed back INTO the surface at the checkpoint\'s own position — the compression is undone, and the original content appears where it used to be in your next context window. The tool result reports statistics and a preview only.',
        'With toFile, the transcript is written to that path through the filesystem service and the checkpoint stays compressed — use for very large restores that would otherwise inflate context; the result reports the path. Multiple targets get derived sibling paths so none overwrites another.',
        '',
        'Two targeting modes (mutually exclusive):',
        '- compactionIds: exact checkpoint ids from context_status (e.g. ["bd2a1c5e-..."]). Array-only transports may pass the bare id array.',
        '- startSeq/endSeq: every checkpoint whose current surface position (the position of its collapsed shadowed span) lies inside the given range is restored.',
        '',
        'Tier-aware restore: by default a checkpoint is restored one tier up (a tier-2 checkpoint reveals its tier-1 summaries). Pass full: true to expand recursively all the way to the original raw content — expensive, use only when necessary.',
        'Restoring inflates context: the combined restored transcript must stay within the configured token budget; over-budget targets are skipped and reported. The configured maxBlocks bound is a hard per-call limit.',
      ].join('\n'),
      parameters: {
        compactionIds: {
          type: 'array',
          description: 'Checkpoint ids to restore, from context_status.',
          items: { type: 'string' },
        },
        content: {
          type: 'array',
          description: 'Array-only transport alias for compactionIds: pass the bare id array and it is treated as the checkpoint list.',
          items: { type: 'string' },
        },
        startSeq: { type: 'number', description: 'Range start (surface seq); restores checkpoints whose current surface position lies inside the range.' },
        endSeq: { type: 'number', description: 'Range end (surface seq).' },
        full: {
          type: 'boolean',
          description: 'Expand recursively to raw content. Default false (restore one tier up).',
        },
        toFile: {
          type: 'string',
          description: 'Write the restored transcript to this path through the filesystem service instead of restoring in place; the checkpoint stays compressed. Requires a mounted fs provider.',
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
                  path: { type: 'string', description: 'File written by toFile mode; absent for in-place restores.' },
                },
              },
            },
            skipped: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args, value) => {
          const lines: string[] = []
          for (const entry of value.restored) {
            if (entry.path !== undefined) {
              lines.push(
                `wrote checkpoint ${entry.compactionId} (tier ${entry.tier}): ${entry.restoredSeqs.length} `
                + `events, ~${entry.restoredTokens} tokens, ${entry.restoredChars} chars — content is in `
                + `${entry.path}; the checkpoint stays compressed`,
              )
            } else {
              lines.push(
                `restored checkpoint ${entry.compactionId} (tier ${entry.tier}): ${entry.restoredSeqs.length} `
                + `events, ~${entry.restoredTokens} tokens, ${entry.restoredChars} chars — content is back `
                + 'in the surface at its original position',
              )
            }
            if (entry.preview.length > 0) lines.push(`preview: ${entry.preview}`)
          }
          for (const skip of value.skipped) lines.push(`skipped: ${skip}`)
          if (lines.length === 0) lines.push('nothing restored')
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args, exec: ToolRunContext) {
        const agent = requireAgent(exec)
        // Array-only transports wrap the single array parameter as
        // `{"content": [...]}` (the same convention context_compress uses for
        // its content array); treat that as the compaction-id list.
        const compactionIds = args.compactionIds !== undefined
          ? args.compactionIds
          : Array.isArray(args.content) ? args.content : undefined
        const result = await engine.decompressByModel(agent, {
          ...compactionIds === undefined ? {} : { compactionIds },
          ...args.startSeq === undefined ? {} : { startSeq: args.startSeq },
          ...args.endSeq === undefined ? {} : { endSeq: args.endSeq },
          ...args.full === undefined ? {} : { full: args.full },
          ...args.toFile === undefined ? {} : { toFile: args.toFile },
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
            ...entry.path === undefined ? {} : { path: entry.path },
          })),
          skipped: [...result.skipped],
        }
      },
    })));

    disposers.push(ctx.tools.register(defineTool({
      name: 'context_recap',
      description: [
        'Re-fetch checkpoint summaries WITHOUT decompressing the original content.',
        'Use when a past context_compress call\'s summary has scrolled out of context or you need to recall what a checkpoint covers before deciding to decompress it.',
        'Summaries are read from the durable session log, so they survive even when the compress call that wrote them is gone; explicit ids also resolve checkpoints that a later compression consumed.',
        'Args: compactionIds — optional list of checkpoint ids (from context_status). Omitted = recap every checkpoint on the current surface; unknown ids are omitted.',
      ].join('\n'),
      parameters: {
        compactionIds: {
          type: 'array',
          description: 'Checkpoint ids to recap, from context_status. Omitted = recap every checkpoint on the current surface.',
          items: { type: 'string' },
        },
      },
      output: {
        schema: { type: 'json' },
        render: renderCompactJson,
      },
      async execute(args, exec: ToolRunContext) {
        const agent = requireAgent(exec)
        const recapped = await engine.recapByModel(agent, args.compactionIds)
        return recapped as unknown as JsonValue
      },
    })));

    disposers.push(ctx.tools.register(defineTool({
      name: 'context_status',
      description: [
        'Report the current context state: token usage, surface nodes, compression checkpoints by tier, protected content, and recommended compression ranges.',
        'Use this before context_compress to find valid surface seqs, and after compressing to confirm the new checkpoint.',
        'The recent surface nodes list shows the last 40 nodes with seq, 0-based surface position, kind, token estimate, tier, protection flag, and a content preview so you can choose compression ranges. Positions are full surface positions (0 = oldest current surface node).',
      ].join('\n'),
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: renderStatus,
      },
      async execute(_args, exec: ToolRunContext) {
        const status = await engine.status(requireAgent(exec))
        return summarizeStatus(status) as unknown as JsonValue
      },
    })));

    disposers.push(ctx.tools.register(defineTool({
      name: 'context_search',
      description: [
        'Full-text search over the session log, including content that was compressed (shadowed) into checkpoints.',
        'Compression never deletes content: the original text remains in the log and is fully searchable. A hit reports whether it is still current on the surface, shadowed by a checkpoint, or log-only. Session-scope shadowed hits also carry the owning checkpointId so you can decompress or recap it.',
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
        render: renderCompactJson,
      },
      async execute(args, exec: ToolRunContext) {
        const agent = requireAgent(exec)
        return searchContext(ctx, agent.session.id, exec, args) as unknown as JsonValue
      },
    })));
  } catch (error: unknown) {
    for (const dispose of disposers) dispose()
    throw error
  }
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
      baselineTokens: status.baselineTokens,
      ...status.contextWindow === undefined ? {} : { contextWindow: status.contextWindow },
      ...status.usagePercent === undefined ? {} : { usagePercent: status.usagePercent },
      surfaceNodes: status.surfaceNodes,
    },
    checkpoints: status.checkpoints,
    tierTokens: status.tierTokens,
    ...status.breakdown === undefined ? {} : { breakdown: status.breakdown },
    protectedSeqs: status.protectedSeqs,
    recommendations: status.recommendations,
    recentNodes: status.recentNodes.slice(-STATUS_NODES_CAP).map(node => ({
      seq: node.seq,
      position: node.position,
      kind: node.kind,
      tokens: node.tokens,
      tier: node.tier,
      protected: node.protected,
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
  if (typeof args.query !== 'string' || args.query.trim().length === 0) {
    throw new Error('context_search requires a non-empty query')
  }
  const query = args.query
  const requestedLimit = typeof args.limit === 'number' && Number.isFinite(args.limit)
    ? Math.trunc(args.limit)
    : 20
  const limit = Math.max(1, Math.min(100, requestedLimit))
  if (args.scope !== undefined && args.scope !== 'session' && args.scope !== 'workspace') {
    throw new Error(`context_search scope must be "session" or "workspace", got ${JSON.stringify(args.scope)}`)
  }
  const scope = args.scope === 'workspace' ? 'workspace' : 'session'
  if (scope === 'session') {
    const request: SessionEventSearchRequest = { sessionId, query, limit }
    const page = await sessionQuery.searchEvents(request, { signal: exec.signal })
    const session = ctx.sessions.get(sessionId)
    let ownerBySeq: ReadonlyMap<number, string> | undefined
    if (session !== undefined) {
      const owners = new Map<number, string>()
      for (const [checkpointSeq, shadowed] of tierSnapshot(session).shadowedBySeq) {
        const event = session.events[checkpointSeq]
        const source = event?.type === 'user/message'
          ? event.data.source as MessageSource & { compactionId?: string }
          : undefined
        if (source === undefined
          || source.compactionId === undefined
          || !isCompactCheckpointSource(source)) continue
        for (const seq of shadowed) owners.set(seq, source.compactionId)
      }
      ownerBySeq = owners
    }
    return {
      scope: 'session',
      query,
      hits: page.items.map((item) => {
        const checkpointId = ownerBySeq?.get(item.seq)
        return {
          seq: item.seq,
          type: item.type,
          surface: item.surface,
          snippet: item.snippet,
          ...item.surface === 'shadowed' && checkpointId !== undefined
            ? { checkpointId }
            : {},
        }
      }),
    }
  }
  const request: SessionSearchRequest = { query, limit }
  const page = await sessionQuery.searchSessions(request, { signal: exec.signal })
  return {
    scope: 'workspace',
    query,
    hits: page.items.map(item => ({
      sessionId: item.header.id,
      seq: item.bestMatch.seq,
      type: item.bestMatch.type,
      surface: item.bestMatch.surface,
      snippet: item.bestMatch.snippet,
    })),
  }
}
