#!/usr/bin/env node
/**
 * Corpus sampler for the summary quality gate: recompute the gate's per-signal
 * scores for every compaction fold in historical session logs and report the
 * distribution, so the numeric-recall floor can be read off the corpus it will
 * police (issue #1). Repo-local dev tool; not part of the published package.
 *
 * Mirrors the gate's text rendering (src/utils/text.ts serializeMessages) on
 * the log's event shapes: exact for pure-digit tokens, near-mirror for word
 * overlap. retentionPct is not recomputable offline (it prices the framed
 * checkpoint through the live token meter) and is skipped. Folds logged by
 * 0.3.2+ also carry the gate's own recorded metrics on the checkpoint source;
 * those are compared against the recomputation as an extraction-fidelity check.
 *
 * Usage: node scripts/quality-scores.ts [roots...]   (default ~/.dsh/sessions)
 *
 * @module dsh-asc/quality-scores
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { rouge1F1, topKeywordRecall, topNumericRecall, wordTokens } from '../src/engine/quality-gate.ts'

/** Gate floors fixed by the default config; only the numeric floor varies. */
const ROUGE_FLOOR = 0.05
const KEYWORD_FLOOR = 0.2
const NUMERIC_FLOORS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7] as const

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
  readonly rouge1F1: number
  readonly top20Recall: number
  readonly numericRecall: number
  /** Recorded numericRecall from a 0.3.2+ checkpoint source, when present. */
  readonly recordedNumericRecall: number | null
  /** Recorded vs recomputed agreement (tolerance 0.01), when both exist. */
  readonly recordedMatches: boolean | null
}

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

/** Checkpoint provenance source on a persisted replacement message. */
interface CheckpointSource {
  readonly plugin: string
  readonly compactionId: string
  readonly recordedNumericRecall: number | null
}

function checkpointSource(event: LogEvent): CheckpointSource | null {
  const data = isRecord(event.data) ? event.data : {}
  if (event.type !== 'user/message' || !isRecord(data.source)) return null
  const source = data.source
  if (source.kind !== 'plugin' || source.plugin !== 'compact') return null
  const surfaceOp = isRecord(event.surfaceOp) ? event.surfaceOp : {}
  if (surfaceOp.op !== 'replace') return null
  let recorded: number | null = null
  if (isRecord(source.quality) && isRecord(source.quality.metrics)) {
    const value = source.quality.metrics.numericRecall
    if (typeof value === 'number') recorded = value
  }
  return { plugin: 'compact', compactionId: asString(source.compactionId), recordedNumericRecall: recorded }
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
    const rendered = asArray(data.shadowedSeqs)
      .map((seq) => (typeof seq === 'number' ? bySeq.get(seq) : undefined))
      .map((event) => (event === undefined ? null : eventText(event)))
    if (summaryText.trim() === '' || rendered.some((text) => text === null) || rendered.length === 0) continue
    const originalText = rendered.filter((text) => text !== null && text.trim() !== '').join('\n\n')
    if (originalText.trim() === '') continue
    const scores = scoreFold(summaryText, originalText)
    const checkpoint = checkpoints.get(compactionId)
    folds.push({
      session: name,
      compactionId,
      provider: asString(data.provider),
      model: asString(data.model),
      ...scores,
      recordedNumericRecall: checkpoint?.recordedNumericRecall ?? null,
      recordedMatches: checkpoint === undefined || checkpoint.recordedNumericRecall === null
        ? null
        : Math.abs(checkpoint.recordedNumericRecall - scores.numericRecall) <= 0.01,
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
  return out
}

const pct = (fraction: number): string => `${(100 * fraction).toFixed(1)}%`

function main(): void {
  const roots = process.argv.slice(2)
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
  console.log(`sessions read: ${sessions}${unreadable > 0 ? ` (${unreadable} unreadable)` : ''}, folds: ${folds.length}`)
  const signals: readonly [label: string, pick: (fold: FoldScore) => number][] = [
    ['rouge1F1', (fold) => fold.rouge1F1],
    ['top20Recall', (fold) => fold.top20Recall],
    ['numericRecall', (fold) => fold.numericRecall],
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
  const recorded = folds.filter((fold) => fold.recordedNumericRecall !== null)
  if (recorded.length > 0) {
    const matching = recorded.filter((fold) => fold.recordedMatches === true).length
    const worst = Math.max(...recorded.map((fold) => Math.abs((fold.recordedNumericRecall ?? 0) - fold.numericRecall)))
    console.log(`\nrecorded vs recomputed numericRecall: ${matching}/${recorded.length} agree (max |diff| ${worst.toFixed(3)})`)
  } else {
    console.log('\nrecorded vs recomputed: no folds carry recorded metrics (pre-0.3.2 logs)')
  }
  console.log('retentionPct: not recomputable offline (needs the live token meter); skipped')
}

if (process.argv[1] === new URL(import.meta.url).pathname) main()
