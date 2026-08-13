/**
 * Session-event vocabulary.
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
 * - the summary authorship is recoverable from `compaction/summary`'s
 *   `llmStreamCall` flag (model-written vs fallback LLM call);
 * - nudges are appended `user/message` events whose source is
 *   `{ kind: 'plugin', plugin: 'dsh-asc', purpose: 'nudge' }`;
 * - decompressed transcripts travel in the `tool/result` of
 *   `context_decompress`.
 *
 * Nudge cadence and tier baselines are transient in-memory state (a fresh
 * process re-establishes the baseline before nudging again), documented in
 * the design and usage documents.
 *
 * @module @dsh-asc/compaction-agentic/events
 */
