/**
 * The post-execute reversible tool-result projection service.
 *
 * Mounts as its own optional cordis service (never through `ctx.compaction`;
 * the overflow-only `toolResultPruner` stays mounted independently as the
 * degenerate fallback). Two seams cooperate:
 *
 * 1. `tools/post-execute` waterfall — the interception point, BEFORE the
 *    result is materialized into the log: measure the accepted content
 *    through the real `ctx.tokenMeter` service, and when a text block is
 *    oversized, record the call as a projection candidate. The decision is
 *    returned UNCHANGED so the original `tool/result` event lands in the
 *    durable log — replacing content here would erase the original and dangle
 *    every retrieval marker (core materializes only the accepted content).
 * 2. `session/event` firehose — when a candidate result materializes, commit
 *    the proven pruner shadow+replace pattern one microtask later (appends
 *    cannot reenter the publishing append): a `compaction/prune` event prices
 *    the shadowed original and a `tool/result` replacement carries the
 *    projected content with the retrieval marker embedding `{hash,
 *    originalSeq}`. No model-visible request ever prices the full original.
 *
 * The original event stays in the log (shadowed, never deleted); the marker
 * is only stamped once the original is durably landed. Commit failures are
 * loud and leave the full original on the surface, where the overflow pruner
 * remains the fallback.
 *
 * @module dsh-asc/projection/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { createToolResultMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { planProjection } from './projection.ts'

/** Maximum number of awaited projection candidates kept in flight. */
const MAX_PENDING_CANDIDATES = 256
/** Maximum number of committed original seqs remembered for replay dedup. */
const MAX_COMMITTED_SEQS = 256

/** One parked post-execute candidate. */
interface PendingCandidate {
  /** Tool that produced the result; selects the content reducer. */
  readonly toolName: string
}

/** Resolved projection configuration. */
export interface ResolvedProjectionConfig {
  /** Metered token ceiling; text blocks above it are projected. Defaults to `1000`. */
  readonly thresholdTokens: number
  /** Master switch; `false` never mounts the service. Defaults to `true`. */
  readonly enabled: boolean
}

/**
 * Optional cordis service: projects oversized tool results post-execute with
 * byte-exact, log-durable reversibility.
 */
export class ToolResultProjectionService extends Service {
  static inject = ['tokenMeter']

  /** Resolved and immutable configuration. */
  readonly config: ResolvedProjectionConfig

  private readonly autoDisposers: Array<() => void> = []
  private autoDisposed = false
  /** Candidate keys (`sessionId:callId`) awaiting their materialized result. */
  private readonly pending = new Map<string, { toolName: string }>()
  /** Original seqs already committed, so a replayed firehose pass is a no-op. */
  private readonly committedSeqs = new Set<number>()

  constructor(ctx: Context, config: ResolvedProjectionConfig) {
    super(ctx, 'toolResultProjection')
    this.config = config
    this._register()
  }

  /** Release every listener; unload must leave no listener behind. */
  dispose(): void {
    if (this.autoDisposed) return
    this.autoDisposed = true
    for (const dispose of this.autoDisposers.splice(0)) dispose()
    this.pending.clear()
    this.committedSeqs.clear()
  }

