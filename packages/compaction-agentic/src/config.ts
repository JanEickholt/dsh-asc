/**
 * Load-time validation for the agentic compaction backend.
 *
 * @module dsh-asc/config
 */

import { deepFreeze } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {
  AgenticCompactionConfig,
  ModelAgenticPolicyConfig,
  ResolvedConfig,
} from './types.ts'

/** Default request-pressure fraction for every routed model. */
const DEFAULT_THRESHOLD_RATIO = 0.8

/** Default verbatim-tail fraction for every routed model. */
const DEFAULT_RETAIN_RATIO = 0.16

/** Config errors are classified so the auto listener can suppress repeat warnings per target. */
export class TargetPolicyConfigError extends Error {
  /**
   * @param targetKey - exact provider/model route used as the warning key.
   * @param message - actionable configuration failure detail.
   */
  constructor(readonly targetKey: string, message: string) {
    super(message)
  }
}

const POLICY_KEYS: ReadonlySet<string> = new Set([
  'thresholdRatio',
  'retainRatio',
  'retainTokens',
])

const MODEL_POLICY_KEYS: ReadonlySet<string> = new Set([
  'provider',
  'model',
  ...POLICY_KEYS,
])

const AGENTIC_CONFIG_KEYS: ReadonlySet<string> = new Set([
  ...POLICY_KEYS,
  'modelPolicies',
  'auto',
  'compress',
  'nudge',
  'tiers',
  'qualityGate',
  'fallback',
  'protection',
  'decompress',
])

const COMPRESS_KEYS: ReadonlySet<string> = new Set(['autoExpandToolPairs'])

const NUDGE_KEYS: ReadonlySet<string> = new Set([
  'enabled',
  'minRatio',
  'maxRatio',
  'growthTokens',
  'frequency',
  'iterationThreshold',
  'force',
])

const TIER_KEYS: ReadonlySet<string> = new Set(['enabled', 'maxTier', 'growthTokens'])

const QUALITY_GATE_KEYS: ReadonlySet<string> = new Set([
  'enabled',
  'blocking',
  'layer1MinChars',
  'layer1MinRetentionPct',
  'layer2MaxRougeF1',
  'layer2MaxTop20Recall',
  'noiseUniqueRatio',
])

const FALLBACK_KEYS: ReadonlySet<string> = new Set([
  'enabled',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'maxOverflowRetries',
])

const PROTECTION_KEYS: ReadonlySet<string> = new Set([
  'protectUserMessages',
  'protectFirstUserMessage',
  'retainRecentMessages',
  'protectedTools',
  'protectedSources',
])

const DECOMPRESS_KEYS: ReadonlySet<string> = new Set(['maxTokens', 'maxBlocks'])

/**
 * Resolve and validate the full agentic compaction configuration.
 * @param config - untrusted plugin configuration after Loader normalization.
 * @returns detached immutable resolved configuration.
 */
