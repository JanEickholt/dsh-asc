#!/usr/bin/env node
/**
 * Corpus sampler for the summary quality gate: recompute the gate's per-signal
 * scores for every compaction fold in historical session logs and report the
 * distribution, so the numeric-recall floor can be read off the corpus it will
 * police (issue #1). Repo-local dev tool; not part of the published package.
 * Also profiles the numeric signal's blind spots: top-20 composition (is it
 * saturated with split fragments) and recall over the freq-1 singleton tail,
 * the numbers that actually carry information, plus the 3+ digit
 * concentration stats (distinct runs, top-20 mass coverage) that bound the
 * fragment-free signal across corpora.
 *
 * Mirrors the gate's text rendering (src/utils/text.ts serializeMessages) on
 * the log's event shapes: exact for pure-digit tokens, near-mirror for word
 * overlap. retentionPct is not recomputable offline (it prices the framed
 * checkpoint through the live token meter) and is skipped. Folds logged by
 * 0.3.2+ also carry the gate's own recorded metrics on the checkpoint source;
 * those are compared against the recomputation as an extraction-fidelity
 * check — all four per-signal metrics, not just the gated one, because the
 * fragment-free reading the issue #3 thread rides on is a record-only
 * metric no gate decision exists for.
 *
 * Every fold also carries event-kind attribution (issue #3's instrument):
 * each contributing event classifies as injected context, assistant text,
 * tool result, checkpoint (an older summary folded again), or human turn,
 * and every missed top-20 long-token occurrence is credited to the kind of
 * the event it lives in. Occurrences belong to exactly one event, so the
 * per-kind misses sum to the fold total — the reconciliation the report
 * prints. The default report surfaces the tail tables tail vs non-tail.
 *
 * Usage: node scripts/quality-scores.ts [roots...]   (default ~/.dsh/sessions)
 *        node scripts/quality-scores.ts --fold-dump <path> [roots...]
 * Folds are deduplicated on a fingerprint (shadowed seqs + summary text)
 * before reporting: the same conversation logged under multiple session
 * keys or log generations counts once (issue #3).
 *
 * @module dsh-asc/quality-scores
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { rouge1F1, topKeywordRecall, topLongNumericRecall, topNumericRecall, wordTokens } from '../src/engine/quality-gate.ts'

/** Gate floors fixed by the default config; only the numeric floor varies. */
const ROUGE_FLOOR = 0.05
const KEYWORD_FLOOR = 0.2
const NUMERIC_FLOORS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7] as const

/** Mirrors quality-gate.ts NUMERIC_RE (module-private there): a pure digit run. */
const NUMERIC_TOKEN_RE = /^\d+$/u

/** Mirrors quality-gate.ts LONG_NUMERIC_RE: a fragment-free 3+ digit run. */
const LONG_NUMERIC_TOKEN_RE = /^\d{3,}$/u

/** One lossless-JSON session-log event, as persisted in the JSONL file. */
interface LogEvent {
  readonly type?: unknown
  readonly seq?: unknown
  readonly data?: unknown
  readonly surfaceOp?: unknown
}

/** A content block as persisted on a message event. */
type LogBlock = { readonly type?: unknown, readonly [key: string]: unknown }

/** Recomputed gate scores for one compaction fold. */
export interface FoldScore {
  readonly session: string
  readonly compactionId: string
  readonly provider: string
  readonly model: string
  /** Dedup fingerprint: shadowed seq list plus the summary's first 200 chars. */
  readonly fingerprint: string
  /** Number of shadowed surface events contributing to the original text. */
  readonly eventCount: number
  /** Sum of UTF-8 byte lengths of the rendered shadowed event texts. */
  readonly totalBytes: number
  readonly rouge1F1: number
  readonly top20Recall: number
  readonly numericRecall: number
  /** Recall over numeric tokens appearing exactly once in the original (the tail). */
  readonly singletonRecall: number
  /** How many freq-1 numeric tokens the original had. */
  readonly singletonCount: number
  /** Share of the top-20 numeric slots held by tokens of 1-2 digits (fragments). */
  readonly top20ShortShare: number
  /** The original's top-20 numeric tokens by frequency, for composition dumps. */
  readonly top20: readonly NumericTokenCount[]
  /** Recall over the top-20 numeric tokens of 3+ digits (fragment-free head). */
  readonly longNumericRecall: number
  /** Distinct 3+ digit runs in the original: the long-head concentration. */
  readonly longDistinctCount: number
  /** Share of all long-digit occurrences the top-20 of them covers. */
  readonly longTop20Coverage: number
  /** Singleton-tail recall split by token length: 1-2, 3-5, 6+ digits. */
  readonly singletonBuckets: readonly SingletonBucket[]
  /** UTF-8 bytes of the original contributed by each event kind (issue #3). */
  readonly kindBytes: KindCounts
  /** Missed top-20 long-token occurrences per event kind; sums to missedLongOccurrences. */
  readonly kindMissedLong: KindCounts
  /** Occurrences of missed top-20 long tokens anywhere in the original. */
  readonly missedLongOccurrences: number
  /** Gate metrics recorded on a 0.3.2+ checkpoint source, when all four exist. */
  readonly recordedMetrics: RecordedMetrics | null
  /** Recorded vs recomputed agreement on every metric (tolerance 0.01), when both exist. */
  readonly recordedMatches: boolean | null
}

