import { describe, expect, it } from 'vitest'
import { resolveConfig, resolveCompactSpec, resolveTargetPolicy, TargetPolicyConfigError } from '../src/config.ts'

describe('resolveConfig', () => {
  it('applies documented defaults', () => {
    const config = resolveConfig({})
    expect(config.thresholdRatio).toBe(0.8)
    expect(config.retainRatio).toBe(0.16)
    expect(config.retainTokens).toBeUndefined()
    expect(config.auto).toBe(true)
    expect(config.nudge.enabled).toBe(true)
    expect(config.nudge.minRatio).toBe(0.45)
    expect(config.nudge.maxRatio).toBe(0.8)
    expect(config.nudge.growthTokens).toBe(50000)
    expect(config.nudge.frequency).toBe(5)
    expect(config.nudge.iterationThreshold).toBe(15)
    expect(config.nudge.force).toBe('soft')
    expect(config.tiers.maxTier).toBe(3)
    expect(config.tiers.growthTokens).toBe(10000)
    expect(config.qualityGate.enabled).toBe(true)
    expect(config.qualityGate.blocking).toBe(true)
    expect(config.qualityGate.layer1MinChars).toBe(200)
    expect(config.qualityGate.distillationMinChars).toBe(40)
    expect(config.qualityGate.distillationMinRetentionPct).toBe(0.5)
    expect(config.fallback.enabled).toBe(true)
    expect(config.fallback.maxTokens).toBe(8192)
    expect(config.protection.protectFirstUserMessage).toBe(true)
    expect(config.protection.retainRecentMessages).toBe(20)
    expect(config.protection.protectedTools).toEqual([])
    expect(config.decompress.maxTokens).toBe(60000)
    expect(config.decompress.maxBlocks).toBe(8)
  })

  it('rejects unknown top-level keys', () => {
    expect(() => resolveConfig({ unknown: 1 } as never)).toThrow('unknown key "unknown"')
  })

  it('rejects unknown nested keys', () => {
    expect(() => resolveConfig({ nudge: { bogus: true } } as never)).toThrow('unknown key "bogus"')
    expect(() => resolveConfig({ tiers: { bogus: true } } as never)).toThrow('unknown key "bogus"')
    expect(() => resolveConfig({ qualityGate: { bogus: true } } as never)).toThrow('unknown key "bogus"')
    expect(() => resolveConfig({ fallback: { bogus: true } } as never)).toThrow('unknown key "bogus"')
    expect(() => resolveConfig({ protection: { bogus: true } } as never)).toThrow('unknown key "bogus"')
    expect(() => resolveConfig({ decompress: { bogus: true } } as never)).toThrow('unknown key "bogus"')
  })

  it('rejects invalid ratios and counts', () => {
    expect(() => resolveConfig({ thresholdRatio: 1.5 })).toThrow('must be a number in (0, 1]')
    expect(() => resolveConfig({ thresholdRatio: 0 })).toThrow('must be a number in (0, 1]')
    expect(() => resolveConfig({ retainRatio: -0.1 })).toThrow('must be a number in (0, 1]')
    expect(() => resolveConfig({ nudge: { frequency: 0 } })).toThrow('positive integer')
    expect(() => resolveConfig({ nudge: { growthTokens: 0 } })).toThrow('positive integer')
    expect(() => resolveConfig({ nudge: { force: 'loud' } as never })).toThrow('"soft" or "strong"')
    expect(() => resolveConfig({ decompress: { maxTokens: -1 } })).toThrow('positive integer')
  })

  it('rejects retainRatio at or above thresholdRatio', () => {
    expect(() => resolveConfig({ thresholdRatio: 0.5, retainRatio: 0.5 })).toThrow('must be less than')
    expect(() => resolveConfig({ thresholdRatio: 0.5, retainRatio: 0.6 })).toThrow('must be less than')
  })

  it('rejects mutually exclusive retention forms', () => {
    expect(() => resolveConfig({ retainRatio: 0.1, retainTokens: 100 })).toThrow('mutually exclusive')
  })

  it('rejects minRatio above maxRatio', () => {
    expect(() => resolveConfig({ nudge: { minRatio: 0.9, maxRatio: 0.5 } })).toThrow('must not exceed')
  })

  it('rejects a maxTier outside 1..5', () => {
    expect(() => resolveConfig({ tiers: { maxTier: 0 } })).toThrow('between 1 and 5')
    expect(() => resolveConfig({ tiers: { maxTier: 6 } })).toThrow('between 1 and 5')
  })

  it('requires summarization fields as a pair', () => {
    expect(() => resolveConfig({ fallback: { summarizationProvider: 'p' } })).toThrow('must be set together')
    expect(() => resolveConfig({ fallback: { summarizationModel: 'm' } })).toThrow('must be set together')
    expect(() => resolveConfig({ fallback: { summarizationProvider: '  ', summarizationModel: '  ' } }))
      .toThrow('non-blank')
  })

  it('accepts an empty summarization pair as inheritance', () => {
    const config = resolveConfig({ fallback: { summarizationProvider: '', summarizationModel: '' } })
    expect(config.fallback.summarizationProvider).toBe('')
  })

  it('rejects duplicate model policies and accepts overrides', () => {
    expect(() => resolveConfig({
      modelPolicies: [
        { provider: 'p', model: 'm' },
        { provider: 'p', model: 'm' },
      ],
    })).toThrow('duplicate model policy')
    const config = resolveConfig({
      modelPolicies: [{ provider: 'p', model: 'm', thresholdRatio: 0.5 }],
    })
    expect(config.modelPolicies).toHaveLength(1)
  })

  it('rejects a model policy with missing provider/model', () => {
    expect(() => resolveConfig({ modelPolicies: [{ provider: 'p' }] as never })).toThrow('must be a non-empty string')
  })

  it('rejects non-object group values', () => {
    expect(() => resolveConfig({ nudge: 42 } as never)).toThrow('must be an object')
  })
})