export function resolveConfig(config: AgenticCompactionConfig = {}): ResolvedConfig {
  validateKeys(config, AGENTIC_CONFIG_KEYS, 'AgenticCompactionConfig')
  const retention = resolveRetention(config)
  const thresholdRatio = config.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO
  if (config.thresholdRatio !== undefined) {
    assertRatio('AgenticCompactionConfig.thresholdRatio', config.thresholdRatio)
  }
  validateRatioRetention(thresholdRatio, retention, 'AgenticCompactionConfig')

  const nudge = resolveGroup(config.nudge, NUDGE_KEYS, 'AgenticCompactionConfig.nudge', {
    enabled: true,
    minRatio: 0.45,
    maxRatio: 0.8,
    growthTokens: 50000,
    frequency: 5,
    iterationThreshold: 15,
    force: 'soft',
  } as const, (group, name) => {
    if (group.minRatio !== undefined) assertRatio(`${name}.minRatio`, group.minRatio)
    if (group.maxRatio !== undefined) assertRatio(`${name}.maxRatio`, group.maxRatio)
    if (group.minRatio !== undefined && group.maxRatio !== undefined
      && group.minRatio > group.maxRatio) {
      throw new Error(`${name}: minRatio (${group.minRatio}) must not exceed maxRatio (${group.maxRatio})`)
    }
    if (group.growthTokens !== undefined) {
      assertPositiveInteger(`${name}.growthTokens`, group.growthTokens)
    }
    if (group.frequency !== undefined) {
      assertPositiveInteger(`${name}.frequency`, group.frequency)
    }
    if (group.iterationThreshold !== undefined) {
      assertNonNegativeInteger(`${name}.iterationThreshold`, group.iterationThreshold)
    }
    if (group.force !== undefined && group.force !== 'soft' && group.force !== 'strong') {
      throw new Error(`${name}.force must be "soft" or "strong"`)
    }
  })

  const tiers = resolveGroup(config.tiers, TIER_KEYS, 'AgenticCompactionConfig.tiers', {
    enabled: true,
    maxTier: 3,
    growthTokens: 10000,
  } as const, (group, name) => {
    if (group.maxTier !== undefined
      && (typeof group.maxTier !== 'number' || !Number.isInteger(group.maxTier)
        || group.maxTier < 1 || group.maxTier > 5)) {
      throw new Error(`${name}.maxTier (${String(group.maxTier)}) must be an integer between 1 and 5`)
    }
    if (group.growthTokens !== undefined) {
      assertPositiveInteger(`${name}.growthTokens`, group.growthTokens)
    }
  })

  const qualityGate = resolveGroup(
    config.qualityGate,
    QUALITY_GATE_KEYS,
    'AgenticCompactionConfig.qualityGate',
    {
      enabled: true,
      blocking: true,
      layer1MinChars: 200,
      layer1MinRetentionPct: 1.0,
      layer2MaxRougeF1: 0.05,
      layer2MaxTop20Recall: 0.20,
      noiseUniqueRatio: 0.02,
    } as const,
    (group, name) => {
      if (group.layer1MinChars !== undefined) {
        assertNonNegativeInteger(`${name}.layer1MinChars`, group.layer1MinChars)
      }
      if (group.layer1MinRetentionPct !== undefined) {
        assertRatio(`${name}.layer1MinRetentionPct`, group.layer1MinRetentionPct)
      }
      if (group.layer2MaxRougeF1 !== undefined) {
        assertRatio(`${name}.layer2MaxRougeF1`, group.layer2MaxRougeF1)
      }
      if (group.layer2MaxTop20Recall !== undefined) {
        assertRatio(`${name}.layer2MaxTop20Recall`, group.layer2MaxTop20Recall)
      }
      if (group.noiseUniqueRatio !== undefined) {
        assertRatio(`${name}.noiseUniqueRatio`, group.noiseUniqueRatio)
      }
    },
  )

  const fallback = resolveGroup(config.fallback, FALLBACK_KEYS, 'AgenticCompactionConfig.fallback', {
    enabled: true,
    summarizationProvider: '',
    summarizationModel: '',
    maxTokens: 8192,
    maxOverflowRetries: 1,
  } as const, (group, name) => {
    if (group.maxTokens !== undefined) {
      assertPositiveInteger(`${name}.maxTokens`, group.maxTokens)
    }
    if (group.maxOverflowRetries !== undefined) {
      assertNonNegativeInteger(`${name}.maxOverflowRetries`, group.maxOverflowRetries)
    }
    validateSummarizationPair(group, name)
  })

  const protection = resolveGroup(
    config.protection,
    PROTECTION_KEYS,
    'AgenticCompactionConfig.protection',
    {
      protectUserMessages: false,
      protectFirstUserMessage: true,
      retainRecentMessages: 20,
      protectedTools: [] as string[],
      protectedSources: [] as string[],
    },
    (group, name) => {
      if (group.retainRecentMessages !== undefined) {
        assertNonNegativeInteger(`${name}.retainRecentMessages`, group.retainRecentMessages)
      }
      if (group.protectedTools !== undefined) {
        assertStringArray(`${name}.protectedTools`, group.protectedTools)
      }
      if (group.protectedSources !== undefined) {
        assertStringArray(`${name}.protectedSources`, group.protectedSources)
      }
    },
  )

  const decompress = resolveGroup(config.decompress, DECOMPRESS_KEYS, 'AgenticCompactionConfig.decompress', {
    maxTokens: 60000,
    maxBlocks: 8,
  } as const, (group, name) => {
    if (group.maxTokens !== undefined) {
      assertPositiveInteger(`${name}.maxTokens`, group.maxTokens)
    }
    if (group.maxBlocks !== undefined) {
      assertPositiveInteger(`${name}.maxBlocks`, group.maxBlocks)
    }
  })

  const compress = resolveGroup(config.compress, COMPRESS_KEYS, 'AgenticCompactionConfig.compress', {
    autoExpandToolPairs: true,
  } as const, (group, name) => {
    if (group.autoExpandToolPairs !== undefined && typeof group.autoExpandToolPairs !== 'boolean') {
      throw new Error(`${name}.autoExpandToolPairs must be a boolean`)
    }
  })

  const modelPolicies = resolveModelPolicies(config.modelPolicies)
  for (const [index, policy] of modelPolicies.entries()) {
    const policyRetainRatio = policy.retainRatio ?? retention.retainRatio
    validateRatioRetention(
      policy.thresholdRatio ?? thresholdRatio,
      {
        ...policyRetainRatio === undefined ? {} : { retainRatio: policyRetainRatio },
        ...policy.retainTokens === undefined ? {} : { retainTokens: policy.retainTokens },
      },
      `AgenticCompactionConfig: modelPolicies[${index}]`,
    )
  }

  return deepFreeze({
    thresholdRatio,
    retainRatio: retention.retainRatio ?? 0,
    ...retention.retainTokens === undefined ? {} : { retainTokens: retention.retainTokens },
    auto: config.auto ?? true,
    modelPolicies,
    compress,
    nudge,
    tiers,
    qualityGate,
    fallback,
    protection,
    decompress,
  })
}

