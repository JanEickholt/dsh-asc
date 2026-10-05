/**
 * Session-event and message-source vocabulary.
 *
 * The backend intentionally declares NO custom `SessionEventMap` members:
 * this harness release refuses to persist or index logs containing event
 * types outside its generated vocabulary unless they carry the envelope's
 * `ignorable` marker, and `Session.append` does not yet expose a way to set
 * that marker for out-of-tree plugins. Every durable fact therefore rides
 * on already-known event types:
 *
 * - compressions use the upstream `compaction/start|summary|end` bracket
 *   and a replacement `user/message` with `compactCheckpointSource`;
 * - the per-fold quality-gate report (with per-signal metrics) rides extra
 *   provenance fields on that replacement message's source, so the session
 *   log itself is the record a deployment derives its own floors from;
 * - the summary authorship is recoverable from `compaction/summary`'s
 *   `llmStreamCall` flag (model-written vs fallback LLM call);
 * - nudges are appended `user/message` events whose source carries this
 *   package's own producer kind {@link PLUGIN_SOURCE_KIND} with
 *   `purpose: 'nudge'`;
 * - decompression restores in place: the checkpoint node is replaced by a
 *   `user/message` whose source is {@link PLUGIN_SOURCE_KIND} with
 *   `op: 'decompress'` and the checkpoint's `compactionId`, carrying the
 *   replayed transcript;
 * - fallback compactions (overflow recovery or manual compaction)
 *   announce themselves with a `user/message` whose source purpose is
 *   `overflow-notice`;
 * - reversible tool-result projection uses the tool-result pruner's
 *   shadow+replace pair: a `compaction/prune` shadow price, then a
 *   replacement `tool/result` whose content embeds the retrieval marker
 *   naming the original's 24-hex sha-256 hash and seq. The projected
 *   original is the shadowed log event itself — no custom event type, no
 *   side store.
 *
 * Nudge cadence and tier baselines are transient in-memory state (a fresh
 * process re-establishes the baseline before nudging again), documented in
 * the design and usage documents.
 *
 * The message-source kind is producer-owned, never the retired shared
 * `kind: 'plugin'` wrapper: session format v4 refuses to persist a message
 * whose source still carries `kind: 'plugin'`, and the harness's own
 * v3→v4 migration derives exactly `plugin:<producer>` for an out-of-tree
 * producer — so this package writes the kind its own earlier logs migrate to.
 *
 * @module dsh-asc/events
 */

import type { CompactionId } from '@deepseek-ai/dsh-compaction'

/** Producer name used in this package's own configuration and diagnostics. */
export const PLUGIN_NAME = 'dsh-asc'

/**
 * Producer-owned `MessageSource.kind` stamped on every message this package
 * injects. `plugin:`-prefixed so it matches the identity session format v4's
 * v3→v4 migration derives for this producer.
 */
export const PLUGIN_SOURCE_KIND = 'plugin:dsh-asc'

/**
 * Source shape this package declares for {@link PLUGIN_SOURCE_KIND}.
 *
 * @remarks
 * `MessageSourceMap` is a merge-extensible sum: every producer declares its
 * own `kind`. No `form` is declared here, so the documented default
 * (opaque content, no structured context presentation) applies.
 */
export type DshAscSource = {
  readonly kind: typeof PLUGIN_SOURCE_KIND
  /** Which injected-message role this source carries. */
  readonly purpose?: 'nudge' | 'overflow-notice' | 'gate-request'
  /** Set on an in-place decompression replacement. */
  readonly op?: 'decompress'
  /** Checkpoint whose shadowed content a decompression replacement carries. */
  readonly compactionId?: CompactionId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:dsh-asc': DshAscSource
  }
}

/** Message provenance carried by an injected nudge. */
export type NudgeSource = DshAscSource & { readonly purpose: 'nudge' }

/**
 * Create nudge provenance for an injected guidance message.
 * @returns immutable nudge source.
 */
export function nudgeSource(): NudgeSource {
  return Object.freeze({ kind: PLUGIN_SOURCE_KIND, purpose: 'nudge' } as const)
}

/** Message provenance carried by an automatic-compaction notice. */
export type OverflowNoticeSource = DshAscSource & { readonly purpose: 'overflow-notice' }

/**
 * Create provenance for the visible notice that follows a fallback
 * compaction (overflow recovery or manual compaction), so the model knows
 * history was replaced without its explicit choice.
 * @returns immutable notice source.
 */
export function overflowNoticeSource(): OverflowNoticeSource {
  return Object.freeze({ kind: PLUGIN_SOURCE_KIND, purpose: 'overflow-notice' } as const)
}

/** Source carried by the transient request-only messages of this package. */
export type RequestOnlySource = DshAscSource & { readonly purpose: 'gate-request' }

/**
 * Create provenance for a message this package hands to the model without
 * committing it to the durable log (quality-gate and fallback requests).
 * @returns immutable request-only source.
 */
export function requestOnlySource(): RequestOnlySource {
  return Object.freeze({ kind: PLUGIN_SOURCE_KIND, purpose: 'gate-request' } as const)
}

/** Message provenance carried by an in-place restored transcript. */
export type RestoredSource = DshAscSource & {
  readonly op: 'decompress'
  readonly compactionId: CompactionId
}

/**
 * Create provenance for a restored transcript committed back into the
 * surface, marking it as plugin-restored content (not a fresh user prompt).
 * @param compactionId - the checkpoint whose content was restored.
 * @returns immutable restored source.
 */
export function restoredSource(compactionId: CompactionId): RestoredSource {
  return Object.freeze({ kind: PLUGIN_SOURCE_KIND, op: 'decompress', compactionId })
}

/** Whether a persisted user-message source is one of our nudge injections. */
export function isNudgeSource(source: { kind: string; purpose?: string }): boolean {
  return source.kind === PLUGIN_SOURCE_KIND && source.purpose === 'nudge'
}

/** Whether a persisted user-message source is one of our decompression replacements. */
export function isRestoredSource(source: { kind: string; op?: string }): boolean {
  return source.kind === PLUGIN_SOURCE_KIND && source.op === 'decompress'
}

/**
 * Source kinds core owns, which `protection.protectedSources` never matches.
 * Every other kind is a producer-declared identity: either this package's
 * `plugin:dsh-asc` or another plugin's own kind.
 */
const CORE_SOURCE_KINDS = new Set(['user', 'model', 'tool', 'system-prompt'])

/**
 * Producer identities whose source kind changed in session format v4, so a
 * `protectedSources` entry written against the retired `plugin` wrapper still
 * names the same producer's messages.
 */
const RENAMED_PRODUCERS: ReadonlyMap<string, string> = new Map([
  ['compact-checkpoint', 'compact'],
  ['runtime-context', '@deepseek-ai/dsh-system-prompt'],
  ['ptc-mode', 'tools-ptc'],
])

/**
 * Resolve the producer name a persisted source belongs to, or `undefined`
 * when the source is core-owned (`user`/`model`/`tool`/`system-prompt`).
 * @param source - persisted message source.
 * @returns producer name for `protectedSources` matching, else `undefined`.
 */
export function sourceProducerName(source: { kind: string }): string | undefined {
  if (CORE_SOURCE_KINDS.has(source.kind)) return undefined
  const renamed = RENAMED_PRODUCERS.get(source.kind)
  if (renamed !== undefined) return renamed
  return source.kind.startsWith('plugin:') ? source.kind.slice('plugin:'.length) : source.kind
}
