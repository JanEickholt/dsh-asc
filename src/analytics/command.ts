/**
 * The `asc-stats` human command: scans the active session's log, derives
 * regret signals, and renders both reports for the operator.
 *
 * @module dsh-asc/analytics/command
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AgenticCompactionConfig } from '../types.ts'
import type { SignalOptions, SignalReport, UsageReport } from './types.ts'
import { DEFAULT_SIGNAL_OPTIONS } from './types.ts'
import { scanSessionUsage } from './scan.ts'
import { computeSignals } from './signals.ts'

/** Resolve the signal options from the analytics config section. */
function signalOptionsOf(config: AgenticCompactionConfig): SignalOptions {
  const regretSeqWindow = config.analytics?.regretSeqWindow
  return regretSeqWindow === undefined ? DEFAULT_SIGNAL_OPTIONS : { regretSeqWindow }
}

/**
 * Render a scan and its derived signals as one human-readable report
 * (pinned verbatim; tests assert its phrases).
 */
export function renderStatsReport(report: UsageReport, signals: SignalReport): string {
  const lines: string[] = [
    `asc-stats: session ${report.sessionId} scanned to seq ${report.scannedToSeq}`,
  ]
  lines.push(`checkpoints: ${report.checkpoints.length}`)
  for (const checkpoint of report.checkpoints) {
    lines.push(
      `- seq ${checkpoint.summarySeq} tier ${checkpoint.tier}`
      + `${checkpoint.topic === undefined ? '' : ` "${checkpoint.topic}"`}`
      + `: ${checkpoint.shadowedCount} seqs / ${checkpoint.shadowedTokens} tokens shadowed`
      + `, decompressed ${checkpoint.decompressCount}, recap ${checkpoint.recapCount}`
      + `, author ${checkpoint.author}`,
    )
  }
  lines.push(`tool calls: ${report.toolCalls.length}`)
  lines.push(`restored tokens: ${signals.restoredTokensTotal}`)
  lines.push(`regrets: ${signals.regrets.length}`)
  for (const regret of signals.regrets) {
    lines.push(
      `- decompress at seq ${regret.decompressSeq} followed fold at seq ${regret.foldSeq}`
      + ` (${regret.seqDistance} seqs apart)`
      + `${regret.compactionId === undefined ? '' : ` targeting ${regret.compactionId}`}`
      + `${regret.targetedFold ? ', the fold itself' : ''}`,
    )
  }
  lines.push(
    signals.quietAfterLastFold
      ? 'quiet tail: no decompress after the last fold'
      : 'quiet tail: decompress activity continued after the last fold',
  )
  return lines.join('\n')
}

/**
 * Scan one session and render its derived report; the handler body kept
 * separate so the scan→signal→render pipeline is testable without a
 * command registry. A thrown scan error settles as an error result rather
 * than an unhandled rejection in the command executor.
 */
function runStats(session: Session, options: SignalOptions): CommandResult {
  try {
    const report = scanSessionUsage(session)
    const signals = computeSignals(report, options)
    return { kind: 'success', text: renderStatsReport(report, signals) }
  } catch (error: unknown) {
    return { kind: 'error', text: `asc-stats failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Register the `asc-stats` operator command: scan the invocation agent's
 * session, derive signals, and render both reports as the success text.
 *
 * Registration is an effect: the returned function unregisters the
 * command. Skipped registration (analytics disabled) returns a no-op so
 * callers can dispose unconditionally.
 * @param ctx - Cordis context carrying the `commands` registry.
 * @param config - plugin configuration; `analytics.enabled === false` skips registration.
 * @returns a disposer that unregisters the command.
 */
export function registerAnalyticsCommand(ctx: Context, config: AgenticCompactionConfig = {}): () => void {
  if (config.analytics?.enabled === false) return () => {}
  const options = signalOptionsOf(config)
  const definition: CommandDefinition = {
    name: 'asc-stats',
    description: 'Show agentic compaction usage stats and regret signals for the current session.',
    handler: (invocation) => runStats(invocation.agent.session, options),
  }
  return ctx.commands.register(definition)
}
