import { describe, expect, it } from 'vitest'
import { dedupeFolds, distribution, foldDumpRow, kindAggregate, parseSessionLog, pearson, scoreFold, sessionDirOf } from '../scripts/quality-scores.ts'
import type { FoldScore } from '../scripts/quality-scores.ts'

/** Two scorable folds plus one partial fold whose shadowed events are absent. */
const FIXTURE = [
  '{"type":"session","version":3,"id":"s1"}',
  // Fold A: numbers dropped by the summary; checkpoint source carries a
  // recorded numericRecall that disagrees with the recomputation.
  '{"type":"user/message","seq":0,"data":{"content":[{"type":"text","text":"ports: 3080 3080 3080 and 22 tasks\\nalpha beta gamma"}],"source":{"kind":"user"},"role":"user"}}',
  '{"type":"assistant/message","seq":1,"data":{"message":{"role":"assistant","content":[{"type":"text","text":"beta gamma delta"}]}}}',
  '{"type":"compaction/summary","seq":2,"data":{"compactionId":"c-aaa","summary":[{"type":"text","text":"alpha only, numbers dropped"}],"shadowedSeqs":[0,1],"provider":"p","model":"m"}}',
  '{"type":"user/message","seq":3,"surfaceOp":{"op":"replace","startSeq":0,"endSeq":2},"data":{"content":[{"type":"text","text":"checkpoint"}],"source":{"kind":"plugin","plugin":"compact","compactionId":"c-aaa","quality":{"metrics":{"rouge1F1":0.4,"top20Recall":0.9,"numericRecall":0.5,"top20LongNumericRecall":0.5}}},"role":"user"}}',
  // Fold B: the summary keeps the number; no recorded metrics (pre-0.3.2 shape).
  '{"type":"user/message","seq":4,"data":{"content":[{"type":"text","text":"port 3080 again"}],"source":{"kind":"user"},"role":"user"}}',
  '{"type":"compaction/summary","seq":5,"data":{"compactionId":"c-bbb","summary":[{"type":"text","text":"still 3080"}],"shadowedSeqs":[4],"provider":"p","model":"m"}}',
  '{"type":"user/message","seq":6,"surfaceOp":{"op":"replace","startSeq":4,"endSeq":5},"data":{"content":[{"type":"text","text":"checkpoint"}],"source":{"kind":"plugin","plugin":"compact","compactionId":"c-bbb"},"role":"user"}}',
  // Fold C: shadowed events missing from the log; must be skipped.
  '{"type":"compaction/summary","seq":7,"data":{"compactionId":"c-ccc","summary":[{"type":"text","text":"summary"}],"shadowedSeqs":[99],"provider":"p","model":"m"}}',
  // Fold D: summary matches the recorded metrics on all four signals, so
  // the fidelity check passes end to end.
  '{"type":"user/message","seq":19,"data":{"content":[{"type":"text","text":"port 3080"}],"source":{"kind":"user"},"role":"user"}}',
  '{"type":"compaction/summary","seq":20,"data":{"compactionId":"c-ddd","summary":[{"type":"text","text":"port 3080"}],"shadowedSeqs":[19],"provider":"p","model":"m"}}',
  '{"type":"user/message","seq":21,"surfaceOp":{"op":"replace","startSeq":19,"endSeq":20},"data":{"content":[{"type":"text","text":"checkpoint"}],"source":{"kind":"plugin","plugin":"compact","compactionId":"c-ddd","quality":{"metrics":{"rouge1F1":0.8,"top20Recall":0.667,"numericRecall":1,"top20LongNumericRecall":1}}},"role":"user"}}',
  '{"type":"session/end-seed","seq":8,"data":{}}',
].join('\n')

