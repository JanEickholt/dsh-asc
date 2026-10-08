import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { conversationSession } from './helpers.ts'
import type { SignalReport, UsageReport } from '../src/analytics/types.ts'
import { renderStatsReport, registerAnalyticsCommand } from '../src/analytics/command.ts'

// The command lane tests the command + renderer, not the parallel
// scan/signals lanes: their modules are stubbed with fixture outputs.
const { scanSessionUsage, computeSignals } = vi.hoisted(() => ({
  scanSessionUsage: vi.fn(),
  computeSignals: vi.fn(),
}))

vi.mock('../src/analytics/scan.ts', () => ({ scanSessionUsage }))
vi.mock('../src/analytics/signals.ts', () => ({ computeSignals }))

/** A minimal report fixture; per-test fields are overwritten inline. */
function usageReport(overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    sessionId: 'session-fixture' as UsageReport['sessionId'],
    scannedToSeq: 42,
    toolCalls: [],
    decompressCalls: [],
    checkpoints: [],
    lastFoldSeq: undefined,
    ...overrides,
  }
}

/** A minimal signals fixture; per-test fields are overwritten inline. */
function signalReport(overrides: Partial<SignalReport> = {}): SignalReport {
  return {
    decompressByCheckpoint: new Map(),
    recapByCheckpoint: new Map(),
    regrets: [],
    regretTurns: [],
    restoredTokensTotal: 0,
    quietAfterLastFold: true,
    ...overrides,
  }
}

/** Registry stub capturing one registration; disposal marks it removed. */
function recordingRegistry() {
  const registered: CommandDefinition[] = []
  const register = (definition: CommandDefinition) => {
    registered.push(definition)
    return () => {
      const index = registered.indexOf(definition)
      if (index >= 0) registered.splice(index, 1)
    }
  }
  // The command reads only the `commands.register` seam; the stub keeps the
  // test independent of the full Cordis Context surface.
  const ctx = { commands: { register } } as unknown as Context
  return { ctx, registered }
}

/** Invocation stub carrying one session, as the executor hands it over. */
function invocationOf(session: ReturnType<typeof conversationSession>) {
  return {
    commandId: 'cmd-1' as never,
    agent: { session } as never,
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
  }
}

beforeEach(() => {
  scanSessionUsage.mockReset()
  computeSignals.mockReset()
})

describe('renderStatsReport', () => {
  it('renders the header, zero counts, and the quiet-tail verdict for an empty report', () => {
    const text = renderStatsReport(usageReport(), signalReport())
    expect(text).toBe([
      'asc-stats: session session-fixture scanned to seq 42',
      'checkpoints: 0',
      'tool calls: 0',
      'restored tokens: 0',
      'regrets: 0',
      'quiet tail: no decompress after the last fold',
    ].join('\n'))
  })

  it('renders each checkpoint line with counts and author', () => {
    const report = usageReport({
      toolCalls: [
        { name: 'context_status', callSeq: 3, turn: 1 },
        { name: 'context_decompress', callSeq: 9, turn: 2 },
      ],
      checkpoints: [{
        compactionId: 'cp-1',
        summarySeq: 7,
        tier: 2,
        topic: 'engine refactor',
        shadowedCount: 5,
        shadowedTokens: 1200,
        author: 'model',
        decompressCount: 2,
        recapCount: 1,
      }],
    })
    const text = renderStatsReport(report, signalReport())
    expect(text).toContain('checkpoints: 1')
    expect(text).toContain(
      '- seq 7 tier 2 "engine refactor": 5 seqs / 1200 tokens shadowed'
      + ', decompressed 2, recap 1, author model',
    )
    expect(text).toContain('tool calls: 2')
  })

  it('renders regret lines with seq distance, target id, and targeted-fold mark', () => {
    const signals = signalReport({
      restoredTokensTotal: 4500,
      regrets: [
        { seqDistance: 12, foldSeq: 7, decompressSeq: 19, compactionId: 'cp-1', targetedFold: true },
        { seqDistance: 40, foldSeq: 7, decompressSeq: 47, targetedFold: false },
      ],
      quietAfterLastFold: false,
    })
    const text = renderStatsReport(usageReport(), signals)
    expect(text).toContain('restored tokens: 4500')
    expect(text).toContain('regrets: 2')
    expect(text).toContain(
      '- decompress at seq 19 followed fold at seq 7 (12 seqs apart) targeting cp-1, the fold itself',
    )
    expect(text).toContain(
      '- decompress at seq 47 followed fold at seq 7 (40 seqs apart)',
    )
    expect(text).toContain('quiet tail: decompress activity continued after the last fold')
  })
})

describe('registerAnalyticsCommand', () => {
  it('registers the asc-stats definition and the disposer unregisters it', () => {
    const { ctx, registered } = recordingRegistry()
    const dispose = registerAnalyticsCommand(ctx, {})
    expect(registered).toHaveLength(1)
    expect(registered[0]?.name).toBe('asc-stats')
    expect(typeof registered[0]?.description).toBe('string')
    expect(typeof registered[0]?.handler).toBe('function')
    dispose()
    expect(registered).toHaveLength(0)
  })

  it('skips registration when analytics.enabled is false, and the disposer is a no-op', () => {
    const { ctx, registered } = recordingRegistry()
    const dispose = registerAnalyticsCommand(ctx, { analytics: { enabled: false } })
    expect(registered).toHaveLength(0)
    expect(() => dispose()).not.toThrow()
  })

  it('handler scans the invocation session and returns the rendered report as success', async () => {
    const { ctx, registered } = recordingRegistry()
    registerAnalyticsCommand(ctx, {})
    const session = conversationSession()
    scanSessionUsage.mockReturnValue(usageReport())
    computeSignals.mockReturnValue(signalReport())
    const result = await registered[0]?.handler(invocationOf(session))
    expect(scanSessionUsage).toHaveBeenCalledExactlyOnceWith(session)
    expect(computeSignals).toHaveBeenCalledExactlyOnceWith(usageReport(), { regretSeqWindow: 200 })
    expect(result).toEqual({
      kind: 'success',
      text: expect.stringContaining('asc-stats: session session-fixture scanned to seq 42'),
    })
  })

  it('honors analytics.regretSeqWindow for the signal options', async () => {
    const { ctx, registered } = recordingRegistry()
    registerAnalyticsCommand(ctx, { analytics: { regretSeqWindow: 50 } })
    scanSessionUsage.mockReturnValue(usageReport())
    computeSignals.mockReturnValue(signalReport())
    await registered[0]?.handler(invocationOf(conversationSession()))
    expect(computeSignals).toHaveBeenCalledWith(expect.anything(), { regretSeqWindow: 50 })
  })

  it('settles a thrown scan error as an error result', async () => {
    const { ctx, registered } = recordingRegistry()
    registerAnalyticsCommand(ctx, {})
    scanSessionUsage.mockImplementation(() => {
      throw new Error('scanSessionUsage not merged yet')
    })
    const result = await registered[0]?.handler(invocationOf(conversationSession()))
    expect(result).toEqual({
      kind: 'error',
      text: 'asc-stats failed: scanSessionUsage not merged yet',
    })
  })
})
