import { describe, expect, it } from 'vitest'
import {
  auc,
  bootstrapAucCis,
  cmh,
  eventCountTerciles,
  isBigFold,
  isTailFold,
  parseFoldDump,
  perModelTailRates,
  twoProportionZ,
  unitSwapStats,
  wilsonCi,
} from '../scripts/tail-stats.ts'
import type { CmhStratum, FoldRow } from '../scripts/tail-stats.ts'

/**
 * Synthetic dump: 12 big folds across models alpha (6, three tails) and
 * beta (6, one tail) plus two small folds that must drop out of every
 * big-fold statistic. Fold 90A carries zero missed occurrences, so the
 * missed-share / unit-swap base is 11 folds, not 12. Kind mixes are set
 * so argmax agrees with the missed unit in 7 folds and the assistant vs
 * tool ordering strictly flips in 3 of 8 decisive folds.
 */
const dumpRow = (
  model: string,
  eventCount: number,
  longNumericRecall: number,
  kindBytes: readonly number[],
  kindMissedLong: readonly number[],
): string =>
  JSON.stringify({
    model,
    eventCount,
    totalBytes: kindBytes.reduce((sum, bytes) => sum + bytes, 0),
    longNumericRecall,
    kindBytes: {
      injected: kindBytes[0]!,
      assistant: kindBytes[1]!,
      tool: kindBytes[2]!,
      checkpoint: kindBytes[3]!,
      human: kindBytes[4]!,
    },
    kindMissedLong: {
      injected: kindMissedLong[0]!,
      assistant: kindMissedLong[1]!,
      tool: kindMissedLong[2]!,
      checkpoint: kindMissedLong[3]!,
      human: kindMissedLong[4]!,
    },
    missedLongOccurrences: kindMissedLong.reduce((sum, misses) => sum + misses, 0),
  })

const DUMP = [
  // alpha big folds: tails at eventCount 50, 70, 90.
  dumpRow('alpha', 50, 0.05, [10, 30, 20, 5, 5], [1, 2, 7, 0, 0]), // argmax flips (assistant -> tool)
  dumpRow('alpha', 60, 0.2, [10, 10, 40, 0, 0], [0, 0, 5, 0, 0]),
  dumpRow('alpha', 70, 0.05, [5, 20, 10, 5, 0], [0, 5, 5, 0, 0]), // missed assistant/tool tie: not decisive
  dumpRow('alpha', 80, 0.3, [5, 20, 25, 0, 0], [0, 3, 2, 0, 0]), // argmax flips (tool -> assistant)
  dumpRow('alpha', 90, 0.05, [50, 10, 10, 0, 0], [0, 0, 0, 0, 0]), // no misses: outside the missed-unit base
  dumpRow('alpha', 100, 0.4, [10, 40, 30, 0, 0], [0, 4, 6, 0, 0]), // argmax flips (assistant -> tool)
  // beta big folds: one tail at eventCount 55.
  dumpRow('beta', 50, 0.2, [10, 30, 20, 0, 0], [0, 3, 2, 0, 0]),
  dumpRow('beta', 55, 0.05, [10, 20, 40, 0, 0], [0, 1, 4, 0, 0]),
  dumpRow('beta', 60, 0.3, [20, 20, 20, 0, 0], [0, 2, 1, 0, 0]), // byte assistant/tool tie: not decisive
  dumpRow('beta', 200, 0.4, [10, 50, 40, 0, 0], [0, 8, 2, 0, 0]),
  dumpRow('beta', 300, 0.2, [10, 30, 60, 0, 0], [0, 1, 9, 0, 0]),
  dumpRow('beta', 400, 0.3, [10, 25, 25, 5, 5], [1, 3, 3, 0, 0]), // both units tie assistant/tool: not decisive
  // small folds: excluded from every big-fold statistic (even the tail one).
  dumpRow('alpha', 10, 0.5, [10, 10, 10, 0, 0], [0, 0, 0, 0, 0]),
  dumpRow('beta', 20, 0.05, [10, 10, 10, 0, 0], [0, 0, 0, 0, 0]),
].join('\n')

describe('parseFoldDump', () => {
  it('parses rows and skips blank lines', () => {
    const rows = parseFoldDump(`${DUMP}\n\n`)
    expect(rows).toHaveLength(14)
    expect(rows[0]!.model).toBe('alpha')
    expect(rows[0]!.eventCount).toBe(50)
    expect(rows[0]!.kindBytes.tool).toBe(20)
    expect(rows[0]!.missedLongOccurrences).toBe(10)
  })

  it('fails loud on malformed rows', () => {
    expect(() => parseFoldDump('not json')).toThrow(/line 1 is not JSON/)
    expect(() => parseFoldDump('{"model": "alpha"}')).toThrow(/line 1: missing or invalid fold column/)
    expect(() => parseFoldDump('{"model":"a","eventCount":50.5,"totalBytes":1,"longNumericRecall":0.1,'
      + '"kindBytes":{"injected":1,"assistant":0,"tool":0,"checkpoint":0,"human":0},'
      + '"kindMissedLong":{"injected":0,"assistant":0,"tool":0,"checkpoint":0,"human":0},"missedLongOccurrences":0}'))
      .toThrow(/line 1: missing or invalid fold column/)
    expect(() => parseFoldDump('{"model":"a","eventCount":50,"totalBytes":10,"longNumericRecall":0.1,'
      + '"kindBytes":{"injected":1},"kindMissedLong":{},"missedLongOccurrences":0}'))
      .toThrow(/kindBytes.assistant/)
  })
})

