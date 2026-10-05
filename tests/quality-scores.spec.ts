import { describe, expect, it } from 'vitest'
import { distribution, parseSessionLog, scoreFold } from '../scripts/quality-scores.ts'

/** Two scorable folds plus one partial fold whose shadowed events are absent. */
const FIXTURE = [
  '{"type":"session","version":3,"id":"s1"}',
  // Fold A: numbers dropped by the summary; checkpoint source carries a
  // recorded numericRecall that disagrees with the recomputation.
  '{"type":"user/message","seq":0,"data":{"content":[{"type":"text","text":"ports: 3080 3080 3080 and 22 tasks\\nalpha beta gamma"}],"source":{"kind":"user"},"role":"user"}}',
  '{"type":"assistant/message","seq":1,"data":{"message":{"role":"assistant","content":[{"type":"text","text":"beta gamma delta"}]}}}',
  '{"type":"compaction/summary","seq":2,"data":{"compactionId":"c-aaa","summary":[{"type":"text","text":"alpha only, numbers dropped"}],"shadowedSeqs":[0,1],"provider":"p","model":"m"}}',
  '{"type":"user/message","seq":3,"surfaceOp":{"op":"replace","startSeq":0,"endSeq":2},"data":{"content":[{"type":"text","text":"checkpoint"}],"source":{"kind":"plugin","plugin":"compact","compactionId":"c-aaa","quality":{"metrics":{"numericRecall":0.5}}},"role":"user"}}',
  // Fold B: the summary keeps the number; no recorded metrics (pre-0.3.2 shape).
  '{"type":"user/message","seq":4,"data":{"content":[{"type":"text","text":"port 3080 again"}],"source":{"kind":"user"},"role":"user"}}',
  '{"type":"compaction/summary","seq":5,"data":{"compactionId":"c-bbb","summary":[{"type":"text","text":"still 3080"}],"shadowedSeqs":[4],"provider":"p","model":"m"}}',
  '{"type":"user/message","seq":6,"surfaceOp":{"op":"replace","startSeq":4,"endSeq":5},"data":{"content":[{"type":"text","text":"checkpoint"}],"source":{"kind":"plugin","plugin":"compact","compactionId":"c-bbb"},"role":"user"}}',
  // Fold C: shadowed events missing from the log; must be skipped.
  '{"type":"compaction/summary","seq":7,"data":{"compactionId":"c-ccc","summary":[{"type":"text","text":"summary"}],"shadowedSeqs":[99],"provider":"p","model":"m"}}',
  '{"type":"session/end-seed","seq":8,"data":{}}',
].join('\n')

describe('parseSessionLog', () => {
  it('scores folds, pairs recorded metrics, and skips partial logs', () => {
    const folds = parseSessionLog(FIXTURE, 'fixture.jsonl')
    expect(folds).toHaveLength(2)
    const [a, b] = folds
    expect(a!.session).toBe('fixture.jsonl')
    expect(a!.compactionId).toBe('c-aaa')
    expect(a!.provider).toBe('p')
    expect(a!.model).toBe('m')
    expect(a!.numericRecall).toBe(0)
    expect(a!.recordedNumericRecall).toBe(0.5)
    expect(a!.recordedMatches).toBe(false)
    expect(b!.compactionId).toBe('c-bbb')
    expect(b!.numericRecall).toBe(1)
    expect(b!.recordedNumericRecall).toBeNull()
    expect(b!.recordedMatches).toBeNull()
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