/** A numeric token with its frequency in the original. */
export interface NumericTokenCount {
  readonly token: string
  readonly count: number
}

/** One singleton-tail length bucket: how many freq-1 numeric tokens, how many kept. */
export interface SingletonBucket {
  readonly label: string
  readonly total: number
  readonly matched: number
}

/** Where a contributing event's content came from (issue #3 attribution). */
export const EVENT_KINDS = ['injected', 'assistant', 'tool', 'checkpoint', 'human'] as const
export type EventKind = (typeof EVENT_KINDS)[number]
export type KindCounts = Readonly<Record<EventKind, number>>

const zeroKindCounts = (): Record<EventKind, number> =>
  ({ injected: 0, assistant: 0, tool: 0, checkpoint: 0, human: 0 })

/** Score one summary against the original text, mirroring the gate. */
export function scoreFold(summaryText: string, originalText: string): {
  rouge1F1: number
  top20Recall: number
  numericRecall: number
} {
  const originalTokens = wordTokens(originalText)
  const summaryTokens = wordTokens(summaryText)
  return {
    rouge1F1: rouge1F1(originalTokens, summaryTokens),
    top20Recall: topKeywordRecall(originalTokens, summaryTokens),
    numericRecall: topNumericRecall(originalTokens, summaryTokens),
  }
}

/**
 * Numeric profile of an original: the top-20 numeric tokens by frequency
 * (what the gate's signal actually looks at) and the freq-1 tail, plus the
 * 3+ digit concentration stats (distinct count and top-20 mass coverage).
 */
export function numericProfile(originalText: string): {
  top20: NumericTokenCount[]
  singletons: string[]
  longTop20: NumericTokenCount[]
  longDistinctCount: number
  longTop20Coverage: number
} {
  const counts = new Map<string, number>()
  for (const token of wordTokens(originalText)) {
    if (!NUMERIC_TOKEN_RE.test(token)) continue
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  const entries = [...counts.entries()].sort((left, right) => right[1] - left[1])
  const longEntries = entries.filter(([token]) => LONG_NUMERIC_TOKEN_RE.test(token))
  const longTotal = longEntries.reduce((sum, [, count]) => sum + count, 0)
  const longTop20Mass = longEntries.slice(0, 20).reduce((sum, [, count]) => sum + count, 0)
  return {
    top20: entries.slice(0, 20).map(([token, count]) => ({ token, count })),
    singletons: entries.filter(([, count]) => count === 1).map(([token]) => token),
    // Same count map and sort as the gate's topRecallOf, so this is exactly
    // the token list topLongNumericRecall scores.
    longTop20: longEntries.slice(0, 20).map(([token, count]) => ({ token, count })),
    longDistinctCount: longEntries.length,
    longTop20Coverage: longTotal === 0 ? 1 : longTop20Mass / longTotal,
  }
}

/**
 * Recall over the singleton tail: the fraction of freq-1 numeric tokens that
 * appear verbatim in the summary. Empty tail counts as 1, mirroring
 * topNumericRecall's empty-set convention.
 */
export function singletonNumericRecall(singletons: readonly string[], summaryTokens: readonly string[]): number {
  if (singletons.length === 0) return 1
  const summarySet = new Set(summaryTokens)
  return singletons.filter((token) => summarySet.has(token)).length / singletons.length
}

/** Singleton length buckets: 1-2 digits (split fragments), 3-5, 6+ (ids, epochs). */
const BUCKET_LABELS = ['1-2 digits', '3-5 digits', '6+ digits'] as const
const bucketOf = (token: string): 0 | 1 | 2 => (token.length <= 2 ? 0 : token.length <= 5 ? 1 : 2)

/** Split the singleton tail into length buckets and count verbatim survival. */
export function singletonBuckets(singletons: readonly string[], summaryTokens: readonly string[]): SingletonBucket[] {
  const totals = [0, 0, 0]
  const matched = [0, 0, 0]
  const summarySet = new Set(summaryTokens)
  for (const token of singletons) {
    const index = bucketOf(token)
    totals[index]! += 1
    if (summarySet.has(token)) matched[index]! += 1
  }
  return BUCKET_LABELS.map((label, index) => ({ label, total: totals[index]!, matched: matched[index]! }))
}

/** Result of deduplicating parsed folds on their fingerprint. */
export interface DedupResult {
  /** First occurrence of each fingerprint, in input order. */
  readonly unique: readonly FoldScore[]
  /** Duplicate groups: fingerprint -> every occurrence, unique first. */
  readonly groups: readonly { readonly fingerprint: string, readonly members: readonly FoldScore[] }[]
  /** Extra folds dropped whose session dir matches the group's first fold. */
  readonly sameDirExtra: number
  /** Extra folds dropped whose session dir differs (same conversation, another key). */
  readonly crossDirExtra: number
}

/**
 * Deduplication key of a parsed fold's session directory: DSH persists logs
 * as <root>/<project-key>/<encoded-session-id>/session.vN.jsonl, so the
 * session dir (not the file) is the unit that log rotation and resumed
 * sessions duplicate across.
 */
export function sessionDirOf(session: string): string {
  const dir = dirname(session)
  const slug = basename(dir)
  return slug === '.' || slug === '/' ? basename(session) : slug
}

/**
 * Dedupe folds on their fingerprint, keeping the first occurrence (callers
 * pass folds in file order, so the earliest log wins). Reports duplicates by
 * class: same session dir (v3→v4 log rotation) vs cross session dir (the
 * same conversation resumed under another session key).
 */
export function dedupeFolds(folds: readonly FoldScore[]): DedupResult {
  const groupsByFingerprint = new Map<string, FoldScore[]>()
  const unique: FoldScore[] = []
  for (const fold of folds) {
    const members = groupsByFingerprint.get(fold.fingerprint)
    if (members === undefined) {
      groupsByFingerprint.set(fold.fingerprint, [fold])
      unique.push(fold)
      continue
    }
    members.push(fold)
  }
  const groups = [...groupsByFingerprint.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([fingerprint, members]) => ({ fingerprint, members }))
  let sameDirExtra = 0
  let crossDirExtra = 0
  for (const { members } of groups) {
    const firstDir = sessionDirOf(members[0]!.session)
    for (const member of members.slice(1)) {
      if (sessionDirOf(member.session) === firstDir) sameDirExtra += 1
      else crossDirExtra += 1
    }
  }
  return { unique, groups, sameDirExtra, crossDirExtra }
}


/** Distribution summary: min, p10, median, p90, max. */
export function distribution(values: readonly number[]): {
  min: number
  p10: number
  median: number
  p90: number
  max: number
} {
  if (values.length === 0) throw new Error('distribution of empty sample')
  const sorted = [...values].sort((left, right) => left - right)
  const pick = (quantile: number): number => sorted[Math.min(sorted.length - 1, Math.floor(quantile * (sorted.length - 1)))]!
  return { min: sorted[0]!, p10: pick(0.1), median: pick(0.5), p90: pick(0.9), max: sorted.at(-1)! }
}

/**
 * Pearson correlation of two equal-length samples. Degenerate (zero
 * variance in either sample) reads as 0, not NaN, so corpus runs stay
 * printable.
 */
export function pearson(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length) throw new Error('pearson needs equal-length samples')
  if (xs.length < 2) throw new Error('pearson needs at least two samples')
  const mx = xs.reduce((sum, value) => sum + value, 0) / xs.length
  const my = ys.reduce((sum, value) => sum + value, 0) / ys.length
  let numerator = 0
  let sx = 0
  let sy = 0
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mx
    const dy = ys[i]! - my
    numerator += dx * dy
    sx += dx * dx
    sy += dy * dy
  }
  return sx === 0 || sy === 0 ? 0 : numerator / Math.sqrt(sx * sy)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Mirror of src/utils/text.ts blockText() over persisted block shapes. */
