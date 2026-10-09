#!/usr/bin/env node
/**
 * Permanent port of the issue #3 evaluation-lane statistics: given a
 * --fold-dump snapshot from scripts/quality-scores.ts, recompute every
 * number the GitHub thread reply quotes — the per-model big-fold
 * tail-rate table with Wilson CIs, the event-count tercile size control
 * with its CMH and two-proportion pair tests, the ten composition-share
 * AUCs with seeded bootstrap percentile CIs, and the byte-vs-missed
 * unit-swap stability counts (the throwaway scripts behind
 * .slim/lanes/model-axis.md and .slim/lanes/composition-predictors.md).
 * Repo-local dev tool; not part of the published package.
 *
 * Deterministic by construction: the bootstrap is pinned to a mulberry32
 * PRNG (seed 20261009) consumed feature-major through one shared stream,
 * exactly as the lane ran it, so the CI bounds reproduce the lane output.
 *
 * Definitions (shared with the lane write-ups): big fold eventCount >= 50,
 * tail fold longNumericRecall < 0.10, per-model grouping by the model
 * column alone (provider ignored), Wilson 95% CI at z = 1.959964, models
 * qualify for the table at n >= 20 big folds, terciles by rank over the
 * big folds (stable sort, boundary ties straddling), Mann-Whitney AUC on
 * mid-ranks with ties at 0.5 credit, missed-occurrence shares over folds
 * with missedLongOccurrences > 0.
 *
 * Usage: node scripts/tail-stats.ts <fold-dump.jsonl> [models...]
 *        (no args prints usage and exits 1; model args restrict the
 *        analysis to those models)
 *
 * @module dsh-asc/tail-stats
 */
import { readFileSync } from 'node:fs'

/** Event kinds the fold dump attributes bytes and missed occurrences to. */
export const EVENT_KINDS = ['injected', 'assistant', 'tool', 'checkpoint', 'human'] as const
export type EventKind = (typeof EVENT_KINDS)[number]
export type KindCounts = Readonly<Record<EventKind, number>>

const WILSON_Z = 1.959964
const BIG_FOLD_MIN_EVENTS = 50
const TAIL_LONG_NUMERIC_RECALL = 0.1
const MIN_MODEL_BIG_FOLDS = 20
const BOOTSTRAP_RESAMPLES = 5000
/** Pinned so every run reproduces the lane's original CI bounds exactly. */
const BOOTSTRAP_SEED = 20261009

/** One --fold-dump row, restricted to the columns this script consumes. */
export interface FoldRow {
  readonly model: string
  readonly eventCount: number
  readonly totalBytes: number
  readonly longNumericRecall: number
  readonly kindBytes: KindCounts
  readonly kindMissedLong: KindCounts
  readonly missedLongOccurrences: number
}

/** Big folds are the lane's analysis base; the tail is the failure mode under study. */
export const isBigFold = (fold: FoldRow): boolean => fold.eventCount >= BIG_FOLD_MIN_EVENTS
export const isTailFold = (fold: FoldRow): boolean => fold.longNumericRecall < TAIL_LONG_NUMERIC_RECALL

// ---------------------------------------------------------------------------
// Dump parsing (fails loud: a malformed row would silently skew every stat)
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined

const fraction = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined

const kindCounts = (value: unknown, path: string): KindCounts => {
  if (!isRecord(value)) throw new Error(`${path} is not an object`)
  const counts: Record<EventKind, number> = { injected: 0, assistant: 0, tool: 0, checkpoint: 0, human: 0 }
  for (const kind of EVENT_KINDS) {
    const count = nonNegativeInteger(value[kind])
    if (count === undefined) throw new Error(`${path}.${kind} is not a non-negative integer`)
    counts[kind] = count
  }
  return counts
}

