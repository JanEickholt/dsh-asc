import { describe, expect, it } from 'vitest'
import type {
  CheckpointUsage,
  DecompressUsage,
  ToolCallUsage,
  UsageReport,
} from '../src/analytics/types.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { computeSignals } from '../src/analytics/signals.ts'
import { DEFAULT_SIGNAL_OPTIONS } from '../src/analytics/types.ts'

let idCounter = 0

/** One checkpoint fixture; per-test fields are overwritten inline. */
function checkpoint(overrides: Partial<CheckpointUsage> = {}): CheckpointUsage {
  idCounter += 1
  return {
    compactionId: `cp-${idCounter}`,
    summarySeq: 10,
    tier: 1,
    shadowedCount: 4,
    shadowedTokens: 800,
    author: 'model',
    decompressCount: 0,
    recapCount: 0,
    ...overrides,
  }
}

/** One decompress fixture; per-test fields are overwritten inline. */
function decompress(overrides: Partial<DecompressUsage> = {}): DecompressUsage {
  return {
    name: 'context_decompress',
    callSeq: 20,
    turn: 2,
    requestedIds: [],
    restoredIds: [],
    skippedIds: [],
    outcome: 'restored',
    ...overrides,
  }
}

/** One tool-call fixture; per-test fields are overwritten inline. */
function toolCall(overrides: Partial<ToolCallUsage> = {}): ToolCallUsage {
  return { name: 'context_status', callSeq: 1, turn: 1, ...overrides }
}

/** A UsageReport fixture; per-test fields are overwritten inline. */
function usageReport(overrides: Partial<UsageReport> = {}): UsageReport {
  idCounter += 1
  return {
    sessionId: SessionId(`signals-${idCounter}`),
    scannedToSeq: 100,
    toolCalls: [],
    decompressCalls: [],
    checkpoints: [],
    lastFoldSeq: undefined,
    ...overrides,
  }
}