function blockText(block: LogBlock): string {
  switch (block.type) {
    case 'text':
      return asString(block.text)
    case 'image':
      return '[image]'
    case 'tool-call':
      return `[tool-call: ${asString(block.name)}(${asString(block.id)})]\n${asString(block.arguments)}`
    case 'tool-result':
      return `[tool-result: ${asString(block.toolCallId)}]\n${asArray(block.content).map((nested) => blockText(nested as LogBlock)).join('\n')}`
    case 'reasoning':
      return `[reasoning]\n${asString(block.text)}`
    default:
      return '[content]'
  }
}

const blocksText = (blocks: readonly unknown[]): string => blocks.map((block) => blockText(block as LogBlock)).join('\n')

/**
 * Render one persisted surface event the way serializeMessage() renders the
 * derived message: role header plus block bodies. Returns null for event
 * types that contribute no message to the gate's original text.
 */
function eventText(event: LogEvent): string | null {
  const data = isRecord(event.data) ? event.data : {}
  const message = isRecord(data.message) ? data.message : {}
  switch (event.type) {
    case 'user/message':
      return `[user]\n${blocksText(asArray(data.content))}`
    case 'system/message':
      return `[system]\n${blocksText(asArray(data.content))}`
    case 'assistant/message':
      return `[assistant]\n${blocksText(asArray(message.content))}`
    case 'tool/result':
      return `[user]\n${blocksText(asArray(message.content))}`
    default:
      return null
  }
}

/**
 * Classify one contributing event for the kind attribution. Only called on
 * events eventText() rendered, so the default is unreachable: the four
 * renderable types are the only ones that reach here.
 */
function eventKindOf(event: LogEvent): EventKind {
  const data = isRecord(event.data) ? event.data : {}
  const source = isRecord(data.source) ? data.source : null
  switch (event.type) {
    case 'assistant/message':
      return 'assistant'
    case 'tool/result':
      return 'tool'
    case 'system/message':
      return 'injected'
    case 'user/message': {
      // No source marker exists only on pre-source logs, where user turns
      // were human-typed; everything sourced is harness content.
      if (source === null || source.kind === 'user') return 'human'
      if (source.kind === 'compact-checkpoint' || (source.kind === 'plugin' && source.plugin === 'compact')) {
        return 'checkpoint'
      }
      return 'injected'
    }
    default:
      return 'injected'
  }
}

