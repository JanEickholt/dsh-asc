/**
 * Offline join of dsh-asc session-log folds with bili proxy cache economics.
 *
 * Neither side has a frozen contract here, so the core is schema-tolerant:
 * dsh-asc session logs are read as lossless JSONL (the same defensive
 * `unknown`-field decoding `scripts/quality-scores.ts` uses), and the bili
 * side accepts whatever `bili acp-cache diff` / the `acp_cache` report
 * exports — JSON, JSONL, or `key: value` text. Unknown fields read as null;
 * malformed records are skipped, never thrown on.
 *
 * Join rule (see docs/cache-join.md): each `compaction/summary` event maps
 * to the first bili request AFTER its timestamp that charged compression
 * re-pay > 0 — the mid-stream prefix break the fold caused. With no
 * timestamps on either side, list order substitutes: a fold takes the next
 * unused re-pay request.
 *
 * Verdict precedence per fold:
 * 1. an explicit verdict on the matched export record (the `acp_cache`
 *    report computes its own PAID BACK / NOT PAID BACK / unobserved),
 * 2. computable breakeven: n* = ΔC₁ / Δs against the measured post-fold
 *    cadence k (requests after the matched one), when Δs is present,
 * 3. otherwise `unobserved`.
 *
 * @module dsh-asc/bili-cache-join-core
 */

/** One dsh-asc compaction fold extracted from a session log. */
export interface FoldRecord {
  /** Durable compaction id from `compaction/summary`. */
  readonly compactionId: string
  /** Log seq of the `compaction/summary` event; -1 when absent/malformed. */
  readonly foldSeq: number
  /** Unix epoch ms of the `compaction/summary` event; null when absent. */
  readonly timestamp: number | null
  /** Tokens shadowed by the fold (`shadowedTokenCount`); null when absent. */
  readonly shadowedTokens: number | null
  /** Session-file label the fold was read from. */
  readonly source: string
}

/** One bili-side record: a request ledger entry or a per-fold economics row. */
export interface RequestRecord {
  /** 0-based index inside the export, in file order. */
  readonly requestIdx: number
  /** Unix epoch ms; null when the export carries no timestamp. */
  readonly timestamp: number | null
  /** Compression re-pay charged (ΔC₁); 0 when none. */
  readonly rePayTokens: number
  /** Input tokens billed; null when unknown. */
  readonly inputTokens: number | null
  /** Cached (hit) tokens reported; null when unknown. */
  readonly cachedTokens: number | null
  /** Adjacent-pair classification when the export provides one. */
  readonly pairClass: 'pure-append' | 'mid-stream-rewrite' | 'prefix-stable-miss' | null
  /** Per-turn savings Δs when the export's fold economics provide it. */
  readonly perTurnSavings: number | null
  /** Breakeven turns n* when the export states it. */
  readonly breakevenTurns: number | null
  /** Measured post-fold cadence k when the export states it. */
  readonly measuredTurns: number | null
  /** Explicit verdict from the export's fold economics, when present. */
  readonly verdict: FoldVerdict | null
  /** Normalized leftover fields, for `--json` round-tripping. */
  readonly extras: Readonly<Record<string, unknown>>
}

/** Verdict of one fold's cache economics. */
export type FoldVerdict = 'PAID BACK' | 'NOT PAID BACK' | 'unobserved'

/** One joined fold row: the fold plus its matched bili record. */
export interface JoinedRow {
  readonly compactionId: string
  readonly foldSeq: number
  readonly source: string
  readonly shadowedTokens: number | null
  /** Re-pay tokens charged at the matched record; null when unmatched. */
  readonly rePayTokens: number | null
  /** Index of the matched bili record; null when no match exists. */
  readonly requestIdx: number | null
  /** Matched record's timestamp; null when absent or unmatched. */
  readonly requestTime: number | null
  /** Fold's verdict against the breakeven rule. */
  readonly verdict: FoldVerdict
  /** Breakeven turns n* = ΔC₁ / Δs; null while not derivable. */
  readonly breakevenTurns: number | null
  /** Measured post-fold cadence k (records after the matched one). */
  readonly measuredTurns: number | null
}

/** Ledger totals over the decoded bili records, when numbers exist. */
export interface LedgerTotals {
  readonly records: number
  readonly inputTokens: number | null
  readonly cachedTokens: number | null
  /** Overall hit rate (cached / input); null when not computable. */
  readonly hitRate: number | null
  /** Compression re-pay share of total input ((Σ ΔC₁) / input). */
  readonly rePayShare: number | null
}

/** Result of joining all folds against all records. */
export interface JoinResult {
  /** One row per input fold, in input order. */
  readonly rows: readonly JoinedRow[]
  readonly totals: LedgerTotals
}