/** Parse a --fold-dump JSONL file. Extra dump columns are ignored; malformed rows throw. */
export function parseFoldDump(jsonl: string, source = 'fold dump'): FoldRow[] {
  const rows: FoldRow[] = []
  const lines = jsonl.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim()
    if (line === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      throw new Error(`${source} line ${index + 1} is not JSON: ${error instanceof Error ? error.message : error}`)
    }
    if (!isRecord(parsed)) throw new Error(`${source} line ${index + 1} is not a JSON object`)
    const model = typeof parsed.model === 'string' ? parsed.model : undefined
    const eventCount = nonNegativeInteger(parsed.eventCount)
    const totalBytes = nonNegativeInteger(parsed.totalBytes)
    const longNumericRecall = fraction(parsed.longNumericRecall)
    const missedLongOccurrences = nonNegativeInteger(parsed.missedLongOccurrences)
    if (model === undefined || model === '' || eventCount === undefined || totalBytes === undefined
      || longNumericRecall === undefined || missedLongOccurrences === undefined) {
      throw new Error(`${source} line ${index + 1}: missing or invalid fold column`)
    }
    rows.push({
      model,
      eventCount,
      totalBytes,
      longNumericRecall,
      kindBytes: kindCounts(parsed.kindBytes, `${source} line ${index + 1} kindBytes`),
      kindMissedLong: kindCounts(parsed.kindMissedLong, `${source} line ${index + 1} kindMissedLong`),
      missedLongOccurrences,
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Pure statistics
// ---------------------------------------------------------------------------

/** Wilson score interval for a binomial proportion (z = 1.959964, the lane's 95%). */
export function wilsonCi(tails: number, n: number, z = WILSON_Z): { lo: number, hi: number } {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`wilsonCi needs integer n >= 1, got ${n}`)
  if (!Number.isInteger(tails) || tails < 0 || tails > n) {
    throw new Error(`wilsonCi needs 0 <= tails <= n, got ${tails}/${n}`)
  }
  const p = tails / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return { lo: center - half, hi: center + half }
}

/**
 * Mann-Whitney AUC on mid-ranks: P(value_tail > value_non-tail) + 0.5 *
 * P(equal). NaN when either class is empty (discrimination undefined).
 */
export function auc(values: readonly number[], labels: readonly boolean[]): number {
  if (values.length !== labels.length) throw new Error('auc: values and labels must be the same length')
  const positives = labels.reduce((count, label) => count + (label ? 1 : 0), 0)
  const negatives = values.length - positives
  if (positives === 0 || negatives === 0) return Number.NaN
  const order = values
    .map((value, index) => ({ value, tail: labels[index]! }))
    .sort((left, right) => left.value - right.value)
  let rankSumTails = 0
  let start = 0
  while (start < order.length) {
    let end = start + 1
    while (end < order.length && order[end]!.value === order[start]!.value) end += 1
    const midRank = (start + end - 1) / 2 + 1 // 1-based average rank of the tie block
    for (let index = start; index < end; index++) if (order[index]!.tail) rankSumTails += midRank
    start = end
  }
  return (rankSumTails - (positives * (positives + 1)) / 2) / (positives * negatives)
}

/** One 2x2 stratum of a Cochran-Mantel-Haenszel test: exposed vs control, tails out of n. */
export interface CmhStratum {
  readonly exposedTails: number
  readonly exposedN: number
  readonly controlTails: number
  readonly controlN: number
}

export interface CmhResult {
  readonly observed: number
  readonly expected: number
  readonly variance: number
  readonly chi2: number
  readonly p: number
}

/**
 * Cochran-Mantel-Haenszel stratified chi-square (1 df) without continuity
 * correction. Strata with fewer than two folds contribute nothing (zero
 * variance); a fully degenerate table throws.
 */
export function cmh(strata: readonly CmhStratum[]): CmhResult {
  let observed = 0
  let expected = 0
  let variance = 0
  for (const stratum of strata) {
    const cells: readonly [string, number, number][] = [
      ['exposed', stratum.exposedTails, stratum.exposedN],
      ['control', stratum.controlTails, stratum.controlN],
    ]
    for (const [name, tails, n] of cells) {
      if (!Number.isInteger(n) || n < 0 || !Number.isInteger(tails) || tails < 0 || tails > n) {
        throw new Error(`cmh: ${name} needs 0 <= tails <= n, got ${tails}/${n}`)
      }
    }
    const total = stratum.exposedN + stratum.controlN
    if (total < 2) continue
    const tails = stratum.exposedTails + stratum.controlTails
    observed += stratum.exposedTails
    expected += (stratum.exposedN * tails) / total
    variance += (stratum.exposedN * stratum.controlN * tails * (total - tails)) / (total * total * (total - 1))
  }
  if (variance <= 0) throw new Error('cmh: no stratum contributes within-stratum variance')
  const chi2 = (observed - expected) ** 2 / variance
  return { observed, expected, variance, chi2, p: erfc(Math.sqrt(chi2 / 2)) }
}

/** Pooled two-proportion z test (two-sided p from the normal tail). */
export function twoProportionZ(aTails: number, aN: number, bTails: number, bN: number): { z: number, p: number } {
  for (const [tails, n] of [[aTails, aN], [bTails, bN]] as const) {
    if (!Number.isInteger(n) || n <= 0 || !Number.isInteger(tails) || tails < 0 || tails > n) {
      throw new Error(`twoProportionZ needs 0 <= tails <= n with n >= 1, got ${tails}/${n}`)
    }
  }
  const pooled = (aTails + bTails) / (aN + bN)
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / aN + 1 / bN))
  if (se === 0) throw new Error('twoProportionZ: degenerate pooled rate (zero standard error)')
  const z = (aTails / aN - bTails / bN) / se
  return { z, p: erfc(Math.abs(z) / Math.SQRT2) }
}