describe('wilsonCi', () => {
  it('matches a hand-derived small sample at z = 1.959964', () => {
    // k = 3, n = 10: p = 0.3, z^2 = 3.841459; center = 0.405777 / 1.192080,
    // half = 1.644182 * sqrt(0.021 + 0.009604) -> [0.107791, 0.603222]
    // (cross-checked against an independent implementation).
    const ci = wilsonCi(3, 10)
    expect(ci.lo).toBeCloseTo(0.107791, 5)
    expect(ci.hi).toBeCloseTo(0.603222, 5)
  })

  it('reproduces the lane Wilson CIs for the snapshot pair', () => {
    const omen = wilsonCi(79, 482)
    expect(omen.lo).toBeCloseTo(0.133534, 5)
    expect(omen.hi).toBeCloseTo(0.199582, 5)
    const zai = wilsonCi(5, 81)
    expect(zai.lo).toBeCloseTo(0.026653, 5)
    expect(zai.hi).toBeCloseTo(0.136492, 5)
  })

  it('rejects invalid inputs', () => {
    expect(() => wilsonCi(0, 0)).toThrow()
    expect(() => wilsonCi(4, 3)).toThrow()
  })
})

describe('auc', () => {
  it('gives ties exactly half credit (hand-computed)', () => {
    // tails {0.2, 0.8} vs non-tails {0.2, 0.6}: pairs 0.5 + 0 + 1 + 1 = 2.5/4.
    expect(auc([0.2, 0.8, 0.2, 0.6], [true, true, false, false])).toBeCloseTo(0.625, 10)
  })

  it('returns 0.5 when every value ties', () => {
    expect(auc([1, 1, 1, 1], [true, false, true, false])).toBeCloseTo(0.5, 10)
  })

  it('hits 1 and 0 under perfect separation', () => {
    expect(auc([10, 20, 1, 2], [true, true, false, false])).toBe(1)
    expect(auc([1, 2, 10, 20], [true, true, false, false])).toBe(0)
  })

  it('reads NaN on single-class input and throws on length mismatch', () => {
    expect(auc([1, 2, 3], [true, true, true])).toBeNaN()
    expect(() => auc([1, 2], [true])).toThrow()
  })
})

describe('cmh', () => {
  // Stratum 1: exposed 10/20, control 5/20 -> E = 7.5, Var = 150000/62400.
  // Stratum 2: exposed 8/40, control 4/40 -> E = 6, Var = 1305600/505600.
  // observed 18, expected 13.5, variance 4.986125, chi2 = 4.5^2 / 4.986125.
  const STRATA: readonly CmhStratum[] = [
    { exposedTails: 10, exposedN: 20, controlTails: 5, controlN: 20 },
    { exposedTails: 8, exposedN: 40, controlTails: 4, controlN: 40 },
  ]

  it('matches a hand-computed 2x2x2 example', () => {
    const result = cmh(STRATA)
    expect(result.observed).toBe(18)
    expect(result.expected).toBeCloseTo(13.5, 10)
    expect(result.variance).toBeCloseTo(4.986125, 6)
    expect(result.chi2).toBeCloseTo(4.061270, 6)
    expect(result.p).toBeCloseTo(0.043877, 4) // erfc(sqrt(chi2/2)), independent reference
  })

  it('skips degenerate strata and fails loud without any variance', () => {
    const withEmpty = cmh([...STRATA, { exposedTails: 0, exposedN: 1, controlTails: 0, controlN: 0 }])
    expect(withEmpty.chi2).toBeCloseTo(4.061270, 6)
    expect(() => cmh([{ exposedTails: 0, exposedN: 1, controlTails: 0, controlN: 1 }])).toThrow(/variance/)
    expect(() => cmh([{ exposedTails: 3, exposedN: 2, controlTails: 0, controlN: 1 }])).toThrow()
  })
})

describe('twoProportionZ', () => {
  it('matches a hand-computed pooled test', () => {
    // 3/6 vs 1/6: pooled 4/12 = 1/3, se = sqrt(2/27), z = (1/3) / se = sqrt(3/2).
    const result = twoProportionZ(3, 6, 1, 6)
    expect(result.z).toBeCloseTo(1.224745, 6)
    expect(result.p).toBeCloseTo(0.220671, 4) // erfc(|z| / sqrt(2)), independent reference
  })

  it('rejects invalid inputs', () => {
    expect(() => twoProportionZ(1, 0, 1, 1)).toThrow()
    expect(() => twoProportionZ(2, 1, 0, 1)).toThrow()
  })
})