/** Match window: a re-pay record counts only this close after the fold. */
const MATCH_WINDOW_MS = 10 * 60_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** Decode a finite non-negative number; anything else reads as null. */
function asCount(value: unknown): number | null {
  const n = asNumber(value)
  return n !== null && n >= 0 ? n : null
}

/** First finite number found under any of the given keys. */
function firstNumber(entry: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = asNumber(entry[key])
    if (value !== null) return value
  }
  return null
}

/** First non-negative finite number found under any of the given keys. */
function firstCount(entry: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = asCount(entry[key])
    if (value !== null) return value
  }
  return null
}

/**
 * Extract fold records from one lossless-JSONL session log. Malformed lines
 * and summary events without a usable id are skipped, never thrown on.
 */
export function parseFoldRecords(jsonl: string, source: string): readonly FoldRecord[] {
  const folds: FoldRecord[] = []
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue // tolerate trailing partial lines from a crashed writer
    }
    if (!isRecord(parsed) || parsed.type !== 'compaction/summary') continue
    const data = isRecord(parsed.data) ? parsed.data : {}
    const compactionId = asString(data.compactionId)
    if (compactionId === '') continue // malformed record: no durable id
    folds.push({
      compactionId,
      foldSeq: asCount(parsed.seq) ?? -1,
      timestamp: asNumber(parsed.time),
      shadowedTokens: asCount(data.shadowedTokenCount),
      source,
    })
  }
  return folds
}

/** Normalize a verdict spelling from an export record. */
function asVerdict(value: unknown): FoldVerdict | null {
  const text = asString(value).toUpperCase().replace(/[\s_-]+/g, ' ').trim()
  if (text === 'PAID BACK' || text === 'PAIDBACK') return 'PAID BACK'
  if (text === 'NOT PAID BACK' || text === 'NOTPAIDBACK') return 'NOT PAID BACK'
  if (text === 'UNOBSERVED') return 'unobserved'
  return null
}

/**
 * Normalize one decoded entry into a {@link RequestRecord}, or null when the
 * entry is too malformed to use (no timestamp and no usable token numbers).
 * Accepts field spellings from the `acp_cache` report's request ledger and
 * its per-fold economics rows alike.
 */
function normalizeRequest(entry: Record<string, unknown>, requestIdx: number): RequestRecord | null {
  const timestamp = firstNumber(entry, ['time', 'timestamp', 'ts', 'at'])
  const rePayTokens = firstCount(entry, [
    'compRepay', 'compressionRePay', 'compressRePay', 'cacheRePay', 'rePayTokens',
    'repayTokens', 'repay', 're-pay', 'deltaC1', 'deltaC', 'firstRequestRePay',
  ]) ?? 0
  const inputTokens = firstCount(entry, ['inputTokens', 'input', 'input_tokens', 'promptTokens'])
  const cachedTokens = firstCount(entry, [
    'cachedTokens', 'cached', 'cacheHitTokens', 'hitTokens', 'cacheReadTokens', 'cache_read',
  ])
  const rawClass = asString(entry.pairClass ?? entry.class ?? entry.diffClass ?? entry.classification)
  const pairClass: RequestRecord['pairClass'] =
    rawClass === 'pure-append' || rawClass === 'mid-stream-rewrite' || rawClass === 'prefix-stable-miss'
      ? rawClass
      : null
  const perTurnSavings = firstCount(entry, ['perTurnSavings', 'deltaS', 'savingsPerTurn', 'perTurnDelta', 'ds'])
  const breakevenTurns = firstCount(entry, ['breakevenTurns', 'breakeven', 'nStar', 'n*', 'breakeven_turns'])
  const measuredTurns = firstCount(entry, ['measuredTurns', 'cadence', 'k', 'measuredCadence', 'postFoldTurns'])
  const verdict = asVerdict(entry.verdict)
  if (timestamp === null && inputTokens === null && cachedTokens === null && rePayTokens === 0) return null
  const { time: _t, timestamp: _ts, ts: _ts2, at: _at, compRepay: _c, ...extras } = entry
  return {
    requestIdx,
    timestamp,
    rePayTokens,
    inputTokens,
    cachedTokens,
    pairClass,
    perTurnSavings,
    breakevenTurns,
    measuredTurns,
    verdict,
    extras,
  }
}

/**
 * Parse a bili cache-side export into records. Accepts JSON (an array of
 * records, or an object with a requests/folds/entries/… array), JSONL
 * (one object per line), and blank-line-separated `key: value` text.
 * Unusable units are skipped and counted, never thrown on.
 */