describe('computeSignals', () => {
  it('returns empty maps, no regrets, and a quiet tail for an empty report', () => {
    const signals = computeSignals(usageReport())
    expect(signals.decompressByCheckpoint.size).toBe(0)
    expect(signals.recapByCheckpoint.size).toBe(0)
    expect(signals.regrets).toEqual([])
    expect(signals.regretTurns).toEqual([])
    expect(signals.restoredTokensTotal).toBe(0)
    expect(signals.quietAfterLastFold).toBe(true)
  })

  it('counts regret when a decompress follows the last fold within the window', () => {
    const signals = computeSignals(usageReport({
      toolCalls: [
        toolCall({ name: 'context_compress', callSeq: 8, turn: 1 }),
        toolCall({ name: 'context_decompress', callSeq: 20, turn: 2 }),
      ],
      decompressCalls: [decompress({
        callSeq: 20,
        turn: 2,
        requestedIds: ['cp-1'],
        restoredIds: ['cp-1'],
      })],
      checkpoints: [checkpoint({ compactionId: 'cp-1', summarySeq: 10 })],
      lastFoldSeq: 10,
    }))
    expect(signals.regrets).toEqual([{
      seqDistance: 10,
      foldSeq: 10,
      decompressSeq: 20,
      compactionId: 'cp-1',
      targetedFold: true,
    }])
    expect(signals.regretTurns).toEqual([1])
    expect(signals.quietAfterLastFold).toBe(true)
  })

  it('ignores a decompress farther from the fold than the window', () => {
    const signals = computeSignals(usageReport({
      decompressCalls: [decompress({ callSeq: 400, requestedIds: ['cp-1'], restoredIds: ['cp-1'] })],
      checkpoints: [checkpoint({ compactionId: 'cp-1', summarySeq: 10 })],
      lastFoldSeq: 10,
    }))
    expect(signals.regrets).toEqual([])
    expect(signals.regretTurns).toEqual([])
  })

  it('classifies against the most recent earlier fold, not the oldest', () => {
    const signals = computeSignals(usageReport({
      decompressCalls: [decompress({
        callSeq: 60,
        requestedIds: ['cp-2'],
        restoredIds: ['cp-2'],
      })],
      checkpoints: [
        checkpoint({ compactionId: 'cp-1', summarySeq: 10 }),
        checkpoint({ compactionId: 'cp-2', summarySeq: 55 }),
      ],
      lastFoldSeq: 55,
    }))
    expect(signals.regrets).toEqual([{
      seqDistance: 5,
      foldSeq: 55,
      decompressSeq: 60,
      compactionId: 'cp-2',
      targetedFold: true,
    }])
  })

  it('marks targetedFold false when the targeted checkpoint is an earlier fold', () => {
    const signals = computeSignals(usageReport({
      decompressCalls: [decompress({
        callSeq: 60,
        requestedIds: ['cp-1'],
        restoredIds: ['cp-1'],
      })],
      checkpoints: [
        checkpoint({ compactionId: 'cp-1', summarySeq: 10 }),
        checkpoint({ compactionId: 'cp-2', summarySeq: 55 }),
      ],
      lastFoldSeq: 55,
    }))
    expect(signals.regrets).toEqual([{
      seqDistance: 5,
      foldSeq: 55,
      decompressSeq: 60,
      compactionId: 'cp-1',
      targetedFold: false,
    }])
  })

  it('counts every decompress after one fold, not just the first', () => {
    const signals = computeSignals(usageReport({
      decompressCalls: [
        decompress({ callSeq: 20, turn: 2, requestedIds: ['cp-1'], restoredIds: ['cp-1'] }),
        decompress({ callSeq: 35, turn: 3, requestedIds: ['cp-1'], restoredIds: ['cp-1'] }),
      ],
      checkpoints: [checkpoint({ compactionId: 'cp-1', summarySeq: 10 })],
      lastFoldSeq: 10,
    }))
    expect(signals.regrets).toHaveLength(2)
    expect(signals.regrets.map(regret => regret.decompressSeq)).toEqual([20, 35])
    expect(signals.regretTurns).toEqual([2, 3])
  })

  it('reports per-checkpoint decompress and recap counts from the checkpoints', () => {
    const signals = computeSignals(usageReport({
      checkpoints: [
        checkpoint({ compactionId: 'cp-1', decompressCount: 2, recapCount: 1 }),
        checkpoint({ compactionId: 'cp-2', decompressCount: 0, recapCount: 3 }),
      ],
    }))
    expect(signals.decompressByCheckpoint.get('cp-1')).toBe(2)
    expect(signals.decompressByCheckpoint.get('cp-2')).toBe(0)
    expect(signals.recapByCheckpoint.get('cp-1')).toBe(1)
    expect(signals.recapByCheckpoint.get('cp-2')).toBe(3)
  })

  it('counts restored entries per restored decompress only', () => {
    const signals = computeSignals(usageReport({
      decompressCalls: [
        decompress({ restoredIds: ['cp-1', 'cp-2'], outcome: 'restored' }),
        decompress({ restoredIds: ['cp-1'], outcome: 'to-file' }),
        decompress({ restoredIds: [], outcome: 'skipped' }),
        decompress({ restoredIds: [], outcome: 'failed' }),
      ],
    }))
    expect(signals.restoredTokensTotal).toBe(2)
  })

  it('leaves compactionId undefined when no targeted id matches a checkpoint', () => {
    const signals = computeSignals(usageReport({
      decompressCalls: [decompress({ callSeq: 20, requestedIds: ['cp-x'], restoredIds: [] })],
      checkpoints: [checkpoint({ compactionId: 'cp-1', summarySeq: 10 })],
      lastFoldSeq: 10,
    }))
    expect(signals.regrets).toEqual([{
      seqDistance: 10,
      foldSeq: 10,
      decompressSeq: 20,
      targetedFold: false,
    }])
  })

  it('quietAfterLastFold is false when a decompress lands beyond the last fold plus window', () => {
    const signals = computeSignals(usageReport({
      decompressCalls: [decompress({ callSeq: 400 })],
      checkpoints: [checkpoint({ compactionId: 'cp-1', summarySeq: 10 })],
      lastFoldSeq: 10,
    }))
    expect(signals.quietAfterLastFold).toBe(false)
  })

  it('quietAfterLastFold is false when a decompress lands beyond a custom window', () => {
    const signals = computeSignals(usageReport({
      decompressCalls: [decompress({ callSeq: 40 })],
      checkpoints: [checkpoint({ compactionId: 'cp-1', summarySeq: 10 })],
      lastFoldSeq: 10,
    }), { regretSeqWindow: 20 })
    expect(signals.quietAfterLastFold).toBe(false)
    const signalsDefault = computeSignals(usageReport({
      decompressCalls: [decompress({ callSeq: 40 })],
      checkpoints: [checkpoint({ compactionId: 'cp-1', summarySeq: 10 })],
      lastFoldSeq: 10,
    }))
    expect(signalsDefault.quietAfterLastFold).toBe(true)
  })

  it('uses DEFAULT_SIGNAL_OPTIONS when options are omitted', () => {
    const base = {
      decompressCalls: [decompress({ callSeq: 210 })],
      checkpoints: [checkpoint({ compactionId: 'cp-1', summarySeq: 10 })],
      lastFoldSeq: 10,
    }
    // Distance 200 sits inside the default window but outside a tighter one.
    const omitted = computeSignals(usageReport(base))
    const explicit = computeSignals(usageReport(base), DEFAULT_SIGNAL_OPTIONS)
    expect(omitted).toEqual(explicit)
    expect(omitted.regrets).toHaveLength(1)
    const tight = computeSignals(usageReport(base), { regretSeqWindow: 150 })
    expect(tight.regrets).toHaveLength(0)
  })

  it('does not mutate the report and derives from it alone', () => {
    const report = usageReport({
      toolCalls: [
        toolCall({ name: 'context_compress', callSeq: 8, turn: 1 }),
        toolCall({ name: 'context_decompress', callSeq: 20, turn: 2 }),
      ],
      decompressCalls: [decompress({ callSeq: 20, turn: 2, requestedIds: ['cp-1'], restoredIds: ['cp-1'] })],
      checkpoints: [checkpoint({ compactionId: 'cp-1', summarySeq: 10, decompressCount: 1 })],
      lastFoldSeq: 10,
    })
    const before = JSON.stringify({
      toolCalls: report.toolCalls,
      decompressCalls: report.decompressCalls,
      checkpoints: report.checkpoints,
    })
    computeSignals(report)
    const after = JSON.stringify({
      toolCalls: report.toolCalls,
      decompressCalls: report.decompressCalls,
      checkpoints: report.checkpoints,
    })
    expect(after).toBe(before)
  })
})