/**
 * Merge the exact provider/model override over the validated default policy.
 * @param config - validated service defaults and override table.
 * @param target - exact durable provider/model route to match.
 * @returns the merged policy fields for that target.
 */
export function resolveTargetPolicy(
  config: ResolvedConfig,
  target: Pick<LlmCallConfig, 'provider' | 'model'>,
): { thresholdRatio: number; retainRatio: number; retainTokens?: number } {
  const override = config.modelPolicies.find(policy => (
    policy.provider === target.provider && policy.model === target.model
  ))
  const retainTokens = override?.retainTokens ?? config.retainTokens
  return deepFreeze({
    thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
    retainRatio: retainTokens === undefined ? config.retainRatio : 0,
    ...retainTokens === undefined ? {} : { retainTokens },
  })
}

/**
 * Scale a routed policy into concrete token budgets for its model capacity.
 * @param policy - merged policy for the exact routed target.
 * @param contextWindow - positive adapter-owned capacity for that target.
 * @returns detached immutable pressure and retention budgets.
 */
export function resolveCompactSpec(
  policy: { thresholdRatio: number; retainRatio: number; retainTokens?: number },
  contextWindow: number,
): { thresholdTokens: number; retainTokens: number } {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new Error(`contextWindow (${contextWindow}) must be a positive integer`)
  }
  const thresholdTokens = Math.floor(contextWindow * policy.thresholdRatio)
  const retainTokens = policy.retainTokens ?? Math.floor(contextWindow * policy.retainRatio)
  if (retainTokens >= thresholdTokens) {
    throw new Error(`retainTokens (${retainTokens}) must be less than threshold tokens ${thresholdTokens}`)
  }
  return deepFreeze({ thresholdTokens, retainTokens })
}

/** Choose an explicit retention form or the ratio default. */
function resolveRetention(config: AgenticCompactionConfig): { retainRatio?: number; retainTokens?: number } {
  if (config.retainRatio !== undefined && config.retainTokens !== undefined) {
    throw new Error('AgenticCompactionConfig: retainRatio and retainTokens are mutually exclusive')
  }
  if (config.retainTokens !== undefined) {
    assertNonNegativeInteger('AgenticCompactionConfig.retainTokens', config.retainTokens)
    return { retainTokens: config.retainTokens }
  }
  if (config.retainRatio !== undefined) {
    assertRatio('AgenticCompactionConfig.retainRatio', config.retainRatio)
    return { retainRatio: config.retainRatio }
  }
  return { retainRatio: DEFAULT_RETAIN_RATIO }
}