describe('parseSessionLog', () => {
  it('scores folds, pairs recorded metrics, and skips partial logs', () => {
    const folds = parseSessionLog(FIXTURE, 'fixture.jsonl')
    expect(folds).toHaveLength(3)
    const [a, b, d] = folds
    expect(a!.session).toBe('fixture.jsonl')
    expect(a!.compactionId).toBe('c-aaa')
    expect(a!.provider).toBe('p')
    expect(a!.model).toBe('m')
    expect(a!.numericRecall).toBe(0)
    expect(a!.recordedMetrics).toEqual({ rouge1F1: 0.4, top20Recall: 0.9, numericRecall: 0.5, top20LongNumericRecall: 0.5 })
    // Fold A recomputes numericRecall 0 and long recall 0 against the
    // recorded 0.5/0.5: the fidelity check must flag it.
    expect(a!.recordedMatches).toBe(false)
    expect(b!.compactionId).toBe('c-bbb')
    expect(b!.numericRecall).toBe(1)
    expect(b!.recordedMetrics).toBeNull()
    expect(b!.recordedMatches).toBeNull()
    // Fold D's recorded block matches the recomputation on all four
    // signals (rouge 2/2 x 2/3 = 0.8, keyword 2/3, numeric 1, long 1):
    // the extraction-fidelity guarantee, exercised on its pass path.
    expect(d!.recordedMatches).toBe(true)
    // Tail analysis: fold A's only singleton (22) is dropped, fold B keeps its
    // single 3080; half of fold A's top-20 is a short fragment.
    expect(a!.singletonCount).toBe(1)
    expect(a!.singletonRecall).toBe(0)
    expect(a!.top20ShortShare).toBe(0.5)
    expect(a!.singletonBuckets.find((bucket) => bucket.label === '1-2 digits')).toEqual({ label: '1-2 digits', total: 1, matched: 0 })
    expect(a!.singletonBuckets.find((bucket) => bucket.label === '3-5 digits')).toEqual({ label: '3-5 digits', total: 0, matched: 0 })
    expect(b!.singletonCount).toBe(1)
    expect(b!.singletonRecall).toBe(1)
    // Fragment-free head: fold A's long top-20 is just 3080 (dropped),
    // fold B's is 3080 (kept).
    expect(a!.longNumericRecall).toBe(0)
    expect(b!.longNumericRecall).toBe(1)
    // Concentration: each fold has one distinct 3+ digit run (3080), so
    // the top-20 covers all of the long-digit mass and the distinct
    // count is 1 — the arithmetic-bound hypothesis' two numbers.
    expect(a!.longDistinctCount).toBe(1)
    expect(a!.longTop20Coverage).toBe(1)
    expect(b!.longDistinctCount).toBe(1)
    expect(b!.longTop20Coverage).toBe(1)
  })
})

describe('scoreFold', () => {
  it('mirrors the gate on a deterministic overlap', () => {
    const scores = scoreFold('alpha alpha', 'alpha alpha alpha beta')
    // P = 2/2, R = 2/4 → F1 = 2/3.
    expect(scores.rouge1F1).toBeCloseTo(2 / 3, 5)
  })
})

describe('distribution', () => {
  it('picks min, p10, median, p90, max', () => {
    const stats = distribution([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(stats).toEqual({ min: 1, p10: 1, median: 5, p90: 9, max: 10 })
  })
})

describe('pearson', () => {
  it('correlates a clean linear pair at 1 and its inverse at -1', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 10)
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 10)
  })

  it('reads zero for uncorrelated and degenerate samples', () => {
    // xor pattern: no linear relationship.
    expect(pearson([1, 2, 3, 4, 1, 2, 3, 4], [1, 2, 3, 4, 4, 3, 2, 1])).toBeCloseTo(0, 10)
    // zero variance in either sample: 0, not NaN.
    expect(pearson([1, 1, 1], [1, 2, 3])).toBe(0)
    expect(pearson([1, 2, 3], [1, 1, 1])).toBe(0)
  })

  it('rejects mismatched lengths', () => {
    expect(() => pearson([1, 2], [1, 2, 3])).toThrow('equal-length')
  })
})

/** A parsed fold reduced to the fields dedup and the dump need. */
function fold(overrides: Partial<Pick<FoldScore, 'session' | 'compactionId' | 'fingerprint' | 'eventCount'>>): FoldScore {
  return {
    session: '/root/project/session-1/session.v3.jsonl.zstd',
    compactionId: 'c-000',
    provider: 'p',
    model: 'm',
    fingerprint: '0,1|alpha only, numbers dropped',
    eventCount: 2,
    totalBytes: 120,
    rouge1F1: 0.4,
    top20Recall: 0.5,
    numericRecall: 0,
    singletonRecall: 0,
    singletonCount: 1,
    singletonBuckets: [],
    longNumericRecall: 0,
    longDistinctCount: 1,
    longTop20Coverage: 1,
    top20ShortShare: 0.5,
    top20: [],
    kindBytes: { injected: 12, assistant: 24, tool: 60, checkpoint: 6, human: 18 },
    kindMissedLong: { injected: 0, assistant: 1, tool: 2, checkpoint: 0, human: 0 },
    missedLongOccurrences: 3,
    recordedMetrics: null,
    recordedMatches: null,
    ...overrides,
  }
}

