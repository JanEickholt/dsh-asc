import { describe, expect, it } from 'vitest'
import {
  type FoldRecord,
  type RequestRecord,
  joinFoldsWithRequests,
  ledgerTotals,
  parseFoldRecords,
  parseRequestRecords,
  summarizeVerdicts,
} from '../scripts/bili-cache-join-core.ts'

/** Fold builder with defaults; every field overridable per case. */
function fold(overrides: Partial<FoldRecord> = {}): FoldRecord {
  return {
    compactionId: 'c-fold',
    foldSeq: 10,
    timestamp: 1_000,
    shadowedTokens: 5_000,
    source: 'session.jsonl',
    ...overrides,
  }
}

/** Request builder with defaults; re-pay 0 unless overridden. */
function request(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    requestIdx: 0,
    timestamp: 2_000,
    rePayTokens: 0,
    inputTokens: null,
    cachedTokens: null,
    pairClass: null,
    perTurnSavings: null,
    breakevenTurns: null,
    measuredTurns: null,
    verdict: null,
    extras: {},
    ...overrides,
  }
}

describe('parseFoldRecords', () => {
  it('extracts compaction/summary folds from a session log', () => {
    const jsonl = [
      '{"type":"session","version":4,"id":"s1"}',
      '{"type":"user/message","seq":0,"time":100,"data":{}}',
      '{"type":"compaction/summary","seq":2,"time":1000,"data":{"compactionId":"c-aaa","shadowedTokenCount":5000}}',
      '{"type":"compaction/summary","seq":9,"time":2000,"data":{"compactionId":"c-bbb","shadowedTokenCount":250}}',
    ].join('\n')
    const folds = parseFoldRecords(jsonl, 's.jsonl')
    expect(folds).toHaveLength(2)
    expect(folds[0]).toMatchObject({ compactionId: 'c-aaa', foldSeq: 2, timestamp: 1000, shadowedTokens: 5000, source: 's.jsonl' })
    expect(folds[1]).toMatchObject({ compactionId: 'c-bbb', foldSeq: 9, timestamp: 2000, shadowedTokens: 250 })
  })

  it('treats unknown and malformed fields as null without throwing', () => {
    const jsonl = [
      'not json at all',
      '{"type":"compaction/summary"}',                                  // no data
      '{"type":"compaction/summary","data":{}}',                         // no id
      '{"type":"compaction/summary","seq":"x","time":"x","data":{"compactionId":"c-x"}}', // wrong types
      '{"type":"compaction/summary","seq":5,"time":5000,"data":{"compactionId":"c-ok","shadowedTokenCount":"bad"}}',
    ].join('\n')
    const folds = parseFoldRecords(jsonl, 's.jsonl')
    // Records without a usable compactionId are skipped; the two with ids
    // survive with null unknowns.
    expect(folds.map(fold => fold.compactionId)).toEqual(['c-x', 'c-ok'])
    expect(folds[0]).toMatchObject({ foldSeq: -1, timestamp: null, shadowedTokens: null })
    expect(folds[1]).toMatchObject({ foldSeq: 5, timestamp: 5000, shadowedTokens: null })
  })
})

describe('parseRequestRecords', () => {
  it('parses a JSON report with a requests array', () => {
    const report = JSON.stringify({
      grandLedger: {
        totalInputTokens: 100,
        hitRate: 0.96,
      },
      requests: [
        { timestamp: 1_000, inputTokens: 400, cachedTokens: 380, compRepay: 0 },
        { timestamp: 1_500, inputTokens: 300, cachedTokens: 100, compRepay: 120 },
      ],
    })
    const { requests, skipped } = parseRequestRecords(report)
    expect(skipped).toBe(0)
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({ requestIdx: 0, rePayTokens: 0, inputTokens: 400, cachedTokens: 380 })
    expect(requests[1]).toMatchObject({ requestIdx: 1, rePayTokens: 120 })
  })

  it('accepts JSONL and key: value text exports', () => {
    const jsonl = parseRequestRecords([
      '{"time":100,"input":50,"repay":10}',
      '{"time":200,"input":60,"repay":0}',
    ].join('\n'))
    expect(jsonl.requests.map(request => request.rePayTokens)).toEqual([10, 0])

    const text = parseRequestRecords('time: 100\ninput: 50\ncached: 45\n\ntime: 200\ninput: 60\ncached: 58\n')
    expect(text.requests).toHaveLength(2)
    expect(text.requests[0]).toMatchObject({ inputTokens: 50, cachedTokens: 45 })
    expect(text.requests[1]).toMatchObject({ inputTokens: 60, cachedTokens: 58 })
  })

  it('skips malformed records without throwing', () => {
    const mixed = [
      '{"time":100,"repay":5}',
      '{"garbage":true}',          // no usable field at all
      'null',
      'not json',
      '{"time":300,"repay":7}',
    ].join('\n')
    const { requests, skipped } = parseRequestRecords(mixed)
    expect(requests.map(request => request.rePayTokens)).toEqual([5, 7])
    expect(skipped).toBe(3)
  })

  it('reads verdict, breakeven, and pair classification spellings', () => {
    const report = JSON.stringify([{
      time: 1_000,
      compressionRePay: 500,
      pairClass: 'mid-stream-rewrite',
      deltaS: 250,
      verdict: 'paid back',
    }])
    const { requests } = parseRequestRecords(report)
    expect(requests[0]).toMatchObject({
      rePayTokens: 500,
      pairClass: 'mid-stream-rewrite',
      perTurnSavings: 250,
      verdict: 'PAID BACK',
    })
  })
})