/** Gate metrics recorded on a 0.3.2+ checkpoint source, when all four exist. */
export interface RecordedMetrics {
  readonly rouge1F1: number
  readonly top20Recall: number
  readonly numericRecall: number
  readonly top20LongNumericRecall: number
}

/** Checkpoint provenance source on a persisted replacement message. */
interface CheckpointSource {
  readonly plugin: string
  readonly compactionId: string
  readonly recorded: RecordedMetrics | null
}

function checkpointSource(event: LogEvent): CheckpointSource | null {
  const data = isRecord(event.data) ? event.data : {}
  if (event.type !== 'user/message' || !isRecord(data.source)) return null
  const source = data.source
  if (source.kind !== 'plugin' || source.plugin !== 'compact') return null
  const surfaceOp = isRecord(event.surfaceOp) ? event.surfaceOp : {}
  if (surfaceOp.op !== 'replace') return null
  let recorded: RecordedMetrics | null = null
  if (isRecord(source.quality) && isRecord(source.quality.metrics)) {
    const metrics = source.quality.metrics
    // All four signals or none: a source with a partial metrics block is
    // treated as unrecorded rather than half-checked.
    if (typeof metrics.rouge1F1 === 'number' && typeof metrics.top20Recall === 'number'
      && typeof metrics.numericRecall === 'number' && typeof metrics.top20LongNumericRecall === 'number') {
      recorded = {
        rouge1F1: metrics.rouge1F1,
        top20Recall: metrics.top20Recall,
        numericRecall: metrics.numericRecall,
        top20LongNumericRecall: metrics.top20LongNumericRecall,
      }
    }
  }
  return { plugin: 'compact', compactionId: asString(source.compactionId), recorded }
}

/**
 * Parse one session log (JSONL text) into per-fold recomputed scores.
 * Skips the non-event header line, folds with no shadowed text, and folds
 * whose shadowed events are missing from the log.
 */
export function parseSessionLog(jsonl: string, name: string): FoldScore[] {
  const bySeq = new Map<number, LogEvent>()
  const summaries: LogEvent[] = []
  const checkpoints = new Map<string, CheckpointSource>()
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue // tolerate trailing partial lines from a crashed writer
    }
    const event = (isRecord(parsed) ? parsed : {}) as LogEvent
    if (typeof event.type !== 'string') continue // session header line
    const seq = typeof event.seq === 'number' ? event.seq : null
    if (seq !== null) bySeq.set(seq, event)
    if (event.type === 'compaction/summary') summaries.push(event)
    const source = checkpointSource(event)
    if (source !== null && !checkpoints.has(source.compactionId)) {
      checkpoints.set(source.compactionId, source)
    }
  }
  const folds: FoldScore[] = []
  for (const summary of summaries) {
    const data = isRecord(summary.data) ? summary.data : {}
    const compactionId = asString(data.compactionId)
    const summaryText = blocksText(asArray(data.summary))
    const shadowedSeqs = asArray(data.shadowedSeqs)
    const shadowed = shadowedSeqs
      .map((seq) => (typeof seq === 'number' ? bySeq.get(seq) : undefined))
      .map((event) => {
        if (event === undefined) return null
        const text = eventText(event)
        return text === null ? null : { event, text }
      })
    if (summaryText.trim() === '' || shadowed.some((cell) => cell === null) || shadowed.length === 0) continue
    const contributing = shadowed.filter(
      (cell): cell is { event: LogEvent, text: string } => cell !== null && cell.text.trim() !== '',
    )
    const originalText = contributing.map((cell) => cell.text).join('\n\n')
    if (originalText.trim() === '') continue
    // Tokenize once; the profile needs the same tokens the scorers do.
    const originalTokens = wordTokens(originalText)
    const summaryTokens = wordTokens(summaryText)
    const { top20, singletons, longTop20, longDistinctCount, longTop20Coverage } = numericProfile(originalText)
    const numericRecall = topNumericRecall(originalTokens, summaryTokens)
    // Kind attribution (issue #3): an occurrence of a missed top-20 long
    // token lives in exactly one contributing event, so per-kind counts sum
    // to the fold total by construction — the reconciliation the report
    // re-derives and prints.
    const summarySet = new Set(summaryTokens)
    const missedTokens = new Set(
      longTop20.filter((entry) => !summarySet.has(entry.token)).map((entry) => entry.token),
    )
    const kindBytes = zeroKindCounts()
    const kindMissedLong = zeroKindCounts()
    let missedLongOccurrences = 0
    for (const cell of contributing) {
      const kind = eventKindOf(cell.event)
      kindBytes[kind] += Buffer.byteLength(cell.text, 'utf8')
      if (missedTokens.size === 0) continue
      let inEvent = 0
      for (const token of wordTokens(cell.text)) {
        if (missedTokens.has(token)) inEvent += 1
      }
      kindMissedLong[kind] += inEvent
      missedLongOccurrences += inEvent
    }
    const checkpoint = checkpoints.get(compactionId)
    const rougeScore = rouge1F1(originalTokens, summaryTokens)
    const keywordScore = topKeywordRecall(originalTokens, summaryTokens)
    const longScore = topLongNumericRecall(originalTokens, summaryTokens)
    const recorded = checkpoint?.recorded ?? null
    folds.push({
      session: name,
      compactionId,
      provider: asString(data.provider),
      model: asString(data.model),
      // Same conversation logged twice (rotation or resumed under another
      // key) shares its shadowed seq list and summary text; that is the
      // fingerprint the dedup pass keys on (issue #3).
      fingerprint: `${shadowedSeqs.map(String).join(',')}|${summaryText.slice(0, 200)}`,
      eventCount: contributing.length,
      totalBytes: contributing.reduce((sum, cell) => sum + Buffer.byteLength(cell.text, 'utf8'), 0),
      rouge1F1: rougeScore,
      top20Recall: keywordScore,
      numericRecall,
      singletonRecall: singletonNumericRecall(singletons, summaryTokens),
      singletonCount: singletons.length,
      singletonBuckets: singletonBuckets(singletons, summaryTokens),
      longNumericRecall: longScore,
      longDistinctCount,
      longTop20Coverage,
      top20ShortShare: top20.filter((entry) => entry.token.length <= 2).length / Math.max(1, top20.length),
      top20,
      kindBytes,
      kindMissedLong,
      missedLongOccurrences,
      recordedMetrics: recorded,
      // Extraction fidelity: every recorded signal must match the offline
      // recomputation, not just the gated one — the thread's instrument is
      // the fragment-free metric, which no gate records a decision on.
      recordedMatches: checkpoint === undefined || recorded === null
        ? null
        : Math.abs(recorded.rouge1F1 - rougeScore) <= 0.01
          && Math.abs(recorded.top20Recall - keywordScore) <= 0.01
          && Math.abs(recorded.numericRecall - numericRecall) <= 0.01
          && Math.abs(recorded.top20LongNumericRecall - longScore) <= 0.01,
    })
  }
  return folds
}

