#!/usr/bin/env node
/**
 * bili cache-join CLI: correlate dsh-asc session-log folds with bili proxy
 * cache economics, offline. Thin wrapper over bili-cache-join-core.ts —
 * all join logic lives in the (pure, unit-tested) core. See
 * docs/cache-join.md for the operator guide.
 *
 * Usage:
 *   tsx scripts/bili-cache-join.ts --session <log.jsonl> --cache <report.json> [--json]
 *   --session also accepts a directory of session logs (folds merge, keyed
 *   by compactionId); --cache also accepts a raw ACP_DUMP_BODY dump
 *   directory (each *.json/json body file parsed as one export unit).
 *
 * Repo-local dev tool; not part of the published package.
 *
 * @module dsh-asc/bili-cache-join
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  type FoldRecord,
  type JoinedRow,
  type RequestRecord,
  joinFoldsWithRequests,
  ledgerTotals,
  parseFoldRecords,
  parseRequestRecords,
  summarizeVerdicts,
} from './bili-cache-join-core.ts'

/** Collect session log files: one file, or a directory scanned for *.jsonl*. */
function collectSessionFiles(root: string): string[] {
  const stat = statSync(root, { throwIfNoEntry: false })
  if (stat === undefined) return []
  if (stat.isFile()) return [root]
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && /\.jsonl(\.zstd)?$/u.test(entry.name)) out.push(join(root, entry.name))
  }
  return out.sort()
}

/** Collect cache-side export files: one file, or a dump directory's *.json/json/txt. */
function collectCacheFiles(root: string): string[] {
  const stat = statSync(root, { throwIfNoEntry: false })
  if (stat === undefined) return []
  if (stat.isFile()) return [root]
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && /\.(json|jsonl|txt)$/iu.test(entry.name)) out.push(join(root, entry.name))
  }
  return out.sort()
}

/** Read one file, tolerating unreadable files (skipped with a warning). */
function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    console.error(`unreadable, skipped: ${path}: ${error instanceof Error ? error.message : error}`)
    return null
  }
}

/** Merge folds across session files, keeping the first per compactionId. */
function mergeFolds(all: readonly FoldRecord[]): FoldRecord[] {
  const byId = new Map<string, FoldRecord>()
  for (const fold of all) {
    if (!byId.has(fold.compactionId)) byId.set(fold.compactionId, fold)
  }
  return [...byId.values()]
}

/** Fixed-width human table over the joined rows plus a ledger footer. */
function renderTable(rows: readonly JoinedRow[], totals: ReturnType<typeof ledgerTotals>): string {
  const columns: readonly { label: string, width: number, cell: (row: JoinedRow) => string }[] = [
    { label: 'compactionId', width: 24, cell: row => row.compactionId },
    { label: 'foldSeq', width: 8, cell: row => String(row.foldSeq) },
    { label: 'shadowed', width: 9, cell: row => row.shadowedTokens === null ? '-' : String(row.shadowedTokens) },
    { label: 'rePay', width: 7, cell: row => row.rePayTokens === null ? '-' : String(row.rePayTokens) },
    { label: 'reqIdx', width: 6, cell: row => row.requestIdx === null ? '-' : String(row.requestIdx) },
    { label: 'n*', width: 5, cell: row => row.breakevenTurns === null ? '-' : row.breakevenTurns.toFixed(1) },
    { label: 'k', width: 4, cell: row => row.measuredTurns === null ? '-' : String(row.measuredTurns) },
    { label: 'verdict', width: 13, cell: row => row.verdict },
  ]
  const lines = [columns.map(column => column.label.padEnd(column.width)).join('  ')]
  for (const row of rows) {
    lines.push(columns.map(column => column.cell(row).slice(0, column.width).padEnd(column.width)).join('  '))
  }
  const summary = summarizeVerdicts(rows)
  lines.push('')
  lines.push(`folds: ${rows.length} (matched ${summary.matched}, unmatched ${summary.unmatched})`
    + ` — paid back ${summary.paidBack}, not paid back ${summary.notPaidBack}, unobserved ${summary.unobserved}`)
  const hit = totals.hitRate === null ? '-' : `${(100 * totals.hitRate).toFixed(1)}%`
  const rePayShare = totals.rePayShare === null ? '-' : `${(100 * totals.rePayShare).toFixed(2)}%`
  const input = totals.inputTokens === null ? '-' : String(totals.inputTokens)
  const cached = totals.cachedTokens === null ? '-' : String(totals.cachedTokens)
  lines.push(`ledger: ${totals.records} records, input ${input}, cached ${cached}, hit rate ${hit}, re-pay share ${rePayShare}`)
  return lines.join('\n')
}

function main(): void {
  const args = process.argv.slice(2)
  const valueOf = (flag: string): string | undefined => {
    const index = args.indexOf(flag)
    return index === -1 ? undefined : args[index + 1]
  }
  const sessionPath = valueOf('--session')
  const cachePath = valueOf('--cache')
  const json = args.includes('--json')
  if (sessionPath === undefined || cachePath === undefined) {
    console.error('usage: tsx scripts/bili-cache-join.ts --session <log.jsonl|dir> --cache <report.json|dir> [--json]')
    process.exitCode = 1
    return
  }

  const folds = mergeFolds(
    collectSessionFiles(sessionPath).flatMap(path => {
      const text = readText(path)
      return text === null ? [] : parseFoldRecords(text, path)
    }),
  )
  const records: RequestRecord[] = []
  let skippedRecords = 0
  for (const path of collectCacheFiles(cachePath)) {
    const text = readText(path)
    if (text === null) continue
    const parsed = parseRequestRecords(text)
    records.push(...parsed.requests)
    skippedRecords += parsed.skipped
  }

  const { rows, totals } = joinFoldsWithRequests(folds, records)
  if (json) {
    const payload = {
      rows: rows.map(row => ({ ...row })),
      totals: {
        ...totals,
        records: totals.records,
      },
      skippedRecords,
    }
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  if (skippedRecords > 0) {
    console.error(`skipped ${skippedRecords} malformed cache-side records`)
  }
  if (folds.length === 0) {
    console.log(`no compaction folds found in ${sessionPath}`)
    return
  }
  console.log(renderTable(rows, totals))
}

if (process.argv[1] === new URL(import.meta.url).pathname) main()
