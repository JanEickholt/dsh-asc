# Changelog

All notable changes to dsh-asc are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.11] - 2026-08-15

### Fixed

- `npm-publish` also triggers on version tag pushes, because the
  `release published` event did not fire for releases created by the
  release workflow itself.

## [0.1.10] - 2026-08-15

### Changed

- `npm-publish` now prefers npm trusted publishing (GitHub OIDC) with no
  long-lived token; a classic `NPM_TOKEN` secret remains available as a
  fallback.
- README documents the trusted-publisher setup and why the 2FA-bypass
  option should not be enabled.

## [0.1.9] - 2026-08-15

### Added

- `CHANGELOG.md` with per-version notes; GitHub Releases now take their
  notes from this file instead of auto-generated commit summaries.
- `npm-publish` workflow: publishes to the npm registry when a GitHub
  Release is published and the `NPM_TOKEN` secret is configured; it no-ops
  safely while the secret is absent.
- Release and backfill workflows can refresh release notes for already
  published tags.

### Changed

- The npm tarball now includes `CHANGELOG.md`.

## [0.1.8] - 2026-08-15

### Added

- GitHub Actions release workflow: every new `v*` tag builds the package,
  packs it, and publishes a GitHub Release with the tarball attached.
- Release backfill workflow for tags that predate the automation.

### Fixed

- Release workflow no longer performs a redundant tag checkout on tag
  pushes, which made the first automated release run fail.

## [0.1.7] - 2026-08-15

### Added

- Every checkpoint text now carries its own `Compaction id`, so a visible
  summary can be expanded directly without a lookup step.

### Changed

- Retrieval doctrine is now recognition-first: read visible summaries,
  decompress a recognized block directly, and use search only when no
  visible summary names the owning block.
- `context_status` is positioned as a compress-planning tool rather than a
  retrieval prerequisite.
- Tool descriptions and docs were synchronized with the retrieval model.

## [0.1.6] - 2026-08-15

### Added

- `context_status` checkpoint rows expose the persisted topic label as the
  table of contents of the compressed context.
- Doctrine now distinguishes block navigation from token search and
  teaches "search is the locator, decompress is the fetcher".

### Changed

- `context_decompress` is documented as a fetch operation, not a discovery
  operation; `context_search` is documented as the fallback for unknown
  locations.

## [0.1.5] - 2026-08-15

### Added

- `COMPRESSION CONTRACT FOR RETRIEVAL` in the doctrine: summaries must
  retain future-search keys, declare deliberately dropped detail, and use
  topics.
- `context_recap` gains a `tier` filter for reading one whole level
  (1 detail, 2 decisions, 3 facts).
- `context_search` gains a `surface` filter (`current`, `shadowed`,
  `log-only`).
- Model-supplied topics are now persisted inside the durable summary so
  recap and search can find them.

### Changed

- Retrieval doctrine rewritten as a context-management loop: capture,
  distill, condense, read, update, archive.

## [0.1.4] - 2026-08-15

### Fixed

- The doctrine no longer promises automatic tool-pair expansion when the
  deployment disabled `compress.autoExpandToolPairs`.
- Strong pressure nudges no longer promise the deterministic fallback when
  `fallback.enabled` is false.
- The model is told when the quality gate is non-blocking or disabled.
- Tiers above 3 are explained for deployments that raise `tiers.maxTier`.

## [0.1.3] - 2026-08-15

### Added

- Tier-aware quality gate: tier >= 2 distillation uses dedicated
  `distillationMinChars` / `distillationMinRetentionPct` floors, and the
  keyword-coverage layer is waived because the tier rules intentionally
  drop lower-level vocabulary.
- The doctrine now teaches the complete raw/T1/T2/T3 operating model:
  capture, distill, condense, read before shrinking.
- Tier nudges name the exact TIER 2 DISTILLATION or TIER 3 CONDENSATION
  rules to follow.

### Changed

- `context_compress`, `context_status`, and nudge text expose tier piles
  (`tierTokens`) and the resulting-tier writing rules.

## [0.1.2] - 2026-08-15

### Added

- Protection and tier-cap checks are enforced inside the compaction
  transaction, with expected-shadowed-span identity verified at commit time.
- Session-scope shadowed search hits carry the owning `checkpointId`.
- `context_recap` resolves consumed checkpoints from the full log.
- `context_status` renders one line per node so recent nodes and
  recommendations survive the output cap.
- The `fs`-resolved `toFile` path is reported; nested tool-result text is
  shown in status previews.
- `@deepseek-ai/dsh-system-prompt` is declared as a peer dependency.

### Changed

- `compactNow` uses selected-span stability, preserves caller abort
  reasons, and classifies async maintenance failures as `summary`.
- Open-turn detection honors the latest `session/end-seed` boundary.
- `protectedSources` now applies to the plugin's own nudge/restored nodes.
- Newly appeared tier piles are measured from a zero baseline, and
  tail-only tier piles no longer trigger nudges.
- Partial plugin/tool registration failures dispose their already-mounted
  effects.
- Documentation and tool schemas were reconciled with runtime behavior.

## [0.1.1] - 2026-08-15

### Added

- Routed retention policy (`thresholdRatio` / `retainRatio` /
  `retainTokens` / `modelPolicies`) is now wired into deterministic
  fallback selection instead of being dead configuration.
- Fallback selection honors protected nodes, the recent-tail fence, and the
  tier cap; `compactRegion` validates explicit ranges against policy.
- The quality gate prices the framed checkpoint and reports measured
  coverage values on L1 failures; acknowledged retries retain the report.
- `toFile` restores with multiple targets write distinct sibling paths.

### Fixed

- Restored transcripts no longer inherit the consumed checkpoint's tier.
- `toolNameIndex` and tier snapshots invalidate correctly on surface
  appends.
- Decompress budget prices the actual combined restored message.
- `resolveTargetPolicy` no longer lets a global `retainTokens` override an
  explicit per-model `retainRatio`.
- Nudge baselines are re-measured after nudge/notice appends, and consumed
  tier baselines are dropped when the tier disappears.
- `pnpm-workspace.yaml` no longer contains the invalid `allowBuilds`
  placeholder; `prepare`/`prepack` build the package before install/pack.
- README installation now names the actual distribution channel.

## [0.1.0] - 2026-08-14

### Added

- Initial standalone dsh-asc plugin: model-driven surface compaction over
  DSH's event-sourced session log.
- Five model tools: `context_compress`, `context_decompress`,
  `context_recap`, `context_status`, `context_search`.
- Durable `compaction/start|summary|end` transactions, tier derivation,
  quality gate, deterministic fallback summarization, nudge state machine,
  protection policy, and the context-management doctrine.