export function parseRequestRecords(text: string): { requests: readonly RequestRecord[], skipped: number } {
  const trimmed = text.trim()
  if (trimmed === '') return { requests: [], skipped: 0 }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const entries = collectEntries(parsed)
      if (entries !== null) return normalizeAll(entries)
      if (isRecord(parsed)) return normalizeAll([parsed])
      return { requests: [], skipped: 1 }
    } catch {
      // Brace-opener that is not valid JSON: fall through to JSONL/text.
    }
  }
  return parseDelimited(text)
}

/** Normalize decoded entries, skipping the malformed ones. */
function normalizeAll(entries: readonly unknown[]): { requests: readonly RequestRecord[], skipped: number } {
  const requests: RequestRecord[] = []
  let skipped = 0
  for (const entry of entries) {
    if (!isRecord(entry)) {
      skipped += 1
      continue
    }
    const normalized = normalizeRequest(entry, requests.length)
    if (normalized === null) skipped += 1
    else requests.push(normalized)
  }
  return { requests, skipped }
}

/**
 * Follow container keys (`requests`, `folds`, `entries`, `items`, `list`,
 * `rows`, `data`, `pairs`, `diffs`) one level deep; the first array found
 * wins. Returns null when no record array exists.
 */
function collectEntries(parsed: unknown): readonly unknown[] | null {
  if (Array.isArray(parsed)) return parsed
  if (!isRecord(parsed)) return null
  for (const key of ['requests', 'folds', 'entries', 'items', 'list', 'rows', 'data', 'pairs', 'diffs']) {
    const value = parsed[key]
    if (Array.isArray(value)) return value
  }
  for (const value of Object.values(parsed)) {
    if (isRecord(value)) {
      const nested = collectEntries(value)
      if (nested !== null) return nested
    }
  }
  return null
}

/** JSONL or blank-line-separated `key: value` text fallback. */
function parseDelimited(text: string): { requests: readonly RequestRecord[], skipped: number } {
  const requests: RequestRecord[] = []
  let skipped = 0
  let current: Record<string, unknown> | null = null
  const finish = (): void => {
    if (current === null) return
    const normalized = normalizeRequest(current, requests.length)
    if (normalized === null) skipped += 1
    else requests.push(normalized)
    current = null
  }
  for (const line of text.split('\n')) {
    const trimmedLine = line.trim()
    // A blank line closes the current `key: value` block.
    if (trimmedLine === '') {
      finish()
      continue
    }
    if (trimmedLine.startsWith('{')) {
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmedLine)
      } catch {
        skipped += 1
        continue
      }
      if (isRecord(parsed)) {
        const normalized = normalizeRequest(parsed, requests.length)
        if (normalized === null) skipped += 1
        else requests.push(normalized)
      } else {
        skipped += 1
      }
      continue
    }
    const separator = trimmedLine.indexOf(':')
    if (separator > 0) {
      if (current === null) current = {}
      current[trimmedLine.slice(0, separator).trim()] =
        decodeTextValue(trimmedLine.slice(separator + 1).trim())
    } else if (current !== null) {
      // Bare-word line inside a block: a classification tag like `pure-append`.
      const existing = current.pairClass ?? current.class ?? current.diffClass ?? current.classification
      if (typeof existing !== 'string' || existing === '') current.pairClass = trimmedLine
    } else {
      // Junk line outside any block: neither JSON, nor a pair, nor a tag.
      skipped += 1
    }
  }
  finish()
  return { requests, skipped }
}

/** Decode a `key: value` text cell into number / boolean / null / string. */
function decodeTextValue(raw: string): unknown {
  if (raw === '' || raw === '-') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^[\d.,\s-]+$/u.test(raw)) {
    const numeric = Number(raw.replace(/[,_\s]/g, ''))
    if (Number.isFinite(numeric)) return numeric
  }
  return raw
}

/** Ledger totals over all decoded records. */
export function ledgerTotals(records: readonly RequestRecord[]): LedgerTotals {
  let input = 0
  let cached = 0
  let rePay = 0
  let anyInput = false
  let anyCached = false
  for (const record of records) {
    if (record.inputTokens !== null) {
      input += record.inputTokens
      anyInput = true
    }
    if (record.cachedTokens !== null) {
      cached += record.cachedTokens
      anyCached = true
    }
    rePay += record.rePayTokens
  }
  return {
    records: records.length,
    inputTokens: anyInput ? input : null,
    cachedTokens: anyCached ? cached : null,
    hitRate: anyInput && anyCached && input > 0 ? cached / input : null,
    rePayShare: anyInput && input > 0 ? rePay / input : null,
  }
}