describe('resolveTargetPolicy and resolveCompactSpec', () => {
  it('merges the exact-target override', () => {
    const config = resolveConfig({
      thresholdRatio: 0.8,
      modelPolicies: [{ provider: 'p', model: 'm', thresholdRatio: 0.5, retainTokens: 1000 }],
    })
    const policy = resolveTargetPolicy(config, { provider: 'p', model: 'm' })
    expect(policy.thresholdRatio).toBe(0.5)
    expect(policy.retainTokens).toBe(1000)
    const other = resolveTargetPolicy(config, { provider: 'p', model: 'other' })
    expect(other.thresholdRatio).toBe(0.8)
  })

  it('lets an override retainRatio replace a global retainTokens', () => {
    const config = resolveConfig({
      retainTokens: 2000,
      modelPolicies: [{ provider: 'p', model: 'm', retainRatio: 0.25 }],
    })
    const policy = resolveTargetPolicy(config, { provider: 'p', model: 'm' })
    expect(policy.retainRatio).toBe(0.25)
    expect(policy.retainTokens).toBeUndefined()
    // Unmatched targets still get the global absolute budget.
    const other = resolveTargetPolicy(config, { provider: 'p', model: 'other' })
    expect(other.retainTokens).toBe(2000)
    expect(other.retainRatio).toBe(0)
  })

  it('scales budgets from the context window', () => {
    const spec = resolveCompactSpec({ thresholdRatio: 0.8, retainRatio: 0.16 }, 100_000)
    expect(spec.thresholdTokens).toBe(80_000)
    expect(spec.retainTokens).toBe(16_000)
  })

  it('prefers an absolute retention budget', () => {
    const spec = resolveCompactSpec({ thresholdRatio: 0.8, retainRatio: 0.16, retainTokens: 500 }, 100_000)
    expect(spec.retainTokens).toBe(500)
  })

  it('rejects an invalid context window', () => {
    expect(() => resolveCompactSpec({ thresholdRatio: 0.8, retainRatio: 0.16 }, 0))
      .toThrow('must be a positive integer')
  })

  it('rejects retention at or above the threshold', () => {
    expect(() => resolveCompactSpec({ thresholdRatio: 0.8, retainRatio: 0.9 }, 100_000))
      .toThrow('must be less than threshold tokens')
  })

  it('throws TargetPolicyConfigError-compatible messages for bad windows', () => {
    try {
      resolveCompactSpec({ thresholdRatio: 0.8, retainRatio: 0.16 }, -1)
      expect.unreachable()
    } catch (error) {
      expect(error).not.toBeInstanceOf(TargetPolicyConfigError)
      expect((error as Error).message).toContain('positive integer')
    }
  })
})