/** One predictor series: per-fold share values with tail-membership labels. */
export interface LabeledSeries {
  readonly values: readonly number[]
  readonly labels: readonly boolean[]
}

export interface BootstrapOptions {
  readonly resamples?: number
  readonly seed?: number
}

/**
 * Percentile bootstrap 95% CIs for the AUC of each series, resampling
 * folds with replacement. One mulberry32 stream (seed 20261009) is
 * shared across the series and consumed feature-major — series k's full
 * bootstrap runs before series k+1 draws — which is the exact stream
 * layout the lane used, so its CI bounds reproduce. Single-class
 * resamples carry no discrimination and are skipped.
 */
export function bootstrapAucCis(
  series: readonly LabeledSeries[],
  options: BootstrapOptions = {},
): { lo: number, hi: number }[] {
  const resamples = options.resamples ?? BOOTSTRAP_RESAMPLES
  if (!Number.isInteger(resamples) || resamples <= 0) throw new Error(`bootstrap needs resamples >= 1, got ${resamples}`)
  const rand = mulberry32(options.seed ?? BOOTSTRAP_SEED)
  return series.map((one) => {
    if (one.values.length !== one.labels.length) throw new Error('bootstrap: values and labels must be the same length')
    if (one.values.length === 0) throw new Error('bootstrap: series with no observations')
    const n = one.values.length
    const stats: number[] = []
    const indices = new Array<number>(n)
    for (let resample = 0; resample < resamples; resample++) {
      for (let i = 0; i < n; i++) indices[i] = Math.floor(rand() * n)
      const score = auc(indices.map((j) => one.values[j]!), indices.map((j) => one.labels[j]!))
      if (!Number.isNaN(score)) stats.push(score)
    }
    const sorted = [...stats].sort((left, right) => left - right)
    if (sorted.length === 0) throw new Error('bootstrap: every resample was single-class')
    return { lo: percentile(sorted, 0.025), hi: percentile(sorted, 0.975) }
  })
}

/** Nearest-rank percentile of a sorted sample: index round(p * (n - 1)). */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error('percentile of an empty sample')
  if (p < 0 || p > 1) throw new Error(`percentile p out of range: ${p}`)
  return sorted[Math.round(p * (sorted.length - 1))]!
}

/**
 * mulberry32 PRNG: 32-bit state, one imul chain per draw, uniform in [0, 1).
 * Seeded (20261009) so bootstrap runs are deterministic and the lane's CI
 * bounds are reproducible; see bootstrapAucCis for the stream layout.
 */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Complementary error function via the regularized upper incomplete gamma
 * Q(1/2, x^2): power series for small arguments, Lentz continued fraction
 * for large ones (~1e-15, sharp enough for the 4-decimal p values printed).
 */
function erfc(x: number): number {
  if (x === 0) return 1
  const z = Math.abs(x)
  return x >= 0 ? gammaQHalf(z * z) : 2 - gammaQHalf(z * z)
}

function gammaQHalf(y: number): number {
  if (y < 0.5) return 1 - gammaPSeries(y)
  return gammaQFraction(y)
}