describe('joinFoldsWithRequests', () => {
  it('matches a fold to the first later request with comp re-pay', () => {
    const rows = joinFoldsWithRequests(
      [fold()],
      [
        request({ requestIdx: 0, timestamp: 900, rePayTokens: 999 }),   // before the fold: no match
        request({ requestIdx: 1, timestamp: 1_100, rePayTokens: 0 }),  // no re-pay: no match
        request({ requestIdx: 2, timestamp: 1_200, rePayTokens: 400 }), // the fold's re-pay charge
      ],
    ).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      compactionId: 'c-fold',
      rePayTokens: 400,
      requestIdx: 2,
      requestTime: 1_200,
    })
  })

  it('marks a fold with no matching request as unobserved with null fields', () => {
    const rows = joinFoldsWithRequests(
      [fold({ compactionId: 'c-lonely' })],
      [request({ requestIdx: 0, timestamp: 2_000, rePayTokens: 0 })],
    ).rows
    expect(rows[0]).toMatchObject({
      compactionId: 'c-lonely',
      rePayTokens: null,
      requestIdx: null,
      requestTime: null,
      verdict: 'unobserved',
    })
  })

  it('falls back to list order when the export carries no timestamps', () => {
    const rows = joinFoldsWithRequests(
      [fold({ timestamp: null, compactionId: 'c-a' }), fold({ timestamp: null, compactionId: 'c-b' })],
      [
        request({ requestIdx: 0, timestamp: null, rePayTokens: 30 }),
        request({ requestIdx: 1, timestamp: null, rePayTokens: 40 }),
      ],
    ).rows
    expect(rows[0]).toMatchObject({ compactionId: 'c-a', requestIdx: 0, rePayTokens: 30 })
    expect(rows[1]).toMatchObject({ compactionId: 'c-b', requestIdx: 1, rePayTokens: 40 })
  })

  it('never matches two folds to the same re-pay request', () => {
    const rows = joinFoldsWithRequests(
      [fold({ compactionId: 'c-a', timestamp: 1_000 }), fold({ compactionId: 'c-b', timestamp: 1_100 })],
      [request({ requestIdx: 0, timestamp: 1_200, rePayTokens: 300 })],
    ).rows
    const matched = rows.filter(row => row.requestIdx !== null)
    expect(matched).toHaveLength(1)
    // Chronological order: the earlier fold wins the single re-pay request.
    expect(matched[0]!.compactionId).toBe('c-a')
  })

  it('respects the match window: a re-pay too late is no match', () => {
    const late = 1_000 + 11 * 60_000
    const rows = joinFoldsWithRequests(
      [fold()],
      [request({ requestIdx: 0, timestamp: late, rePayTokens: 500 })],
    ).rows
    expect(rows[0]!.requestIdx).toBeNull()
    expect(rows[0]!.verdict).toBe('unobserved')
  })

  it('carries an explicit export verdict through to the row', () => {
    const rows = joinFoldsWithRequests(
      [fold()],
      [request({ requestIdx: 0, timestamp: 1_200, rePayTokens: 400, verdict: 'NOT PAID BACK' })],
    ).rows
    expect(rows[0]).toMatchObject({ requestIdx: 0, verdict: 'NOT PAID BACK' })
  })

  it('computes PAID BACK from breakeven n* = ΔC₁/Δs against measured k', () => {
    const rows = joinFoldsWithRequests(
      [fold()],
      [
        request({ requestIdx: 0, timestamp: 1_100, rePayTokens: 0, inputTokens: 500 }),
        request({ requestIdx: 1, timestamp: 1_200, rePayTokens: 400, perTurnSavings: 100 }),
        request({ requestIdx: 2, timestamp: 1_300, rePayTokens: 0 }),
        request({ requestIdx: 3, timestamp: 1_400, rePayTokens: 0 }),
        request({ requestIdx: 4, timestamp: 1_500, rePayTokens: 0 }),
        request({ requestIdx: 5, timestamp: 1_600, rePayTokens: 0 }),
      ],
    ).rows
    // n* = 400/100 = 4, k = 4 later records → 4 >= 4 → PAID BACK.
    expect(rows[0]).toMatchObject({ breakevenTurns: 4, measuredTurns: 4, verdict: 'PAID BACK' })
  })

  it('reads NOT PAID BACK when the observed cadence falls short of n*', () => {
    const rows = joinFoldsWithRequests(
      [fold()],
      [
        request({ requestIdx: 0, timestamp: 1_200, rePayTokens: 400, perTurnSavings: 100 }),
        request({ requestIdx: 1, timestamp: 1_300, rePayTokens: 0 }),
      ],
    ).rows
    // n* = 4, k = 1 → NOT PAID BACK.
    expect(rows[0]).toMatchObject({ breakevenTurns: 4, measuredTurns: 1, verdict: 'NOT PAID BACK' })
  })

  it('keeps unobserved when Δs is not derivable and no verdict is present', () => {
    const rows = joinFoldsWithRequests(
      [fold()],
      [request({ requestIdx: 0, timestamp: 1_200, rePayTokens: 400 })],
    ).rows
    expect(rows[0]!.requestIdx).toBe(0)
    expect(rows[0]!.breakevenTurns).toBeNull()
    expect(rows[0]!.verdict).toBe('unobserved')
  })

  it('returns one row per fold in input order and empty-input totals', () => {
    const result = joinFoldsWithRequests(
      [fold({ compactionId: 'c-z' }), fold({ compactionId: 'c-a' })],
      [],
    )
    expect(result.rows.map(row => row.compactionId)).toEqual(['c-z', 'c-a'])
    expect(result.totals).toEqual({ records: 0, inputTokens: null, cachedTokens: null, hitRate: null, rePayShare: null })
  })

  it('never throws on malformed fold entries', () => {
    const rows = joinFoldsWithRequests(
      [
        fold({ compactionId: '', timestamp: null }),
        fold({ compactionId: 'c-real' }),
      ],
      [request({ requestIdx: 0, timestamp: 1_200, rePayTokens: 10 })],
    ).rows
    expect(rows).toHaveLength(2)
    expect(rows[1]!.requestIdx).toBe(0)
  })
})

