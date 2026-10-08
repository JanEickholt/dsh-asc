/**
 * Regret-signal derivation from a usage report.
 *
 * A fold is *regretted* when the model decompresses shortly after folding:
 * content it just shadowed turned out to be needed verbatim again. This
 * module is a pure function of the `UsageReport` the scanner produced — no
 * session access, no event parsing; every output is reproducible from the
 * report alone.
 *
 * @module dsh-asc/analytics/signals
 */

import type {
  DecompressUsage,
  RegretSignal,
  SignalOptions,
  SignalReport,
  UsageReport,
} from './types.ts'
import { DEFAULT_SIGNAL_OPTIONS } from './types.ts'

/**
 * Seq of the fold a decompress call counts against: the most recent
 * checkpoint summary that precedes the call.
 */
function latestFoldBefore(report: UsageReport, decompressSeq: number): number | undefined {
  let foldSeq: number | undefined
  for (const checkpoint of report.checkpoints) {
    if (checkpoint.summarySeq < decompressSeq && (foldSeq === undefined || checkpoint.summarySeq > foldSeq)) {
      foldSeq = checkpoint.summarySeq
    }
  }
  return foldSeq
}

/**
 * Identify the checkpoint a decompress targeted: prefer ids actually
 * restored, fall back to ids requested, keep the first that names a known
 * checkpoint.
 */
function targetedCheckpointId(report: UsageReport, call: DecompressUsage): string | undefined {
  const known = new Set(report.checkpoints.map(checkpoint => checkpoint.compactionId))
  for (const id of [...call.restoredIds, ...call.requestedIds]) {
    if (known.has(id)) return id
  }
  return undefined
}

/**
 * Turn of the fold a decompress counts against. Folds are compaction
 * events, not tool calls, so no turn is on record; the closest proxy is the
 * `context_*` tool call the fold interrupted — `toolCalls` is in log order,
 * so the last call at or before the fold seq is the compress that produced
 * it. A fold that predates every recorded tool call floors at turn 0.
 */
function foldTurnOf(report: UsageReport, foldSeq: number): number {
  let turn = 0
  for (const call of report.toolCalls) {
    if (call.callSeq <= foldSeq) turn = call.turn
  }
  return turn
}

/**
 * Derive regret signals from one session's usage report.
 *
 * Pure derivation: the report is only read, never mutated, and the result is
 * fully determined by the report plus the classification window. When
 * `options` is omitted the fixed `DEFAULT_SIGNAL_OPTIONS` window applies; a
 * supplied `regretSeqWindow` replaces the default wholesale.
 * @param report - scanner output for one session's log.
 * @param options - regret-classification window; defaults when omitted.
 * @returns the derived `SignalReport`.
 */
export function computeSignals(report: UsageReport, options?: SignalOptions): SignalReport {
  const window = options?.regretSeqWindow ?? DEFAULT_SIGNAL_OPTIONS.regretSeqWindow

  const decompressByCheckpoint = new Map<string, number>()
  const recapByCheckpoint = new Map<string, number>()
  for (const checkpoint of report.checkpoints) {
    decompressByCheckpoint.set(checkpoint.compactionId, checkpoint.decompressCount)
    recapByCheckpoint.set(checkpoint.compactionId, checkpoint.recapCount)
  }

  const regrets: RegretSignal[] = []
  const regretTurns: number[] = []
  for (const call of report.decompressCalls) {
    const foldSeq = latestFoldBefore(report, call.callSeq)
    if (foldSeq === undefined) continue
    const seqDistance = call.callSeq - foldSeq
    if (seqDistance > window) continue
    const compactionId = targetedCheckpointId(report, call)
    const targetedFold = compactionId !== undefined
      && report.checkpoints.some(
        checkpoint => checkpoint.summarySeq === foldSeq && checkpoint.compactionId === compactionId,
      )
    regrets.push({
      seqDistance,
      foldSeq,
      decompressSeq: call.callSeq,
      ...compactionId === undefined ? {} : { compactionId },
      targetedFold,
    })
    // Log order keeps turns non-decreasing, so the clamp only guards
    // malformed reports handed in by hand.
    regretTurns.push(Math.max(0, call.turn - foldTurnOf(report, foldSeq)))
  }

  // The contract counts restored tokens, but `DecompressUsage` carries no
  // token figure yet — count restored entries instead. Upgrade trigger: once
  // the scanner exposes per-entry restoredTokens, sum those here.
  let restoredTokensTotal = 0
  for (const call of report.decompressCalls) {
    if (call.outcome === 'restored') restoredTokensTotal += call.restoredIds.length
  }

  // Decompresses within the window are the fold's immediate aftermath
  // (already counted as regrets); only activity beyond it marks the tail.
  const quietAfterLastFold = report.lastFoldSeq === undefined
    || !report.decompressCalls.some(call => call.callSeq > report.lastFoldSeq! + window)

  return {
    decompressByCheckpoint,
    recapByCheckpoint,
    regrets,
    regretTurns,
    restoredTokensTotal,
    quietAfterLastFold,
  }
}