function gammaPSeries(y: number): number {
  let term = 2 // 1 / a with a = 1/2
  let sum = term
  for (let n = 1; n < 500; n++) {
    term *= y / (n + 0.5)
    sum += term
    if (Math.abs(term) < Math.abs(sum) * 1e-17) break
  }
  return sum * Math.exp(-y + 0.5 * Math.log(y) - 0.5 * Math.log(Math.PI))
}

function gammaQFraction(y: number): number {
  const tiny = 1e-300
  let b = y + 0.5
  let c = 1 / tiny
  let d = 1 / b
  let h = d
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - 0.5)
    b += 2
    d = an * d + b
    if (Math.abs(d) < tiny) d = tiny
    c = b + an / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-16) break
  }
  return Math.exp(-y + 0.5 * Math.log(y) - 0.5 * Math.log(Math.PI)) * h
}

// ---------------------------------------------------------------------------
// Aggregations
// ---------------------------------------------------------------------------

const zeroKindCounts = (): Record<EventKind, number> =>
  ({ injected: 0, assistant: 0, tool: 0, checkpoint: 0, human: 0 })

const byteShare = (fold: FoldRow, kind: EventKind): number =>
  fold.totalBytes > 0 ? fold.kindBytes[kind] / fold.totalBytes : 0

const missedShare = (fold: FoldRow, kind: EventKind): number =>
  fold.missedLongOccurrences > 0 ? fold.kindMissedLong[kind] / fold.missedLongOccurrences : 0

const sharesOf = (share: (fold: FoldRow, kind: EventKind) => number, fold: FoldRow): Record<EventKind, number> => {
  const shares = zeroKindCounts()
  for (const kind of EVENT_KINDS) shares[kind] = share(fold, kind)
  return shares
}

/** Argmax kind; the first kind wins exact ties (stable against kind order). */
const dominantKind = (shares: Record<EventKind, number>): EventKind => {
  let best: EventKind = EVENT_KINDS[0]
  for (const kind of EVENT_KINDS) if (shares[kind] > shares[best]) best = kind
  return best
}

/** Per-model big-fold tail stats, grouped by the model column alone, largest n first. */
export interface ModelTailRate {
  readonly model: string
  readonly bigFolds: number
  readonly tails: number
  readonly rate: number
  readonly ci: { lo: number, hi: number }
}

export function perModelTailRates(folds: readonly FoldRow[]): ModelTailRate[] {
  const groups = new Map<string, FoldRow[]>()
  for (const fold of folds) {
    if (!isBigFold(fold)) continue
    const group = groups.get(fold.model)
    if (group === undefined) groups.set(fold.model, [fold])
    else group.push(fold)
  }
  const stats: ModelTailRate[] = []
  for (const [model, group] of groups) {
    const tails = group.filter(isTailFold).length
    stats.push({ model, bigFolds: group.length, tails, rate: tails / group.length, ci: wilsonCi(tails, group.length) })
  }
  return stats.sort((left, right) => right.bigFolds - left.bigFolds) // stable: first-seen order on ties
}

/**
 * Event-count terciles by rank: stable sort (boundary ties straddle, dump
 * order deciding which side), equal-count split with the remainder
 * landing in the later terciles (677 -> 225/226/226, the lane's split).
 */
export function eventCountTerciles(folds: readonly FoldRow[]): readonly (readonly FoldRow[])[] {
  const sorted = [...folds].sort((left, right) => left.eventCount - right.eventCount)
  const first = Math.floor(sorted.length / 3)
  const third = Math.ceil(sorted.length / 3)
  const second = sorted.length - first - third
  return [sorted.slice(0, first), sorted.slice(first, first + second), sorted.slice(first + second)]
}

export interface UnitSwapStats {
  /** Big folds with misses — the base both units are comparable on. */
  readonly eligible: number
  readonly argmaxSame: number
  readonly assistantToolDecisive: number
  readonly assistantToolFlips: number
}

/**
 * Unit stability between byte shares and missed-occurrence shares: how
 * often the dominant kind matches across units, and the assistant-vs-tool
 * strict flip rate (both differences non-zero, opposite signs).
 */
