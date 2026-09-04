# Changelog

All notable changes to dsh-asc are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are consolidated: tags are only created for meaningful, coherent
releases, not for every commit.

## [0.2.1] - 2026-09-04

Port to harness core `@deepseek-ai/dsh-*` `0.1.2-rc.1`. Upstream `0.2.0`
compiles against `0.1.0-rc.6` and every context tool crashes at runtime on
a newer core with `Cannot read properties of undefined (reading 'entries')`.

### Fixed

- `Session.events` no longer exists; all reads go through
  `session.snapshotEvents()`.
- Plain seq numbers are branded with `SessionSeq(...)` where the new API
  requires it: surface reads, `toolPairingBalanced*` calls,
  `compaction/summary` payloads, `surfaceOp: replace` appends, and
  `sourceEventSeqs`.
- `deepFreeze` and `assertNever` now come from `@deepseek-ai/dsh-util-values`
  (moved out of `dsh-llm`); the test `CallId` brand is renamed `ToolCallId`.

### Changed

- Peer/dev dependencies and the workspace override pin `0.1.2-rc.1`.
- `TokenMeter` requires the `sessionProjections` service, so test fixtures
  and the loader-composition test mount `@deepseek-ai/dsh-session-projection`
  first.

## [0.2.0] - 2026-08-15

First audited release after the initial `0.1.0` package.

### Core correctness and safety

- Wired the routed retention policy (`thresholdRatio` / `retainRatio` /
  `retainTokens` / `modelPolicies`) into deterministic fallback selection;
  it was previously parsed but never used.
- Enforced protection, recent-tail, and tier-cap checks inside the
  compaction transaction, including an expected-shadowed-span identity
  check after the LLM summary call, so concurrent surface changes or
  overlapping batch ranges cannot commit a summary against different
  content.
- Repaired restored-node tier derivation: non-checkpoint replacements now
  return to tier 0 instead of inheriting `checkpoint tier + 1`.
- Fixed cache invalidation for tool names and tier snapshots when the
  surface receives plain appends.
- Made `toFile` decompression write distinct sibling paths for multiple
  targets and report the fs-resolved path; the decompress budget now prices
  the actual combined restored message.
- Hardened `compactNow`: selected-span stability, exact abort-reason
  propagation, correct busy/summary classification, and end-seed lifecycle
  handling for open turns.
- Added the missing `@deepseek-ai/dsh-system-prompt` peer dependency and
  disposed partial plugin/tool registrations on failure.

### Tiers, quality gate, and doctrine

- Turned tier 1/2/3 into an explicit operating model in the system
  doctrine: capture raw work into T1, distill settled T1 piles into T2,
  condense settled T2 piles into T3, and read before shrinking.
- Added a tier-aware quality gate: raw tier-1 captures keep the full
  length/coverage floors; tier >= 2 distillation uses its own shorter
  floors and waives the keyword-coverage layer, because those rules
  intentionally drop lower-level vocabulary.
- Tier nudges now name the exact TIER 2 DISTILLATION or TIER 3
  CONDENSATION rules to use, and the doctrine explains tiers above 3 when
  the cap is raised.
- Model-facing wording is truthful under non-default configuration
  (auto-expansion off, fallback off, non-blocking or disabled quality
  gate).

### Retrieval and context management

- Added `COMPRESSION CONTRACT FOR RETRIEVAL`: summaries must retain future
  search keys, declare deliberately dropped detail, and carry a topic.
- Topics are persisted inside durable summaries; `context_status` exposes
  them as a checkpoint index.
- Every checkpoint text now carries its own `Compaction id`, so a visible
  summary can be expanded directly without a lookup step.
- Retrieval is recognition-first: visible summaries are the primary
  locator, `context_search` is for details whose owning block is unknown,
  and `context_decompress` only fetches a located block one tier at a time.
- `context_recap` gained a `tier` filter; `context_search` gained a
  `surface` filter; session-scope shadowed search hits carry the owning
  `checkpointId`.
- `context_status` uses a one-line-per-node renderer so recent nodes and
  recommendations survive the output cap, and shows nested tool-output
  text in previews.

### Protection, nudges, and recommendations

- `protectedSources` now also protects this plugin's own nudge, notice,
  and restored messages when `dsh-asc` is listed; `context_status` marks
  recent-tail and tier-cap nodes as protected.
- Nudge baselines re-measure after nudge/notice appends; consumed tier
  baselines are removed when the tier disappears; newly appeared piles are
  measured from zero; tail-only piles do not fire tier nudges.
- In-place decompression resets the transient nudge baseline so the
  model's own restore is not treated as unexpected growth.
- Recommended ranges are validated against the full eligibility policy,
  are pairwise non-overlapping, and cut around tier-cap nodes.

### Quality gate details

- The gate prices the framed checkpoint and reports measured ROUGE/recall
  values even on L1 failures; acknowledged retries still record and return
  the rejected report.
- Mixed CJK/Latin text is tokenized correctly, keeping Latin words intact.

### Packaging, docs, and automation

- Fixed the invalid `allowBuilds` placeholder in `pnpm-workspace.yaml`;
  `prepare`/`prepack` now build the package before install/pack.
- Added `CHANGELOG.md`; GitHub Releases are created automatically for
  meaningful `v*` tags with changelog notes and the built tarball.
- Added `npm-publish`: prefers npm trusted publishing (GitHub OIDC) with a
  classic `NPM_TOKEN` fallback; publishes trigger on version tags.
- Reconciled README/design/usage/prompt/tool schemas with runtime behavior,
  including the five-tool contract, real search surface values, and the
  current GitHub/npm distribution channels.

## [0.1.0] - 2026-08-14

### Added

- Initial standalone dsh-asc plugin: model-driven surface compaction over
  DSH's event-sourced session log.
- Five model tools: `context_compress`, `context_decompress`,
  `context_recap`, `context_status`, `context_search`.
- Durable `compaction/start|summary|end` transactions, tier derivation,
  quality gate, deterministic fallback summarization, nudge state machine,
  protection policy, and the context-management doctrine.