describe('sessionDirOf', () => {
  it('names the session directory, not the file or project key', () => {
    expect(sessionDirOf('/root/--home-Jan-Projects-serveio--/session-47d1ce60/session.v4.jsonl.zstd'))
      .toBe('session-47d1ce60')
  })
})

describe('dedupeFolds', () => {
  it('keeps the first occurrence of exact duplicates and reports the group', () => {
    const first = fold({ compactionId: 'c-aaa', session: '/r/p/session-1/session.v3.jsonl.zstd' })
    const second = fold({ compactionId: 'c-aaa', session: '/r/p/session-1/session.v4.jsonl.zstd' })
    const result = dedupeFolds([first, second])
    expect(result.unique).toEqual([first])
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]!.members).toEqual([first, second])
    expect(result.sameDirExtra).toBe(1)
    expect(result.crossDirExtra).toBe(0)
  })

  it('classifies the same conversation resumed under another session key as cross-dir', () => {
    const original = fold({ session: '/r/p/session-1/session.v3.jsonl.zstd' })
    const resumed = fold({ compactionId: 'c-aaa', session: '/r/p/session-2/session.v3.jsonl.zstd' })
    const result = dedupeFolds([original, resumed])
    expect(result.unique).toEqual([original])
    expect(result.sameDirExtra).toBe(0)
    expect(result.crossDirExtra).toBe(1)
  })

  it('keeps folds whose summaries or shadowed seq lists differ', () => {
    const rotated = fold({ fingerprint: '0,1|alpha only, numbers dropped', session: '/r/p/session-1/session.v4.jsonl.zstd' })
    // v4 can insert events, shifting the shadowed seq list by one: the seq
    // list is part of the fingerprint, so a rotation that shifts seqs is NOT
    // a duplicate even when the summary text matches.
    const shifted = fold({ fingerprint: '0,1,2|alpha only, numbers dropped', session: '/r/p/session-1/session.v4.jsonl.zstd' })
    const rewritten = fold({ fingerprint: '0,1|beta summary, rewritten', session: '/r/p/session-1/session.v4.jsonl.zstd' })
    const result = dedupeFolds([rotated, shifted, rewritten])
    expect(result.unique).toEqual([rotated, shifted, rewritten])
    expect(result.groups).toHaveLength(0)
    expect(result.sameDirExtra).toBe(0)
    expect(result.crossDirExtra).toBe(0)
  })

  it('counts each duplicate class per group member, not per group', () => {
    const base = fold({ fingerprint: 'f', session: '/r/p/session-1/session.v3.jsonl.zstd' })
    const sameDir = fold({ fingerprint: 'f', session: '/r/p/session-1/session.v4.jsonl.zstd' })
    const crossDir = fold({ fingerprint: 'f', session: '/r/q/session-2/session.v3.jsonl.zstd' })
    const result = dedupeFolds([base, sameDir, crossDir])
    expect(result.sameDirExtra).toBe(1)
    expect(result.crossDirExtra).toBe(1)
    expect(result.groups[0]!.members).toHaveLength(3)
  })
})

describe('foldDumpRow', () => {
  it('shapes one dump row with the issue #3 pipeline columns', () => {
    const parsed = parseSessionLog(FIXTURE, '/root/--p--/session-1/session.jsonl')
    const row = foldDumpRow(parsed[0]!)
    expect(Object.keys(row)).toEqual([
      'session', 'compactionId', 'provider', 'model', 'eventCount', 'totalBytes',
      'rouge1F1', 'top20Recall', 'numericRecall', 'longNumericRecall',
      'singletonRecall', 'longDistinctCount', 'longTop20Coverage', 'top20ShortShare',
      'kindBytes', 'kindMissedLong', 'missedLongOccurrences',
    ])
    // The session column names the session directory slug, not the full path.
    expect(row.session).toBe('session-1')
    expect(row.compactionId).toBe('c-aaa')
    expect(row.eventCount).toBe(2)
    // Fold A's original: the user message plus the assistant message.
    expect(row.totalBytes).toBeGreaterThan(0)
    expect(row.rouge1F1).toBeGreaterThanOrEqual(0)
    expect(row.longNumericRecall).toBe(0)
  })
})

/**
 * Kind-attribution fixture (issue #3): one fold whose shadowed region holds
 * all five event kinds, plus a pre-source fold that must read as human.
 * Every 777777 and the 123 are dropped by the summary.
 */