export function unitSwapStats(folds: readonly FoldRow[]): UnitSwapStats {
  const eligible = folds.filter((fold) => isBigFold(fold) && fold.missedLongOccurrences > 0)
  let argmaxSame = 0
  let decisive = 0
  let flips = 0
  for (const fold of eligible) {
    const byteShares = sharesOf(byteShare, fold)
    const missedShares = sharesOf(missedShare, fold)
    if (dominantKind(byteShares) === dominantKind(missedShares)) argmaxSame += 1
    const byteDiff = byteShares.assistant - byteShares.tool
    const missedDiff = missedShares.assistant - missedShares.tool
    if (byteDiff !== 0 && missedDiff !== 0) {
      decisive += 1
      if (Math.sign(byteDiff) !== Math.sign(missedDiff)) flips += 1
    }
  }
  return { eligible: eligible.length, argmaxSame, assistantToolDecisive: decisive, assistantToolFlips: flips }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const pct = (fraction: number): string => `${(100 * fraction).toFixed(2)}%`
const pct1 = (fraction: number): string => `${(100 * fraction).toFixed(1)}%`

function reportPerModel(big: readonly FoldRow[]): void {
  const tails = big.filter(isTailFold).length
  console.log(`\n1. per-model big-fold tail rates (model column alone, models with >= ${MIN_MODEL_BIG_FOLDS} big folds)`)
  const stats = perModelTailRates(big)
  for (const stat of stats.filter((entry) => entry.bigFolds >= MIN_MODEL_BIG_FOLDS)) {
    console.log(
      `  ${stat.model.padEnd(20)} n=${String(stat.bigFolds).padStart(3)} tails=${String(stat.tails).padStart(3)}`
        + ` rate=${pct(stat.rate)} Wilson 95% CI [${pct(stat.ci.lo)}, ${pct(stat.ci.hi)}]`,
    )
  }
  const excluded = stats.filter((stat) => stat.bigFolds < MIN_MODEL_BIG_FOLDS)
  if (excluded.length > 0) {
    console.log(`  excluded, n < ${MIN_MODEL_BIG_FOLDS}: ${excluded.map((stat) => `${stat.model} (n=${stat.bigFolds})`).join(', ')}`)
  }
  console.log(`  overall big-fold tail rate: ${tails}/${big.length} = ${pct(tails / big.length)}`)
}

function reportTerciles(big: readonly FoldRow[]): void {
  const terciles = eventCountTerciles(big)
  console.log(`\n2. event-count tercile control (rank split over ${big.length} big folds)`)
  terciles.forEach((stratum, index) => {
    const range = stratum.length === 0
      ? 'empty'
      : `eventCount ${stratum[0]!.eventCount}-${stratum.at(-1)!.eventCount}`
    console.log(`  T${index + 1}: ${range}, n=${stratum.length}`)
  })
  const [first, second] = perModelTailRates(big)
  if (first === undefined || second === undefined) {
    console.log('  fewer than two models: no pair tests')
    return
  }
  for (const stat of [first, second]) {
    const cells = terciles
      .map((stratum, index) => {
        const folds = stratum.filter((fold) => fold.model === stat.model)
        const tails = folds.filter(isTailFold).length
        const rate = folds.length > 0 ? `=${pct(tails / folds.length)}` : ''
        return `T${index + 1} ${tails}/${folds.length}${rate}`
      })
      .join('  ')
    console.log(`  ${stat.model}: ${cells}`)
  }
  const strata: CmhStratum[] = terciles.map((stratum) => {
    const exposed = stratum.filter((fold) => fold.model === first.model)
    const control = stratum.filter((fold) => fold.model === second.model)
    return {
      exposedTails: exposed.filter(isTailFold).length,
      exposedN: exposed.length,
      controlTails: control.filter(isTailFold).length,
      controlN: control.length,
    }
  })
  const result = cmh(strata)
  console.log(
    `  CMH ${first.model} vs ${second.model}: observed ${result.observed}, expected ${result.expected.toFixed(2)}`
      + `, variance ${result.variance.toFixed(2)}, χ²(1) = ${result.chi2.toFixed(4)}, p = ${result.p.toFixed(4)}`,
  )
  const pair = twoProportionZ(first.tails, first.bigFolds, second.tails, second.bigFolds)
  console.log(`  two-proportion z (pooled): z = ${pair.z.toFixed(4)}, two-sided p = ${pair.p.toFixed(4)}`)
}

function reportAucs(big: readonly FoldRow[]): void {
  const missedBase = big.filter((fold) => fold.missedLongOccurrences > 0)
  const features = [
    ...EVENT_KINDS.map((kind) => ({
      label: `byte share ${kind}`,
      series: { values: big.map((fold) => byteShare(fold, kind)), labels: big.map(isTailFold) },
    })),
    ...EVENT_KINDS.map((kind) => ({
      label: `missed share ${kind}`,
      series: { values: missedBase.map((fold) => missedShare(fold, kind)), labels: missedBase.map(isTailFold) },
    })),
  ]
  const cis = bootstrapAucCis(features.map((feature) => feature.series))
  console.log(
    `\n3. composition share AUCs on ${big.length} big folds, tail = longNumericRecall < ${TAIL_LONG_NUMERIC_RECALL}`
      + ` (percentile bootstrap 95% CI, ${BOOTSTRAP_RESAMPLES} resamples, mulberry32 seed ${BOOTSTRAP_SEED};`
      + ` missed shares over the ${missedBase.length} folds with missedLongOccurrences > 0)`,
  )
  features.forEach((feature, index) => {
    const ci = cis[index]!
    const score = auc(feature.series.values, feature.series.labels)
    const excludes = ci.lo > 0.5 || ci.hi < 0.5
    console.log(
      `  ${feature.label.padEnd(24)} AUC ${score.toFixed(4)}  [${ci.lo.toFixed(4)}, ${ci.hi.toFixed(4)}]`
        + `${excludes ? '  CI excludes 0.5' : ''}`,
    )
  })
}

function reportUnitSwap(big: readonly FoldRow[]): void {
  const stats = unitSwapStats(big)
  console.log(`\n4. unit swap: byte shares vs missed-occurrence shares (${stats.eligible} big folds with misses)`)
  if (stats.eligible === 0) {
    console.log('  no big folds with missedLongOccurrences > 0')
    return
  }
  console.log(
    `  argmax kind differs between units: ${stats.eligible - stats.argmaxSame}/${stats.eligible}`
      + ` = ${pct1((stats.eligible - stats.argmaxSame) / stats.eligible)} (same: ${pct1(stats.argmaxSame / stats.eligible)})`,
  )
  if (stats.assistantToolDecisive === 0) {
    console.log('  assistant vs tool: no decisive folds (some difference always zero)')
    return
  }
  console.log(
    `  assistant vs tool strict flips: ${stats.assistantToolFlips}/${stats.assistantToolDecisive}`
      + ` = ${pct1(stats.assistantToolFlips / stats.assistantToolDecisive)}`,
  )
}

function main(): void {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error('usage: node scripts/tail-stats.ts <fold-dump.jsonl> [models...]')
    console.error('  recomputes the issue #3 lane statistics (per-model tail rates, tercile control,')
    console.error('  composition AUCs, unit swap) from a --fold-dump snapshot; model args restrict')
    console.error('  the analysis to those models')
    process.exitCode = 1
    return
  }
  const [dumpPath, ...modelFilter] = args
  let jsonl: string
  try {
    jsonl = readFileSync(dumpPath!, 'utf8')
  } catch (error) {
    console.error(`cannot read ${dumpPath}: ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
    return
  }
  const allRows = parseFoldDump(jsonl, dumpPath!)
  const rows = modelFilter.length === 0 ? allRows : allRows.filter((row) => modelFilter.includes(row.model))
  if (modelFilter.length > 0 && rows.length === 0) {
    console.error(`no folds for model(s): ${modelFilter.join(', ')}`)
    process.exitCode = 1
    return
  }
  const big = rows.filter(isBigFold)
  const bigTails = big.filter(isTailFold)
  console.log(
    `rows: ${allRows.length}${modelFilter.length > 0 ? ` (${rows.length} after model filter)` : ''}`
      + `, big folds (eventCount >= ${BIG_FOLD_MIN_EVENTS}): ${big.length}`
      + `, tail (longNumericRecall < ${TAIL_LONG_NUMERIC_RECALL}): ${bigTails.length}`,
  )
  if (big.length === 0) return
  reportPerModel(big)
  reportTerciles(big)
  reportAucs(big)
  reportUnitSwap(big)
}

if (process.argv[1] === new URL(import.meta.url).pathname) main()