/** Read one session file, decompressing .zstd through the zstd CLI. */
function readLog(path: string): string {
  if (path.endsWith('.zstd')) {
    const result = spawnSync('zstd', ['-dc', path], { maxBuffer: 512 * 1024 * 1024 })
    if (result.status !== 0) {
      throw new Error(`zstd exited ${result.status}: ${path}`)
    }
    return result.stdout.toString()
  }
  return readFileSync(path, 'utf8')
}

/** Recursively collect session log files under one root. */
function collectLogs(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) collectLogs(path, out)
    else if (entry.isFile() && /session.*\.jsonl(\.zstd)?$/.test(entry.name)) out.push(path)
  }
  return out.sort()
}

const pct = (fraction: number): string => `${(100 * fraction).toFixed(1)}%`

/** One JSON line of the --fold-dump: the per-fold pipeline columns issue #3 asks for. */
export interface FoldDumpRow {
  readonly session: string
  readonly compactionId: string
  readonly provider: string
  readonly model: string
  readonly eventCount: number
  readonly totalBytes: number
  readonly rouge1F1: number
  readonly top20Recall: number
  readonly numericRecall: number
  readonly longNumericRecall: number
  readonly singletonRecall: number
  readonly longDistinctCount: number
  readonly longTop20Coverage: number
  readonly top20ShortShare: number
  readonly kindBytes: KindCounts
  readonly kindMissedLong: KindCounts
  readonly missedLongOccurrences: number
}

export function foldDumpRow(fold: FoldScore): FoldDumpRow {
  return {
    session: sessionDirOf(fold.session),
    compactionId: fold.compactionId,
    provider: fold.provider,
    model: fold.model,
    eventCount: fold.eventCount,
    totalBytes: fold.totalBytes,
    rouge1F1: fold.rouge1F1,
    top20Recall: fold.top20Recall,
    numericRecall: fold.numericRecall,
    longNumericRecall: fold.longNumericRecall,
    singletonRecall: fold.singletonRecall,
    longDistinctCount: fold.longDistinctCount,
    longTop20Coverage: fold.longTop20Coverage,
    top20ShortShare: fold.top20ShortShare,
    kindBytes: fold.kindBytes,
    kindMissedLong: fold.kindMissedLong,
    missedLongOccurrences: fold.missedLongOccurrences,
  }
}

/** Kind attribution summed over a fold set (issue #3's per-corpus tables). */
export interface KindAggregate {
  readonly folds: number
  /** Byte share of the set's original text per kind (denominator: all bytes). */
  readonly byteShares: KindCounts
  /** Share of missed top-20 long-token occurrences per kind (denominator: all misses). */
  readonly missedShares: KindCounts
  readonly missedTotal: number
  /** Folds whose tool bytes exceed half the original (the tool-heaviness cut). */
  readonly toolDominant: number
}