const KIND_FIXTURE = [
  '{"type":"session","version":4,"id":"k1"}',
  '{"type":"tool/result","seq":10,"data":{"message":{"role":"tool","content":[{"type":"text","text":"out 777777 777777 padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding"}]}}}',
  '{"type":"assistant/message","seq":11,"data":{"message":{"role":"assistant","content":[{"type":"text","text":"say 777777"}]}}}',
  '{"type":"system/message","seq":12,"data":{"content":[{"type":"text","text":"note 777777"}]}}',
  '{"type":"user/message","seq":13,"data":{"content":[{"type":"text","text":"inject 777777"}],"source":{"kind":"runtime-context"},"role":"user"}}',
  '{"type":"user/message","seq":14,"data":{"content":[{"type":"text","text":"old summary said 777777"}],"source":{"kind":"compact-checkpoint"},"role":"user"}}',
  '{"type":"user/message","seq":15,"data":{"content":[{"type":"text","text":"human typed 123"}],"source":{"kind":"user"},"role":"user"}}',
  '{"type":"compaction/summary","seq":16,"data":{"compactionId":"c-kind","summary":[{"type":"text","text":"nothing kept"}],"shadowedSeqs":[10,11,12,13,14,15],"provider":"p","model":"m"}}',
  '{"type":"user/message","seq":17,"data":{"content":[{"type":"text","text":"legacy 999999"}],"role":"user"}}',
  '{"type":"compaction/summary","seq":18,"data":{"compactionId":"c-legacy","summary":[{"type":"text","text":"legacy dropped"}],"shadowedSeqs":[17],"provider":"p","model":"m"}}',
].join('\n')

describe('event-kind attribution', () => {
  it('credits bytes and missed long-token occurrences to the five kinds', () => {
    const [kind, legacy] = parseSessionLog(KIND_FIXTURE, 'kind.jsonl')
    // 777777: twice in the tool result, once each in assistant, system
    // (injected), runtime-context (injected) and the old checkpoint; 123
    // once in the human turn. All missed.
    expect(kind!.kindMissedLong).toEqual({ injected: 2, assistant: 1, tool: 2, checkpoint: 1, human: 1 })
    expect(kind!.missedLongOccurrences).toBe(7)
    // Byte shares partition the original: kinds sum to the fold total.
    const kindBytesTotal = Object.values(kind!.kindBytes).reduce((sum, value) => sum + value, 0)
    expect(kindBytesTotal).toBe(kind!.totalBytes)
    expect(kind!.kindBytes.tool).toBeGreaterThan(kind!.kindBytes.assistant)
    // The tool result carries most of the bytes → tool-dominant.
    expect(kind!.kindBytes.tool / kind!.totalBytes).toBeGreaterThan(0.5)
    // Pre-source user turns read as human.
    expect(legacy!.kindBytes).toEqual({ injected: 0, assistant: 0, tool: 0, checkpoint: 0, human: legacy!.totalBytes })
    expect(legacy!.kindMissedLong).toEqual({ injected: 0, assistant: 0, tool: 0, checkpoint: 0, human: 1 })
  })

  it('aggregates shares and tool dominance over a fold set', () => {
    const folds = parseSessionLog(KIND_FIXTURE, 'kind.jsonl')
    const [kind, legacy] = folds
    const agg = kindAggregate(folds)
    expect(agg.folds).toBe(2)
    expect(agg.missedTotal).toBe(8)
    // Missed occurrences: tool 2, assistant 1, injected 2, checkpoint 1,
    // human 2 (one per fold) → shares over 8.
    expect(agg.missedShares).toEqual({ injected: 0.25, assistant: 0.125, tool: 0.25, checkpoint: 0.125, human: 0.25 })
    const byteTotal = kind!.totalBytes + legacy!.totalBytes
    expect(Object.values(agg.byteShares).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10)
    expect(agg.byteShares.tool).toBeCloseTo(kind!.kindBytes.tool / byteTotal, 10)
    expect(agg.toolDominant).toBe(1)
    expect(kindAggregate([])).toEqual({
      folds: 0,
      byteShares: { injected: 0, assistant: 0, tool: 0, checkpoint: 0, human: 0 },
      missedShares: { injected: 0, assistant: 0, tool: 0, checkpoint: 0, human: 0 },
      missedTotal: 0,
      toolDominant: 0,
    })
  })

  it('attributes nothing when the summary keeps the long head', () => {
    const folds = parseSessionLog(FIXTURE, 'fixture.jsonl')
    const kept = folds.find((fold) => fold.compactionId === 'c-bbb')!
    expect(kept.kindMissedLong).toEqual({ injected: 0, assistant: 0, tool: 0, checkpoint: 0, human: 0 })
    expect(kept.missedLongOccurrences).toBe(0)
  })
})