/** Reject a capacity-independent retention conflict at plugin load. */
function validateRatioRetention(
  thresholdRatio: number,
  retention: { retainRatio?: number; retainTokens?: number },
  name: string,
): void {
  if (retention.retainRatio !== undefined && retention.retainRatio >= thresholdRatio) {
    throw new Error(
      `${name}: retainRatio (${retention.retainRatio}) must be less than `
      + `the resolved thresholdRatio (${thresholdRatio})`,
    )
  }
  if (retention.retainTokens !== undefined && retention.retainTokens <= 0) {
    throw new Error(`${name}: retainTokens must be a positive integer`)
  }
}

/** Validate one nested config group with strict key checks and defaults. */
function resolveGroup<T extends Record<string, unknown>>(
  source: unknown,
  keys: ReadonlySet<string>,
  name: string,
  defaults: T,
  validate: (group: T, name: string) => void,
): T {
  if (source === undefined) return { ...defaults } as T
  if (!isUnknownRecord(source)) throw new Error(`${name} must be an object`)
  validateKeys(source, keys, name)
  const merged = { ...defaults, ...source }
  validate(merged, name)
  return merged as T
}

/** Validate, detach, and reject duplicate exact-target policies. */
function resolveModelPolicies(configured: unknown): ModelAgenticPolicyConfig[] {
  if (configured === undefined) return []
  if (!Array.isArray(configured)) {
    throw new Error('AgenticCompactionConfig: modelPolicies must be an array')
  }
  const seen = new Set<string>()
  return configured.map((source: unknown, index) => {
    const name = `AgenticCompactionConfig: modelPolicies[${index}]`
    assertModelPolicy(source, name)
    const key = `${source.provider}\u0000${source.model}`
    if (seen.has(key)) {
      throw new Error(
        `AgenticCompactionConfig: duplicate model policy for ${source.provider}/${source.model}`,
      )
    }
    seen.add(key)
    return { ...source }
  })
}

/** Validate one untrusted exact-target override and narrow its type. */
function assertModelPolicy(
  source: unknown,
  name: string,
): asserts source is ModelAgenticPolicyConfig {
  if (!isUnknownRecord(source)) throw new Error(`${name} must be an object`)
  validateKeys(source, MODEL_POLICY_KEYS, name)
  assertNonEmptyString(`${name}.provider`, source.provider)
  assertNonEmptyString(`${name}.model`, source.model)
  if (source.thresholdRatio !== undefined) assertRatio(`${name}.thresholdRatio`, source.thresholdRatio)
  if (source.retainRatio !== undefined) assertRatio(`${name}.retainRatio`, source.retainRatio)
  if (source.retainTokens !== undefined) {
    assertNonNegativeInteger(`${name}.retainTokens`, source.retainTokens)
  }
  if (source.retainRatio !== undefined && source.retainTokens !== undefined) {
    throw new Error(`${name}: retainRatio and retainTokens are mutually exclusive`)
  }
}

/** Require one scope to omit, clear, or replace the summarization target as a pair. */
function validateSummarizationPair(
  group: Record<string, unknown>,
  name: string,
): void {
  const provider = group.summarizationProvider
  const model = group.summarizationModel
  if (provider !== undefined && typeof provider !== 'string') {
    throw new Error(`${name}.summarizationProvider must be a string`)
  }
  if (model !== undefined && typeof model !== 'string') {
    throw new Error(`${name}.summarizationModel must be a string`)
  }
  if (provider === undefined && model === undefined) return
  if (provider === undefined || model === undefined
    || (provider.length === 0) !== (model.length === 0)) {
    throw new Error(
      `${name}: summarizationProvider and summarizationModel must be set together `
      + 'as an empty or non-empty pair',
    )
  }
}

/** Reject stale or misspelled keys before defaults can hide them. */
function validateKeys(config: object, keys: ReadonlySet<string>, name: string): void {
  for (const key of Object.keys(config)) {
    if (!keys.has(key)) throw new Error(`${name}: unknown key "${key}"`)
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
}

function assertStringArray(name: string, value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${name} must be an array of strings`)
  }
}

function assertPositiveInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} (${String(value)}) must be a positive integer`)
  }
}

function assertNonNegativeInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} (${String(value)}) must be a non-negative integer`)
  }
}

function assertRatio(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} (${String(value)}) must be a number in (0, 1]`)
  }
}
