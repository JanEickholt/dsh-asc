import { describe, expect, it } from 'vitest'
import {
  evaluateQuality,
  rouge1F1,
  topKeywordRecall,
  topNumericRecall,
  wordTokens,
} from '../src/engine/quality-gate.ts'

const GATE: Required<import('../src/types.ts').QualityGateConfig> = {
  enabled: true,
  blocking: true,
  layer1MinChars: 200,
  layer1MinRetentionPct: 1.0,
  layer2MaxRougeF1: 0.05,
  layer2MaxTop20Recall: 0.20,
  layer2MaxNumericRecall: 0.20,
  distillationMinChars: 40,
  distillationMinRetentionPct: 0.5,
  noiseUniqueRatio: 0.02,
}

const LONG_ORIGINAL = Array.from({ length: 80 }, (_, i) => `word${i} token${i} concept${i % 7}`).join(' ')

/** An original whose load-bearing detail is exact numbers (issue #1: folding drops them). */
const NUMERIC_ORIGINAL = Array.from({ length: 60 }, (_, i) => `build failed at line ${100 + i} error ${i % 30}`).join(' ')

describe('wordTokens', () => {
  it('splits on non-alphanumeric boundaries and lowercases', () => {
    expect(wordTokens('Hello, World!')).toEqual(['hello', 'world'])
  })

  it('tokenizes CJK as unigrams', () => {
    expect(wordTokens('上下文')).toEqual(['上', '下', '文'])
  })

  it('keeps Latin words intact inside mixed CJK runs', () => {
    expect(wordTokens('修复fix文件')).toEqual(['修', '复', 'fix', '文', '件'])
  })

  it('keeps mixed text intact', () => {
    expect(wordTokens('fix: src/index.ts')).toEqual(['fix', 'src', 'index', 'ts'])
  })
})

describe('rouge1F1 and topKeywordRecall', () => {
  it('is 1 for identical token bags', () => {
    const tokens = wordTokens('the quick brown fox')
    expect(rouge1F1(tokens, tokens)).toBe(1)
    expect(topKeywordRecall(tokens, tokens)).toBe(1)
  })

  it('is 0 for disjoint bags', () => {
    expect(rouge1F1(wordTokens('aaa bbb'), wordTokens('ccc ddd'))).toBe(0)
  })

  it('scores partial overlap proportionally', () => {
    const original = wordTokens('aaa bbb ccc ddd')
    const summary = wordTokens('aaa bbb')
    expect(rouge1F1(original, summary)).toBeGreaterThan(0)
    expect(rouge1F1(original, summary)).toBeLessThan(1)
  })
})

describe('topNumericRecall', () => {
  it('is 1 when the original carries no numeric literals', () => {
    expect(topNumericRecall(wordTokens('no numbers here'), wordTokens('nothing'))).toBe(1)
  })

  it('matches pure digit tokens, not digit-bearing words', () => {
    // 'word0' is one word token, not the number 0; only '22' counts.
    const original = wordTokens('word0 Node 22 port 3080')
    const summary = wordTokens('Node 22 only')
    expect(topNumericRecall(original, summary)).toBe(0.5)
  })

  it('scores partial recall proportionally and 1 for full retention', () => {
    const original = wordTokens('error 22 at 3080 retry 3')
    expect(topNumericRecall(original, wordTokens('error 22 at 3080'))).toBe(2 / 3)
    expect(topNumericRecall(original, wordTokens('3 3080 22 error retry at'))).toBe(1)
  })

  it('measures only the top-20 most frequent numeric literals', () => {
    // 25 frequent numbers (twice each) and 5 rare ones (once): the rare
    // numbers must not drag recall below 1 when the frequent ones survive.
    const original = wordTokens(
      Array.from({ length: 25 }, (_, i) => `hot ${i} hot ${i}`).join(' ')
        + ' cold 100 cold 101 cold 102 cold 103 cold 104',
    )
    const summary = wordTokens(Array.from({ length: 25 }, (_, i) => `n ${i}`).join(' '))
    expect(topNumericRecall(original, summary)).toBe(1)
  })
})

