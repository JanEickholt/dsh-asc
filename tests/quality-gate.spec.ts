import { describe, expect, it } from 'vitest'
import { evaluateQuality, rouge1F1, topKeywordRecall, wordTokens } from '../src/engine/quality-gate.ts'

const GATE: Required<import('../src/types.ts').QualityGateConfig> = {
  enabled: true,
  blocking: true,
  layer1MinChars: 200,
  layer1MinRetentionPct: 1.0,
  layer2MaxRougeF1: 0.05,
  layer2MaxTop20Recall: 0.20,
  noiseUniqueRatio: 0.02,
}

const LONG_ORIGINAL = Array.from({ length: 80 }, (_, i) => `word${i} token${i} concept${i % 7}`).join(' ')

describe('wordTokens', () => {
  it('splits on non-alphanumeric boundaries and lowercases', () => {
    expect(wordTokens('Hello, World!')).toEqual(['hello', 'world'])
  })

  it('tokenizes CJK as unigrams', () => {
    expect(wordTokens('上下文')).toEqual(['上', '下', '文'])
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

  it('fails L2 when both rouge and keyword recall are below floors', () => {
    const report = evaluateQuality({
      originalText: LONG_ORIGINAL,
      shadowedTokens: 500,
      summaryText: 'completely unrelated prose about the weather today ' + 'b'.repeat(250),
      summaryTokens: 40,
    }, GATE)
    expect(report.passed).toBe(false)
    expect(report.layer).toBe(2)
    expect(report.metrics!.rouge1F1).toBeLessThan(GATE.layer2MaxRougeF1)
    expect(report.metrics!.top20Recall).toBeLessThan(GATE.layer2MaxTop20Recall)
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