export function kindAggregate(folds: readonly FoldScore[]): KindAggregate {
  const bytes = zeroKindCounts()
  const missed = zeroKindCounts()
  let totalBytes = 0
  let missedTotal = 0
  let toolDominant = 0
  for (const fold of folds) {
    totalBytes += fold.totalBytes
    missedTotal += fold.missedLongOccurrences
    if (fold.kindBytes.tool / Math.max(1, fold.totalBytes) > 0.5) toolDominant += 1
    for (const kind of EVENT_KINDS) {
      bytes[kind] += fold.kindBytes[kind]
      missed[kind] += fold.kindMissedLong[kind]
    }
  }
  const byteShares = zeroKindCounts()
  const missedShares = zeroKindCounts()
  for (const kind of EVENT_KINDS) {
    byteShares[kind] = totalBytes === 0 ? 0 : bytes[kind] / totalBytes
    missedShares[kind] = missedTotal === 0 ? 0 : missed[kind] / missedTotal
  }
  return { folds: folds.length, byteShares, missedShares, missedTotal, toolDominant }
}

function main(): void {
  const args = process.argv.slice(2)
  const dumpFlag = args.indexOf('--fold-dump')
  const dumpPath = dumpFlag === -1 ? undefined : args[dumpFlag + 1]
  if (dumpFlag !== -1 && typeof dumpPath !== 'string') {
    console.error('--fold-dump needs a path argument')
    process.exitCode = 1
    return
  }
  const roots = args.filter((_, index) => index !== dumpFlag && index !== dumpFlag + 1)
  if (roots.length === 0) roots.push(join(homedir(), '.dsh', 'sessions'))
  const folds: FoldScore[] = []
  let sessions = 0
  let unreadable = 0
  for (const root of roots) {
    for (const path of collectLogs(root)) {
      sessions += 1
      try {
        folds.push(...parseSessionLog(readLog(path), path))
      } catch (error) {
        unreadable += 1
        if (unreadable <= 5) console.error(`skipped ${path}: ${error instanceof Error ? error.message : error}`)
      }
    }
  }
  if (folds.length === 0) {
    console.log(`no scorable folds across ${sessions} session logs`)
    return
  }
  const { unique, groups, sameDirExtra, crossDirExtra } = dedupeFolds(folds)
  console.log(
    `sessions read: ${sessions}${unreadable > 0 ? ` (${unreadable} unreadable)` : ''}, folds: ${folds.length}`
      + `, unique: ${unique.length} (dup groups ${groups.length}, extra: ${sameDirExtra} same-dir, ${crossDirExtra} cross-key)`,
  )
  if (dumpPath !== undefined) {
    writeFileSync(dumpPath, `${unique.map((fold) => JSON.stringify(foldDumpRow(fold))).join('\n')}\n`)
    console.log(`fold dump: ${unique.length} unique folds → ${dumpPath}`)
    return
  }
  report(unique)
}