/**
 * Join folds to bili records. Each fold matches the first record after its
 * timestamp with compression re-pay > 0, within the match window; folds
 * without a timestamp (or exports without timestamps) fall back to list
 * order. Unmatched folds read as `unobserved`.
 *
 * Pure: consumes both arrays read-only, mutates nothing, throws on nothing.
 * Rows come back in the input folds' order.
 */
export function joinFoldsWithRequests(
  folds: readonly FoldRecord[],
  records: readonly RequestRecord[],
): JoinResult {
  const repayCandidates = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.rePayTokens > 0)
  const used = new Set<number>()
  const matches = new Map<number, { record: RequestRecord, index: number }>()

  // Match in chronological fold order so an early fold cannot be skipped
  // past by a later one stealing its re-pay record; the map is keyed by the
  // fold's index in the input array.
  const order = folds
    .map((fold, foldIndex) => ({ fold, foldIndex }))
    .sort((left, right) => (left.fold.timestamp ?? Number.MAX_SAFE_INTEGER)
      - (right.fold.timestamp ?? Number.MAX_SAFE_INTEGER))
  for (const { fold, foldIndex } of order) {
    const match = fold.timestamp !== null
      ? matchByTimestamp(fold.timestamp, repayCandidates, used)
      : matchByOrder(repayCandidates, used)
    if (match === null) continue
    used.add(match.index)
    matches.set(foldIndex, match)
  }

  const rows: JoinedRow[] = folds.map((fold, foldIndex) => {
    const match = matches.get(foldIndex) ?? null
    const record = match?.record ?? null
    const rePayTokens = record?.rePayTokens ?? null
    const requestIdx = match?.index ?? null
    const requestTime = record?.timestamp ?? null

    // k: measured post-fold cadence — records after the matched one (the
    // turns that bank Δs each); an explicit k on the record wins.
    const measuredTurns = record?.measuredTurns
      ?? (match !== null ? records.filter((other, index) => index > match.index).length : null)
    // n*: explicit on the record, else ΔC₁ / Δs when both are present.
    const breakevenTurns = record?.breakevenTurns
      ?? (record !== null && record.perTurnSavings !== null && record.perTurnSavings > 0
        ? record.rePayTokens / record.perTurnSavings
        : null)

    let verdict: FoldVerdict = 'unobserved'
    if (record !== null) {
      if (record.verdict !== null) verdict = record.verdict
      else if (breakevenTurns !== null && measuredTurns !== null) {
        verdict = measuredTurns >= breakevenTurns ? 'PAID BACK' : 'NOT PAID BACK'
      }
    }
    return {
      compactionId: fold.compactionId,
      foldSeq: fold.foldSeq,
      source: fold.source,
      shadowedTokens: fold.shadowedTokens,
      rePayTokens,
      requestIdx,
      requestTime,
      verdict,
      breakevenTurns,
      measuredTurns,
    }
  })
  return { rows, totals: ledgerTotals(records) }
}

/** Timestamp match: earliest unused re-pay record after `foldTime`, in window. */
function matchByTimestamp(
  foldTime: number,
  repayCandidates: readonly { record: RequestRecord, index: number }[],
  used: Set<number>,
): { record: RequestRecord, index: number } | null {
  let best: { record: RequestRecord, index: number } | null = null
  for (const candidate of repayCandidates) {
    if (candidate.record.timestamp === null) continue
    if (candidate.record.timestamp < foldTime) continue
    if (candidate.record.timestamp - foldTime > MATCH_WINDOW_MS) continue
    if (used.has(candidate.index)) continue
    const candidateTime = candidate.record.timestamp
    const bestTime = best === null ? null : best.record.timestamp
    if (best === null || bestTime === null || candidateTime < bestTime) best = candidate
  }
  return best
}

/** Order match: next unused re-pay record in list order. */
function matchByOrder(
  repayCandidates: readonly { record: RequestRecord, index: number }[],
  used: Set<number>,
): { record: RequestRecord, index: number } | null {
  for (const candidate of repayCandidates) {
    if (used.has(candidate.index)) continue
    return candidate
  }
  return null
}

/** Aggregate counts for the human report. */
export function summarizeVerdicts(rows: readonly JoinedRow[]): {
  matched: number
  unmatched: number
  paidBack: number
  notPaidBack: number
  unobserved: number
} {
  let matched = 0
  let paidBack = 0
  let notPaidBack = 0
  let unobserved = 0
  for (const row of rows) {
    if (row.requestIdx !== null) matched += 1
    switch (row.verdict) {
      case 'PAID BACK': paidBack += 1; break
      case 'NOT PAID BACK': notPaidBack += 1; break
      default: unobserved += 1; break
    }
  }
  return { matched, unmatched: rows.length - matched, paidBack, notPaidBack, unobserved }
}