describe('bootstrapAucCis', () => {
  const series = {
    values: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2],
    labels: [true, false, true, false, true, false, true, false, false, false, false, false],
  }

  it('is deterministic for a fixed seed', () => {
    // One shared PRNG stream, consumed feature-major: identical series at
    // different positions draw different stream segments (the pinned lane
    // layout), so determinism is asserted run-vs-run, not feature-vs-feature.
    const first = bootstrapAucCis([series, series], { resamples: 250, seed: 42 })
    const second = bootstrapAucCis([series, series], { resamples: 250, seed: 42 })
    expect(first).toHaveLength(2)
    expect(second).toEqual(first)
    for (const ci of first) {
      expect(ci.lo).toBeLessThanOrEqual(ci.hi)
    }
  })

  it('validates its inputs', () => {
    expect(() => bootstrapAucCis([series], { resamples: 0, seed: 42 })).toThrow(/resamples/)
    expect(() => bootstrapAucCis([{ values: [], labels: [] }], { resamples: 10, seed: 42 })).toThrow(/no observations/)
    expect(() => bootstrapAucCis([{ values: [1, 2], labels: [true] }], { resamples: 10, seed: 42 })).toThrow(/length/)
  })
})

describe('aggregation over a synthetic dump', () => {
  const rows: readonly FoldRow[] = parseFoldDump(DUMP)
  const big: readonly FoldRow[] = rows.filter(isBigFold)

  it('groups per-model big-fold tail rates by model alone', () => {
    const stats = perModelTailRates(rows)
    expect(stats.map((stat) => stat.model)).toEqual(['alpha', 'beta']) // tie on n: first-seen order
    expect(stats[0]!.bigFolds).toBe(6)
    expect(stats[0]!.tails).toBe(3)
    expect(stats[0]!.rate).toBeCloseTo(0.5, 10)
    expect(stats[0]!.ci.lo).toBeCloseTo(0.187616, 5)
    expect(stats[0]!.ci.hi).toBeCloseTo(0.812384, 5)
    expect(stats[1]!.tails).toBe(1)
    expect(stats[1]!.rate).toBeCloseTo(1 / 6, 10)
    expect(stats[1]!.ci.lo).toBeCloseTo(0.030053, 5)
    expect(stats[1]!.ci.hi).toBeCloseTo(0.563503, 5)
  })

  it('splits big folds into rank terciles with remainder in the later terciles', () => {
    const terciles = eventCountTerciles(big)
    expect(terciles.map((stratum) => stratum.length)).toEqual([4, 4, 4])
    expect(terciles[0]!.at(-1)!.eventCount).toBe(60)
    expect(terciles[1]!.at(0)!.eventCount).toBe(60) // boundary ties straddle
    expect(terciles[2]!.at(-1)!.eventCount).toBe(400)
    const seven = eventCountTerciles(big.slice(0, 7))
    expect(seven.map((stratum) => stratum.length)).toEqual([2, 2, 3]) // 677 -> 225/226/226 shape
  })

  it('runs the pair CMH and z test on the tercile cells', () => {
    const terciles = eventCountTerciles(big)
    const strata: CmhStratum[] = terciles.map((stratum) => {
      const exposed = stratum.filter((fold) => fold.model === 'alpha')
      const control = stratum.filter((fold) => fold.model === 'beta')
      return {
        exposedTails: exposed.filter(isTailFold).length,
        exposedN: exposed.length,
        controlTails: control.filter(isTailFold).length,
        controlN: control.length,
      }
    })
    // T1: 1/2 vs 1/2, T2: 2/3 vs 0/1, T3: 0/1 vs 0/3 (zero-variance).
    const result = cmh(strata)
    expect(result.observed).toBe(3)
    expect(result.expected).toBeCloseTo(2.5, 10)
    expect(result.variance).toBeCloseTo(7 / 12, 10) // 1/3 + 1/4
    expect(result.chi2).toBeCloseTo(3 / 7, 10) // 0.25 / (7/12)
    expect(result.p).toBeCloseTo(0.512691, 4)
    const pair = twoProportionZ(3, 6, 1, 6)
    expect(pair.z).toBeCloseTo(1.224745, 6)
    expect(pair.p).toBeCloseTo(0.220671, 4)
  })

  it('counts unit-swap instability on folds with misses', () => {
    const stats = unitSwapStats(rows)
    expect(stats.eligible).toBe(11) // 12 big folds minus the zero-miss fold
    expect(stats.argmaxSame).toBe(7)
    expect(stats.assistantToolDecisive).toBe(8)
    expect(stats.assistantToolFlips).toBe(3)
  })
})