  private _register(): void {
    const { ctx } = this
    const register = (dispose: () => void): void => {
      if (this.autoDisposed) {
        dispose()
        return
      }
      this.autoDisposers.push(dispose)
    }

    register(ctx.on('tools/post-execute', async (
      exec: ToolExecution,
      result: Readonly<ToolExecutionResult>,
      next: () => Promise<PostToolDecision>,
    ): Promise<PostToolDecision> => {
      const decision = await next()
      if (decision.kind !== 'accept') return decision
      // Retrieval results must land byte-exact: projecting them would break
      // the very byte-exactness contract they serve.
      if (exec.name === 'context_retrieve') return decision
      // Only top-level (model-visible) calls materialize `tool/result` events;
      // PTC sub-dispatches log through the bridge and are invisible here.
      if (exec.parent !== undefined) return decision
      const agent = exec.agent
      if (agent === undefined) return decision
      const content = decision.content ?? result.content
      if (!this._hasOversizedText(exec, result.isError, content)) return decision
      const key = `${agent.session.id}:${exec.callId}`
      if (this.pending.size >= MAX_PENDING_CANDIDATES) {
        // Bound the candidate set: dispatch never materializing a call must
        // not leak entries forever. Oldest insertion is the safe eviction.
        const oldest = this.pending.keys().next()
        if (!oldest.done) this.pending.delete(oldest.value)
      }
      this.pending.set(key, { toolName: exec.name })
      // Unchanged accept: the original event must land in the log first.
      return decision
    }))

    register(ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (this.autoDisposed) return
      if (event.type !== 'tool/result') return
      // Only freshly appended originals; replacements (pruner or ours) never
      // re-enter this path — their call ids were consumed with the original.
      if (event.surfaceOp !== 'append') return
      const callId = event.data.message.source.callId
      const key = `${session.id}:${callId}`
      const candidate = this.pending.get(key)
      if (candidate === undefined) return
      this.pending.delete(key)
      if (this.committedSeqs.has(event.seq)) return
      if (this.committedSeqs.size >= MAX_COMMITTED_SEQS) {
        // Insertion-order eviction: the remembered set only needs to cover
        // recent replayed passes, not the whole session.
        const oldest = this.committedSeqs.values().next()
        if (!oldest.done) this.committedSeqs.delete(oldest.value)
      }
      this.committedSeqs.add(event.seq)
      // Appends cannot reenter the publishing append that is emitting here.
      queueMicrotask(() => { this.commit(session, event, candidate.toolName) })
    }))
  }

  /** Whether any text block of the content prices above the threshold. */
  private _hasOversizedText(
    exec: ToolExecution,
    isError: boolean,
    content: readonly ContentBlock[],
  ): boolean {
    const meter = this.ctx.tokenMeter
    const threshold = this.config.thresholdTokens
    for (const block of content) {
      if (block.type !== 'text') continue
      if (meter.estimateMessage(this._message(exec, isError, [block])) > threshold) return true
    }
    return false
  }

  /** Price inner blocks through the real meter with the exact message shape. */
  private _message(
    exec: ToolExecution,
    isError: boolean,
    blocks: readonly ContentBlock[],
  ): ToolResultMessage {
    return createToolResultMessage({
      callId: exec.callId,
      content: [...blocks],
      isError,
    })
  }

  /**
   * Commit the shadow+replace pair for one materialized oversized result.
   * Failures are loud. If the shadow landed but the replacement did not, a
   * compensating replacement re-lands the FULL original content so the
   * surface never loses the result; if even that fails, the partial state
   * (shadow priced, original still current) is surfaced loudly.
   */
  private commit(
    session: Session,
    event: SessionEvent<'tool/result'>,
    toolName: string | undefined,
  ): void {
    const prefix = `tool-result projection (${session.id})`
    // A queued commit may fire after dispose; it must not touch anything.
    if (this.autoDisposed) return
    let shadowed = false
    try {
      const message = event.data.message
      const resultBlock = message.content[0]
      if (resultBlock === undefined || resultBlock.type !== 'tool-result') {
        this.ctx.logger.warn(`${prefix}: unexpected content shape at seq ${event.seq}; skipped`)
        return
      }
      const meter = this.ctx.tokenMeter
      const tokensBefore = meter.estimateMessage(message)
      if (tokensBefore <= this.config.thresholdTokens) return
      const isError = resultBlock.isError === true
      const estimate = (blocks: readonly ContentBlock[]): number => meter.estimateMessage(
        createToolResultMessage({
          callId: message.source.callId,
          content: [...blocks],
          isError,
        }),
      )
      const plan = planProjection(resultBlock.content, event.seq, {
        thresholdTokens: this.config.thresholdTokens,
        estimate,
        toolName,
        failed: isError,
      })
      if (plan === null) return
      shadowed = true
      session.append('compaction/prune', {
        shadowedRange: { start: event.seq, end: event.seq },
        shadowedSeqs: [event.seq],
        shadowedTokenCount: tokensBefore,
      })
      const replacementContent: ToolResultMessage['content'] = [
        { ...resultBlock, content: [...plan.blocks] },
      ]
      const replacementMessage = freezeMessage({
        ...message,
        content: replacementContent,
      })
      session.append('tool/result', {
        ...event.data,
        message: replacementMessage,
      }, {
        surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq },
        sourceEventSeqs: [event.seq],
      })
      this.ctx.logger.info(
        `${prefix}: seq ${event.seq} projected (${plan.strategy}, `
        + `${tokensBefore}→${plan.tokensAfter} tokens), hash ${plan.hash}; `
        + 'original retained in the log',
      )
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      if (shadowed) {
        // The shadow priced a node whose replacement never landed. Re-land
        // the FULL original content so the surface keeps the result.
        try {
          session.append('tool/result', { ...event.data }, {
            surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq },
            sourceEventSeqs: [event.seq],
          })
          this.ctx.logger.error(
            `${prefix}: replacement for seq ${event.seq} failed (${detail}); `
            + 'the full original content was re-appended to keep the surface intact',
          )
        } catch (compensateError: unknown) {
          const compensateDetail = compensateError instanceof Error
            ? compensateError.message
            : String(compensateError)
          // Partial state: the shadow event exists, the original content is
          // still the current surface node. Loud — never swallowed.
          this.ctx.logger.error(
            `${prefix}: partial commit at seq ${event.seq}: replacement failed `
            + `(${detail}) and compensating re-append failed too `
            + `(${compensateDetail}); the shadow event prices seq ${event.seq} `
            + 'while the original content remains current on the surface',
          )
        }
      } else {
        // The original stays untouched on the surface; the overflow pruner
        // remains the fallback. Losing the replacement is never silent.
        this.ctx.logger.error(`${prefix}: commit failed at seq ${event.seq}: ${detail}`)
      }
    }
  }
}

/** Convenience id so callers can resolve the service without importing the module. */
export const PROJECTION_SERVICE_ID = 'toolResultProjection'

/** The optional projection service is visible on every cordis context once this module is loaded. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    toolResultProjection?: ToolResultProjectionService
  }
}