describe('ledgerTotals and summarizeVerdicts', () => {
  it('computes hit rate and re-pay share only when inputs exist', () => {
    const totals = ledgerTotals([
      request({ requestIdx: 0, inputTokens: 1_000, cachedTokens: 960, rePayTokens: 10 }),
      request({ requestIdx: 1, inputTokens: 500, cachedTokens: 400 }),
    ])
    expect(totals).toEqual({
      records: 2,
      inputTokens: 1_500,
      cachedTokens: 1_360,
      hitRate: closeTo(1_360 / 1_500),
      rePayShare: closeTo(10 / 1_500),
    })
    const empty = ledgerTotals([])
    expect(empty.hitRate).toBeNull()
  })

  it('tallies verdicts across rows', () => {
    const rows = joinFoldsWithRequests(
      [fold({ compactionId: 'a' }), fold({ compactionId: 'b' }), fold({ compactionId: 'c' })],
      [
        request({ requestIdx: 0, timestamp: 1_100, rePayTokens: 100, perTurnSavings: 50 }),
        request({ requestIdx: 1, timestamp: 1_200, rePayTokens: 0 }),
        request({ requestIdx: 2, timestamp: 1_300, rePayTokens: 0 }),
      ],
    ).rows
    const summary = summarizeVerdicts(rows)
    expect(summary).toEqual({ matched: 1, unmatched: 2, paidBack: 1, notPaidBack: 0, unobserved: 2 })
  })
})

/** expect.closeTo helper: matches within 1e-9. */
function closeTo(expected: number): number {
  expect(expected).toBeCloseTo(expected, 9)
  return expected
}