describe('evaluateQuality', () => {
  it('passes a faithful long summary', () => {
    const report = evaluateQuality({
      originalText: LONG_ORIGINAL,
      shadowedTokens: 500,
      summaryText: 'word0 word1 word2 concept0 concept1 token0 token1 token2 ' + 'x'.repeat(200),
      summaryTokens: 60,
    }, GATE)
    expect(report.passed).toBe(true)
    expect(report.layer).toBe('pass')
  })

  it('fails L1 when the summary is too short', () => {
    const report = evaluateQuality({
      originalText: LONG_ORIGINAL,
      shadowedTokens: 500,
      summaryText: 'tiny summary',
      summaryTokens: 5,
    }, GATE)
    expect(report.passed).toBe(false)
    expect(report.layer).toBe(1)
    expect(report.note).toContain('chars below')
    // The metrics let the model see exactly what failed and against what.
    expect(report.metrics).toBeDefined()
    expect(report.metrics!.summaryChars).toBeLessThan(GATE.layer1MinChars)
    expect(report.metrics!.layer1MinChars).toBe(GATE.layer1MinChars)
    expect(report.metrics!.layer2MaxRougeF1).toBe(GATE.layer2MaxRougeF1)
  })

  it('fails L1 when retention is below the floor', () => {
    const report = evaluateQuality({
      originalText: LONG_ORIGINAL,
      shadowedTokens: 10_000,
      summaryText: 'a'.repeat(300),
      summaryTokens: 5,
    }, GATE)
    expect(report.passed).toBe(false)
    expect(report.layer).toBe(1)
    expect(report.note).toContain('retains')
    expect(report.metrics!.retentionPct).toBeLessThan(GATE.layer1MinRetentionPct)
  })

  it('reports measured L2 signals on an L1 rejection instead of zeros', () => {
    const report = evaluateQuality({
      originalText: LONG_ORIGINAL,
      shadowedTokens: 10_000,
      summaryText: `word0 token0 concept0 ${'x'.repeat(250)}`,
      summaryTokens: 5,
    }, GATE)
    expect(report.passed).toBe(false)
    expect(report.layer).toBe(1)
    // The summary does overlap the original; the metrics must say so even
    // though L1 short-circuited the gate. The numeric signal is reported
    // too (vacuously 1: this original has no numeric literals).
    expect(report.metrics!.rouge1F1).toBeGreaterThan(0)
    expect(report.metrics!.top20Recall).toBeGreaterThan(0)
    expect(report.metrics!.numericRecall).toBe(1)
  })

  it('fails L2 when all three coverage signals are below their floors', () => {
    const report = evaluateQuality({
      originalText: NUMERIC_ORIGINAL,
      shadowedTokens: 500,
      summaryText: 'completely unrelated prose about the weather today ' + 'b'.repeat(250),
      summaryTokens: 40,
    }, GATE)
    expect(report.passed).toBe(false)
    expect(report.layer).toBe(2)
    expect(report.metrics!.rouge1F1).toBeLessThan(GATE.layer2MaxRougeF1)
    expect(report.metrics!.top20Recall).toBeLessThan(GATE.layer2MaxTop20Recall)
    expect(report.metrics!.numericRecall).toBeLessThan(GATE.layer2MaxNumericRecall)
    expect(report.metrics!.layer2MaxNumericRecall).toBe(GATE.layer2MaxNumericRecall)
  })

  it('passes L2 while dropping every number as long as words overlap (AND-combined)', () => {
    // The gate catches catastrophic loss, not deliberate detail selection:
    // a summary that keeps the vocabulary but drops all exact numbers must
    // not be rejected on the numeric signal alone.
    const summary = `${'build failed at line error '.repeat(10)}${'c'.repeat(100)}`
    // A passing report carries no metrics; the signal is verified directly.
    expect(topNumericRecall(wordTokens(NUMERIC_ORIGINAL), wordTokens(summary))).toBe(0)
    const report = evaluateQuality({
      originalText: NUMERIC_ORIGINAL,
      shadowedTokens: 500,
      summaryText: summary,
      summaryTokens: 40,
    }, GATE)
    expect(report.passed).toBe(true)
  })

  it('passes L2 when only one signal is below its floor', () => {
    // Keyword recall high (contains top keywords) but rouge low.
    const summary = `word0 word1 word2 word3 word4 word5 word6 ${'c'.repeat(250)}`
    const report = evaluateQuality({
      originalText: LONG_ORIGINAL,
      shadowedTokens: 500,
      summaryText: summary,
      summaryTokens: 40,
    }, GATE)
    expect(report.passed).toBe(true)
  })

  it('waives retention and ROUGE for repetitive noise, keeping the length floor', () => {
    // A stuck command re-printing one error line: thousands of tokens, almost
    // no unique content. The length floor still applies; retention and ROUGE
    // are waived because there is nothing to preserve.
    const noise = 'ReadError: cannot resolve the name. '.repeat(2000)
    const noiseTokens = wordTokens(noise)
    expect(new Set(noiseTokens).size / noiseTokens.length).toBeLessThan(GATE.noiseUniqueRatio)

    const adequate = evaluateQuality({
      originalText: noise,
      shadowedTokens: 10_000,
      summaryText: `Get-ChildItem failed with repeated ReadError on node_modules symlink loops; command timed out at 120s. Fix: exclude node_modules or use glob. ${'x'.repeat(60)}`,
      summaryTokens: 40,
    }, GATE)
    expect(adequate.passed).toBe(true)

    // The length floor is NOT waived: a one-line summary of noise still fails.
    const tooShort = evaluateQuality({
      originalText: noise,
      shadowedTokens: 10_000,
      summaryText: 'repeated ReadError',
      summaryTokens: 5,
    }, GATE)
    expect(tooShort.passed).toBe(false)
    expect(tooShort.layer).toBe(1)
    expect(tooShort.note).toContain('chars below')
  })

  it('reports blocking from config', () => {
    const report = evaluateQuality({
      originalText: LONG_ORIGINAL,
      shadowedTokens: 500,
      summaryText: 'tiny',
      summaryTokens: 5,
    }, { ...GATE, blocking: false })
    expect(report.passed).toBe(false)
    expect(report.blocking).toBe(false)
  })

  it('never throws on empty inputs', () => {
    const report = evaluateQuality({
      originalText: '',
      shadowedTokens: 100,
      summaryText: '',
      summaryTokens: 0,
    }, GATE)
    expect(typeof report.passed).toBe('boolean')
  })
})
