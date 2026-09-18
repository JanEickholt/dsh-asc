/**
 * CLI tool-result rule engine — algorithm ported from opensquilla
 * (Apache-2.0), whose rule engine derives from tokenjuice (MIT). Pure TS, no
 * fs/host machinery: rules are a pre-baked array keyed on OUTPUT CONTENT
 * (tool results carry no argv), so the module stays self-contained.
 *
 * The reducer applies, in order: outputMatches short-circuit, stripAnsi /
 * trimEmptyEdges / dedupeAdjacent, skipPatterns (drop) then keepPatterns
 * (restrict), named counter facts, head/tail line windowing (success vs
 * failure window). Two rejection guards (line identity / not shorter) return
 * `null` so the caller falls back to its meter-priced head/tail slice.
 * Reduction is a LOSSY view; the original stays in the session log.
 *
 * @module dsh-asc/projection/vendor/cli-rules
 */

export interface CliRule {
  id: string
  transforms?: { stripAnsi?: boolean; dedupeAdjacent?: boolean; trimEmptyEdges?: boolean }
  filters?: { skipPatterns?: string[]; keepPatterns?: string[] }
  counters?: { name: string; pattern: string; flags?: string }[]
  summarize: { head: number; tail: number }
  failure?: { head: number; tail: number }
}

/** Content-driven rule: the first rule whose whole-output regex matches wins. */
export interface ContentCliRule extends CliRule {
  contentMatch?: { pattern: string; flags?: string }
}

const ANSI_RE =
  /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

function trimEmptyEdges(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start]?.trim() === '') start++
  while (end > start && lines[end - 1]?.trim() === '') end--
  return lines.slice(start, end)
}

function dedupeAdjacent(lines: string[]): string[] {
  const out: string[] = []
  let last: string | null = null
  for (const line of lines) {
    if (line !== last) out.push(line)
    last = line
  }
  return out
}

function headTail(lines: string[], head: number, tail: number): string[] {
  if (lines.length <= head + tail) return lines
  const omitted = lines.length - head - tail
  return [...lines.slice(0, head), `... omitted ${omitted} lines ...`, ...lines.slice(-tail)]
}

function reFlags(flags?: string): string {
  let f = ''
  if (flags?.includes('i')) f += 'i'
  if (flags?.includes('m')) f += 'm'
  return f
}

function countPattern(lines: string[], pattern: string, flags?: string): number {
  const re = new RegExp(pattern, reFlags(flags))
  return lines.filter((l) => re.test(l)).length
}

/**
 * Content-driven rules (test runners, search output, generic noisy output).
 * `contentMatch` is a regex tested against the whole output; the first
 * matching rule wins and generic/fallback is the last resort.
 */
export const CONTENT_CLI_RULES: ContentCliRule[] = [
  {
    // Test runners (pytest/jest/vitest/go test/cargo test/…): keep failures + final summary.
    id: 'content/test-results',
    contentMatch: {
      pattern:
        '(^|\\n)(={3,}.*(passed|failed|error).*={3,}|FAIL(ED)?\\b|PASS(ED)?\\b|\\d+ (passed|failed)|test result:|Tests:\\s|=== RUN|--- FAIL|ok\\s+\\S+\\s+[\\d.]+s)',
      flags: 'i',
    },
    transforms: { stripAnsi: true, dedupeAdjacent: true, trimEmptyEdges: true },
    filters: {
      skipPatterns: [
        '^platform .+',
        '^rootdir: ',
        '^plugins: ',
        '^collecting ',
        '^collected \\d+ item',
        '^\\s*$',
      ],
      keepPatterns: [
        '={3,}.*(failed|passed|error).*={3,}',
        '^_{2,}.+_{2,}$',
        '^FAILED ',
        '^ERROR ',
        '^E\\s+',
        'AssertionError|Error:|panic:|thread \'.*\' panicked',
        '(FAILED|ERROR|FAIL)\\b',
        '^>\\s+',
        '\\d+ (passed|failed|error|skipped)',
        'test result:',
        '--- FAIL|^ok\\s',
      ],
    },
    counters: [
      { name: 'failed', pattern: '(^|\\s)(FAILED|FAIL)\\b', flags: 'i' },
      { name: 'passed', pattern: '(^|\\s)(PASSED|PASS|ok)\\b', flags: 'i' },
    ],
    summarize: { head: 10, tail: 12 },
    failure: { head: 16, tail: 18 },
  },
  {
    // grep/ripgrep/git-grep: keep the matching `path:line:` locator lines.
    id: 'content/search',
    contentMatch: { pattern: '(^|\\n).+?:\\d+[:-].', flags: '' },
    transforms: { stripAnsi: true, dedupeAdjacent: true, trimEmptyEdges: true },
    filters: {
      keepPatterns: [
        '^.+?:\\d+[:-].',
        'error|warning|binary file|permission denied|no such file',
        '^\\d+ match(es)?$',
      ],
    },
    counters: [{ name: 'match', pattern: '^.+?:\\d+[:-].' }],
    summarize: { head: 14, tail: 8 },
    failure: { head: 16, tail: 16 },
  },
  {
    // Generic noisy multi-line output: dedupe + head/tail window.
    id: 'generic/fallback',
    transforms: { stripAnsi: true, dedupeAdjacent: true, trimEmptyEdges: true },
    summarize: { head: 40, tail: 20 },
    failure: { head: 60, tail: 40 },
  },
]

/** Pick a content-driven rule by output shape. generic/fallback is last resort. */
export function matchRuleByContent(text: string): ContentCliRule | null {
  for (const rule of CONTENT_CLI_RULES) {
    if (rule.id === 'generic/fallback') continue
    const cm = rule.contentMatch
    if (cm && new RegExp(cm.pattern, reFlags(cm.flags) || undefined).test(text)) return rule
  }
  return CONTENT_CLI_RULES.find((r) => r.id === 'generic/fallback') ?? null
}

/**
 * Reduce tool-result text with a rule. `failed` selects the failure window.
 * @returns `null` when the reduction is not actually shorter than the input.
 */
export function reduceWithRule(text: string, rule: CliRule, failed = false): string | null {
  // 1. Preprocess.
  let body = text
  if (rule.transforms?.stripAnsi) body = stripAnsi(body)
  let lines = body.split('\n')
  if (rule.transforms?.trimEmptyEdges) lines = trimEmptyEdges(lines)
  if (rule.transforms?.dedupeAdjacent) lines = dedupeAdjacent(lines)

  // 2. Counters (computed before keep/skip narrowing).
  const facts: string[] = []
  for (const c of rule.counters ?? []) {
    const n = countPattern(lines, c.pattern, c.flags)
    if (n > 0) facts.push(`${c.name}: ${n}`)
  }

  // 3. Skip then keep.
  if (rule.filters?.skipPatterns?.length) {
    const skip = rule.filters.skipPatterns.map((p) => new RegExp(p))
    lines = lines.filter((l) => !skip.some((re) => re.test(l)))
  }
  if (rule.filters?.keepPatterns?.length) {
    const keep = rule.filters.keepPatterns.map((p) => new RegExp(p))
    const kept = lines.filter((l) => keep.some((re) => re.test(l)))
    if (kept.length > 0) lines = kept
  }

  // 4. Window.
  const win = failed && rule.failure ? rule.failure : rule.summarize
  lines = headTail(lines, win.head, win.tail)

  const header = facts.length ? `${facts.join('; ')}\n` : ''
  const inline = `${header}${lines.join('\n')}`

  // Rejection guards: identical text, or not actually shorter.
  if (inline === text) return null
  if (inline.length >= text.length) return null
  return inline
}
