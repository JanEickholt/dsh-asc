/**
 * Structured, content-aware compression for tool-result text — ported from
 * flowctx. Deterministic, no LLM. Every output is a lossy VIEW; byte-exact
 * reversibility belongs to the caller, which keeps the original as a shadowed
 * session-log event retrievable through `context_retrieve`.
 *
 * @module dsh-asc/projection/structured
 */

import { exploreStructuredData, exploreCode } from './vendor/structural-explorers.ts'
import { compactWholeJsonText, compactGitDiff, compactSearchLines } from './vendor/json-compress.ts'
import { matchRuleByContent, reduceWithRule } from './vendor/cli-rules.ts'

export type ContentType = 'json' | 'code' | 'log' | 'diff' | 'search' | 'test' | 'cli-output' | 'text'

export interface StructuredResult {
  /** Reduced text, or `null` when no real reduction applies. */
  text: string | null
  contentType: ContentType
}

const CODE_HINT_RE =
  /^\s*(import |export |from |def |class |func |function |public |private |const |let |var |#include|package )/m
const FENCE_RE = /```[\s\S]*```/
const CODE_EXT_RE = /\.(ts|tsx|js|jsx|py|go|rs|java|c|cc|cpp|h|hpp|rb|php|cs|kt|swift)\b/
const DIFF_RE = /^diff --git |^@@ .* @@|^@@ /m
const SEARCH_LINE_RE = /^.+?:\d+[:-]./m
const TEST_RE = /(={3,}.*(passed|failed|error).*={3,}|^FAILED |^ok\s+\S+\s+[\d.]+s|\d+ (passed|failed)|test result:|^--- FAIL)/im
const LOG_RE = /^\s*(\d{4}-\d{2}-\d{2}|\[\d|INFO|WARN|ERROR|DEBUG)/m
const LARGE_JSON_ARRAY_THRESHOLD = 20

function lineHitRatio(text: string, re: RegExp): number {
  const lines = text.split('\n')
  if (lines.length === 0) return 0
  const per = new RegExp(re.source, re.flags.replace('m', ''))
  let hits = 0
  for (const l of lines) if (per.test(l)) hits++
  return hits / lines.length
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Detect the content family that selects the reducer. */
export function detectContentType(text: string, toolName?: string): ContentType {
  const t = text.trimStart()
  if ((t.startsWith('{') || t.startsWith('[')) && tryParseJson(text) !== undefined) return 'json'
  if (DIFF_RE.test(text)) return 'diff'
  const name = (toolName ?? '').toLowerCase()
  if (CODE_EXT_RE.test(name)) return 'code'
  if (CODE_HINT_RE.test(text) && !FENCE_RE.test(text)) {
    const codeLines = text.split('\n').filter((l) => CODE_HINT_RE.test(l)).length
    if (codeLines >= 2) return 'code'
  }
  const lineCount = text.split('\n').length
  if (TEST_RE.test(text)) return 'test'
  if (lineCount >= 5 && lineHitRatio(text, SEARCH_LINE_RE) >= 0.5) return 'search'
  if (LOG_RE.test(text) && lineCount >= 20) return 'log'
  if (lineCount >= 8 && text.includes('\n')) return 'cli-output'
  return 'text'
}

/** Big arrays → shape explorer; otherwise lexical minify + clip, else explorer. */
export function projectJson(text: string): string | null {
  const parsed = tryParseJson(text)
  if (parsed === undefined) return null
  if (Array.isArray(parsed) && parsed.length >= LARGE_JSON_ARRAY_THRESHOLD) {
    return exploreStructuredData(text, 'application/json', 'payload.json')
  }
  const minified = compactWholeJsonText(text, Math.max(1200, Math.floor(text.length * 0.6)))
  if (minified !== null && minified.length < text.length) return minified
  return exploreStructuredData(text, 'application/json', 'payload.json')
}

/** Code → imports + top-level definitions explorer. */
export function projectCode(text: string, toolName?: string): string | null {
  if (text.split('\n').length < 8) return null
  return exploreCode(text, toolName)
}

/** Unified diffs → header + changed-line compaction. */
export function projectDiff(text: string): string | null {
  if (!DIFF_RE.test(text)) return null
  const out = compactGitDiff(text)
  return out.length < text.length ? out : null
}

/** Test/CLI output → rule engine (failure window when the result failed). */
export function projectCli(text: string, failed = false): string | null {
  const rule = matchRuleByContent(text)
  if (rule === null) return null
  return reduceWithRule(text, rule, failed)
}

/** Search output → locator-preserving line clip. */
export function projectSearch(text: string): string | null {
  if (text.split('\n').length < 5) return null
  const out = compactSearchLines(text)
  return out.length < text.length ? out : null
}

/** Logs → adjacent duplicate-line collapse with numeric normalization. */
export function projectLog(text: string): string | null {
  const lines = text.split('\n')
  if (lines.length < 20) return null
  const out: string[] = []
  let prev: string | null = null
  let run = 0
  const flush = () => {
    if (prev === null) return
    out.push(run > 1 ? `${prev}  (×${run})` : prev)
  }
  for (const line of lines) {
    const norm = line.replace(/\d+/g, '#')
    if (norm === prev) {
      run++
    } else {
      flush()
      prev = norm
      run = 1
    }
  }
  flush()
  return `// log collapsed (adjacent duplicates merged; full log via context_retrieve)\n${out.join('\n')}`
}

/**
 * Compress one text block through the reducer selected by content detection.
 * @returns `text: null` when no reducer applies or the candidate is not a
 *   strict, non-identical reduction of the input.
 */
export function compressStructured(text: string, toolName?: string, failed = false): StructuredResult {
  const contentType = detectContentType(text, toolName)
  let candidate: string | null
  switch (contentType) {
    case 'json': candidate = projectJson(text); break
    case 'diff': candidate = projectDiff(text); break
    case 'code': candidate = projectCode(text, toolName); break
    case 'log': candidate = projectLog(text); break
    case 'search': candidate = projectSearch(text); break
    case 'test': candidate = projectCli(text, failed); break
    case 'cli-output': candidate = projectCli(text, failed); break
    case 'text': candidate = null; break
  }
  if (candidate === null || candidate === text) return { text: null, contentType }
  if (candidate.length >= text.length) return { text: null, contentType }
  return { text: candidate, contentType }
}