function report(folds: readonly FoldScore[]): void {
  const signals: readonly [label: string, pick: (fold: FoldScore) => number][] = [
    ['rouge1F1', (fold) => fold.rouge1F1],
    ['top20Recall', (fold) => fold.top20Recall],
    ['numericRecall', (fold) => fold.numericRecall],
    ['longRecall', (fold) => fold.longNumericRecall],
  ]
  console.log('              min      p10     median   p90      max')
  for (const [label, pick] of signals) {
    const stats = distribution(folds.map(pick))
    console.log(
      `${label.padEnd(12)} ${stats.min.toFixed(3).padStart(6)}  ${stats.p10.toFixed(3).padStart(6)}`
        + `  ${stats.median.toFixed(3).padStart(6)}  ${stats.p90.toFixed(3).padStart(6)}  ${stats.max.toFixed(3).padStart(6)}`,
    )
  }
  const andFires = (floor: number): number =>
    folds.filter((fold) => fold.rouge1F1 < ROUGE_FLOOR && fold.top20Recall < KEYWORD_FLOOR && fold.numericRecall < floor).length
  console.log(`\nAND conjunction (rouge1F1 < ${ROUGE_FLOOR} & top20Recall < ${KEYWORD_FLOOR} & numericRecall < floor) fires:`)
  for (const floor of NUMERIC_FLOORS) {
    const fires = andFires(floor)
    console.log(`  floor ${floor.toFixed(2)}: ${fires} of ${folds.length} (${pct(fires / folds.length)})`)
  }
  console.log(`numericRecall alone < floor (no conjunction):`)
  for (const floor of NUMERIC_FLOORS) {
    const fires = folds.filter((fold) => fold.numericRecall < floor).length
    console.log(`  floor ${floor.toFixed(2)}: ${fires} of ${folds.length} (${pct(fires / folds.length)})`)
  }
  console.log(`longNumericRecall (top-20 of 3+ digit tokens) alone < floor:`)
  for (const floor of NUMERIC_FLOORS) {
    const fires = folds.filter((fold) => fold.longNumericRecall < floor).length
    console.log(`  floor ${floor.toFixed(2)}: ${fires} of ${folds.length} (${pct(fires / folds.length)})`)
  }
  const recorded = folds.filter((fold) => fold.recordedMetrics !== null)
  if (recorded.length > 0) {
    const matching = recorded.filter((fold) => fold.recordedMatches === true).length
    const worstOf = (diff: (fold: FoldScore) => number): number => Math.max(...recorded.map(diff))
    console.log(
      `\nrecorded vs recomputed, all four gate metrics (tolerance 0.01): ${matching}/${recorded.length} folds agree on every metric`,
    )
    console.log(
      `  worst |diff| per signal: rouge1F1 ${worstOf((fold) => Math.abs((fold.recordedMetrics?.rouge1F1 ?? 0) - fold.rouge1F1)).toFixed(3)}`
        + `, top20Recall ${worstOf((fold) => Math.abs((fold.recordedMetrics?.top20Recall ?? 0) - fold.top20Recall)).toFixed(3)}`
        + `, numericRecall ${worstOf((fold) => Math.abs((fold.recordedMetrics?.numericRecall ?? 0) - fold.numericRecall)).toFixed(3)}`
        + `, longNumericRecall ${worstOf((fold) => Math.abs((fold.recordedMetrics?.top20LongNumericRecall ?? 0) - fold.longNumericRecall)).toFixed(3)}`,
    )
  } else {
    console.log('\nrecorded vs recomputed: no folds carry recorded metrics (pre-0.3.2 logs)')
  }
  console.log('retentionPct: not recomputable offline (needs the live token meter); skipped')

  // The tail analysis (issue #1 follow-up): is the top-20 saturated with
  // split fragments, and does the freq-1 tail survive at all?
  const withTail = folds.filter((fold) => fold.singletonCount > 0)
  const tailStats = distribution(withTail.map((fold) => fold.singletonRecall))
  console.log(`\nsingleton tail: ${withTail.length} folds with freq-1 numerics, ${folds.length - withTail.length} without`)
  console.log(
    `singletonRecall  min ${tailStats.min.toFixed(3)}  p10 ${tailStats.p10.toFixed(3)}  median ${tailStats.median.toFixed(3)}`
      + `  p90 ${tailStats.p90.toFixed(3)}  max ${tailStats.max.toFixed(3)}`,
  )
  const buckets = new Map<string, { total: number, matched: number }>()
  for (const fold of withTail) {
    for (const bucket of fold.singletonBuckets) {
      const entry = buckets.get(bucket.label) ?? { total: 0, matched: 0 }
      entry.total += bucket.total
      entry.matched += bucket.matched
      buckets.set(bucket.label, entry)
    }
  }
  console.log('singleton recall by token length (aggregate over all singleton occurrences):')
  for (const [label, { total, matched }] of buckets) {
    const recall = total === 0 ? 1 : matched / total
    console.log(`  ${label.padEnd(10)} ${matched}/${total} (${pct(recall)})`)
  }
  console.log(`top-20 composition: median share of 1-2-digit slots ${distribution(folds.map((fold) => fold.top20ShortShare)).median.toFixed(2)}`)
  // The concentration check (issue #1 follow-up): recall of the top-20 is
  // bounded by how concentrated the long-digit distribution is, so record
  // both alongside the long signal for cross-corpus comparison.
  const distinctStats = distribution(folds.map((fold) => fold.longDistinctCount))
  const coverageStats = distribution(folds.map((fold) => fold.longTop20Coverage))
  console.log(
    `distinct 3+ digit runs per original: min ${distinctStats.min}  p10 ${distinctStats.p10}  median ${distinctStats.median}`
      + `  p90 ${distinctStats.p90}  max ${distinctStats.max}`,
  )
  console.log(
    `top-20 share of all long-digit occurrences: min ${coverageStats.min.toFixed(2)}  p10 ${coverageStats.p10.toFixed(2)}`
      + `  median ${coverageStats.median.toFixed(2)}  p90 ${coverageStats.p90.toFixed(2)}  max ${coverageStats.max.toFixed(2)}`,
  )
  // The lever-length check (issue #1 follow-up): within our own folds, how
  // much of the long-recall spread does the concentration knob explain?
  // His corpus reads r = 0.18 (n = 534); ours needs the same number before
  // "pipeline fingerprint, not corpus arithmetic" stands on both sides.
  const concentrationPairs = folds.filter((fold) => fold.longDistinctCount > 0)
  const r = pearson(
    concentrationPairs.map((fold) => fold.longTop20Coverage),
    concentrationPairs.map((fold) => fold.longNumericRecall),
  )
  const distinctR = pearson(
    concentrationPairs.map((fold) => fold.longDistinctCount),
    concentrationPairs.map((fold) => fold.longNumericRecall),
  )
  console.log(
    `concentration ↔ longRecall within-corpus: r(coverage, recall) = ${r.toFixed(3)}`
      + `, r(distinct, recall) = ${distinctR.toFixed(3)}  (n = ${concentrationPairs.length})`,
  )
  // Median recall by concentration quartile: his side moves 10pp across a
  // ~7× concentration range while recall's own p10→p90 spans 50pp. The
  // same joint, stated without a coefficient.
  const sortedByCoverage = [...concentrationPairs].sort((left, right) => left.longTop20Coverage - right.longTop20Coverage)
  const quartile = (slice: readonly FoldScore[]): string => {
    const stats = distribution(slice.map((fold) => fold.longNumericRecall))
    return `${stats.median.toFixed(2)} (${stats.p10.toFixed(2)}–${stats.p90.toFixed(2)})`
  }
  const q = Math.ceil(sortedByCoverage.length / 4)
  console.log(
    `median longRecall by top-20-share quartile (coverage median → recall median): ${[0, 1, 2, 3]
      .map((index) => {
        const slice = sortedByCoverage.slice(index * q, index === 3 ? sortedByCoverage.length : (index + 1) * q)
        const coverage = slice.map((fold) => fold.longTop20Coverage)
        return `${distribution(coverage).median.toFixed(2)} → ${quartile(slice)}`
      })
      .join('  ')}`,
  )
  // Event-kind attribution (issue #3's instrument, reproducible): where the
  // original's bytes and the missed top-20 long-token occurrences live,
  // tail vs non-tail. Tail is longRecall < 0.10, big folds have >= 50
  // contributing events — the two cuts the thread compares corpora under.
  const isTail = (fold: FoldScore): boolean => fold.longNumericRecall < 0.10
  const tailFolds = folds.filter(isTail)
  const bigFolds = folds.filter((fold) => fold.eventCount >= 50)
  const bigTail = bigFolds.filter(isTail)
  const bigNonTail = bigFolds.filter((fold) => !isTail(fold))
  const sessionOf = (fold: FoldScore): string => sessionDirOf(fold.session)
  const bigTailBySession = new Map<string, number>()
  for (const fold of bigTail) bigTailBySession.set(sessionOf(fold), (bigTailBySession.get(sessionOf(fold)) ?? 0) + 1)
  const topSession = [...bigTailBySession.entries()].sort((left, right) => right[1] - left[1])[0]
  console.log(`\nevent-kind attribution (tail = longRecall < 0.10):`)
  console.log(
    `  folds: ${folds.length} (tail ${tailFolds.length} across ${new Set(tailFolds.map(sessionOf)).size} sessions)`
      + `; big (>=50 events): ${bigFolds.length} (tail ${bigTail.length}, ${pct(bigTail.length / Math.max(1, bigFolds.length))})`,
  )
  if (topSession !== undefined) {
    console.log(`  top session carries ${topSession[1]} of ${bigTail.length} big tail folds (${bigTailBySession.size} sessions have any)`)
  }
  const byModel = new Map<string, { n: number, tail: number }>()
  for (const fold of bigFolds) {
    const key = fold.model === '' ? fold.provider : `${fold.provider}/${fold.model}`
    const entry = byModel.get(key) ?? { n: 0, tail: 0 }
    entry.n += 1
    if (isTail(fold)) entry.tail += 1
    byModel.set(key, entry)
  }
  const modelRows = [...byModel.entries()].filter(([, { n }]) => n >= 10).sort((left, right) => right[1].n - left[1].n)
  if (modelRows.length > 0) {
    console.log(
      `  big-fold tail rate by model (n >= 10): ${modelRows.map(([model, { n, tail }]) => `${model} ${pct(tail / n)} (n=${n})`).join('  ')}`,
    )
  }
  const tailAgg = kindAggregate(bigTail)
  const nonTailAgg = kindAggregate(bigNonTail)
  const bytePair = (kind: EventKind): string =>
    `${kind} ${(100 * tailAgg.byteShares[kind]).toFixed(1)}% / ${(100 * nonTailAgg.byteShares[kind]).toFixed(1)}%`
  const missedPair = (kind: EventKind): string =>
    `${kind} ${(100 * tailAgg.missedShares[kind]).toFixed(1)}% / ${(100 * nonTailAgg.missedShares[kind]).toFixed(1)}%`
  console.log(`  byte shares, big tail / big non-tail: ${EVENT_KINDS.map(bytePair).join('  ')}`)
  console.log(`  missed top-20 long-token occurrence shares, big tail / non-tail: ${EVENT_KINDS.map(missedPair).join('  ')}`)
  console.log(
    `  tool-dominant folds (>50% tool bytes): ${tailAgg.toolDominant} of ${tailAgg.folds} tail`
      + `, ${nonTailAgg.toolDominant} of ${nonTailAgg.folds} non-tail`,
  )
  const reconciles = folds.filter(
    (fold) => EVENT_KINDS.reduce((sum, kind) => sum + fold.kindMissedLong[kind], 0) === fold.missedLongOccurrences,
  ).length
  console.log(`  attribution reconciles on ${reconciles} of ${folds.length} folds (per-kind misses sum to the fold total)`)
  const aggregate = new Map<string, number>()
  for (const fold of folds) {
    for (const entry of fold.top20) aggregate.set(entry.token, (aggregate.get(entry.token) ?? 0) + 1)
  }
  const common = [...aggregate.entries()].sort((left, right) => right[1] - left[1]).slice(0, 12)
  console.log(`most common top-20 members across folds: ${common.map(([token, count]) => `${token}x${count}`).join(' ')}`)
  for (const fold of [folds[Math.floor(folds.length / 3)]!, folds[Math.floor((2 * folds.length) / 3)]!]) {
    console.log(`top-20 of ${fold.session} (${fold.compactionId}): ${fold.top20.map((entry) => `${entry.token}x${entry.count}`).join(' ')}`)
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) main()
