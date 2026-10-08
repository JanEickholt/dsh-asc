# Changelog

All notable changes to dsh-asc are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are consolidated: tags are only created for meaningful, coherent
releases, not for every commit.

## [Unreleased]

## [0.4.0] - 2026-10-08

This is the dsh `0.2.0-rc.2` generation release: the peer range admits both
host generations, message sources are producer-owned, tool results are
first-class messages, and the plugin gains measured-in-production analytics.

### Changed (breaking)

- Migrated to dsh `0.2.0-rc.2`: the built plugin now targets core
  `@deepseek-ai/dsh-*` `>=0.2.0-rc.1 <0.3.0` (the `peerDependencies` range
  additionally admits `^0.1.5-rc.2`), and the dsh loader no longer skips
  this profile bundle as incompatible. Two core contracts changed and the
  plugin follows them:
  - Message sources are producer-owned. Session format v4 refuses to
    persist a message whose source still carries the shared
    `{ kind: 'plugin', plugin }` wrapper, so every message this plugin
    injects now carries its own `kind: 'plugin:dsh-asc'` (declared through
    `MessageSourceMap`) with the same `purpose`/`op`/`compactionId` fields.
    `protection.protectedSources` entries now name a producer; renamed
    core producers (`compact`, `tools-ptc`) still resolve.
  - Tool results are first-class messages. A tool result is a `tool`-role
    message with `toolCallId`/`isError` on the message instead of a
    `tool-result` content block, so the projection service reads and
    rewrites `message.content` directly and `context_retrieve` reads the
    stored blocks from the message itself.

### Added

- Per-signal quality scores are now recorded on every fold, passing
  summaries included (issue #1 follow-up): the gate report carries
  `metrics` on passing evaluations too, and the report persists in the
  session log as provenance fields on the compaction bracket's replacement
  `user/message` source. Deployments can read their own recall distribution
  from the log and derive floors from it, as the issue's follow-up
  measurements recommend, instead of inheriting the defaults.
- `metrics.top20LongNumericRecall`: recorded (never gated) top-20 recall
  over 3+ digit runs — the fragment-free value-survival reading. The plain
  numeric top-20 saturates with 1-2 digit split fragments on large
  originals (dates and decimals split into short runs), so the long
  variant is the per-fold reading that tracks value fidelity.
- `scripts/quality-scores.ts` (repo-local dev tool, not published): corpus
  sampler that recomputes the gate's signals for every fold in historical
  session logs and prints the distribution, floor fire counts, singleton
  tail recall, top-20 composition, the 3+ digit concentration stats
  (distinct runs, top-20 mass coverage), and the within-corpus
  concentration ↔ recall correlations, so the derive-floors-from-your-
  own-corpus method is executable directly.
- Test coverage proving the recorded quality report survives the storage
  boundary: snapshot → JSONL line → validated `Session.create` replay,
  the path a restart or offline log reader takes.
- Session-log analytics (built with parallel worktree lanes, one feature
  per lane):
  - `scanSessionUsage(session)` in `src/analytics/scan.ts`: pure fold over
    the durable log producing a `UsageReport` — per-checkpoint
    `decompressCount`/`recapCount`, the six `context_*` tool calls, and
    decompress outcomes (`restored`/`to-file`/`skipped`/`failed`).
  - `computeSignals(report, options?)` in `src/analytics/signals.ts`:
    regret classification (decompress within `analytics.regretSeqWindow`,
    default 200 seqs, after a fold flags over-folding), zero-inclusive
    per-checkpoint maps, and a quiet-tail verdict.
  - `asc-stats` profile command via `registerAnalyticsCommand` (gated by
    `analytics.enabled`, default on): scans the active session, derives
    signals, renders a human report. Commands are a host service the
    plugin now injects explicitly.
  - `scripts/bili-cache-join.ts` + `docs/cache-join.md`: offline join of
    dsh-asc folds against a bili wire-proxy `acp_cache` ledger — per-fold
    re-pay vs shadowed tokens with PAID BACK / NOT PAID BACK verdicts.
  - `scripts/corpus-stats.mjs`: reproducible production-numbers scanner
    (sessions, folds, shadowed tokens, retrieval usage, cache hit rate,
    post-fold re-pay) over DSH session logs; backs the README's
    "Measured in production" section with numbers from real sessions.
- Fold fingerprint persistence (issue #3): each checkpoint records the
  fingerprint of the content it was produced from, and the quality-scores
  sampler dedupes folds by fingerprint so re-folds of identical ranges
  don't double-count in corpus readings.

### Fixed

- `registerAnalyticsCommand` is now wired into `apply()` (it was exported
  but never mounted, so published builds never registered `asc-stats`);
  the `commands` service is declared in the plugin's `inject` array.

## [0.3.1] - 2026-10-04

Motivated by the field readings in
[issue #1](https://github.com/JanEickholt/dsh-asc/issues/1) (recorded in
`docs/analysis.md` §5): folded summaries keep guidance but lose exact
values, and paraphrased live state drifts across generations until it
contradicts the log.

### Added

- `qualityGate.layer2MaxNumericRecall` (default `0.20`): third AND-combined
  L2 coverage signal — top-20 numeric-literal recall over pure digit tokens
  in the original, matched exact-string. A tier-1 summary that drops every
  exact value no longer passes the gate on word overlap alone.
- `topNumericRecall` exported from the plugin entry.

### Changed

- Quality-gate id is now `rouge-recall-v2`: L2 reports ROUGE-1 F1, top-20
  keyword recall, and top-20 numeric recall together, and rejects only when
  all three are below their floors. Tier >= 2 distillation waives the
  numeric-recall floor like the other coverage floors.
- Compaction doctrine (KEEP VERBATIM) now requires live state — goal
  status, blockers, pending decisions, standing commitments — to be copied
  verbatim from the newest event in the range and stamped "as of" that
  event, because paraphrased state is rewritten on every fold while quoted
  state survives unchanged.

## [0.3.0] - 2026-09-14

Feature release: post-execute **reversible tool-result projection** and the
`context_retrieve` tool, adapted from the MIT-licensed flowctx-dsh port of
flowctx (see `NOTICE` for the full attribution chain).

Oversized tool results used to enter the context verbatim and were only
trimmed later by the overflow-triggered tool-result pruner — blind, lossy,
and only when something else already failed. The projection service now
compresses oversized tool results BEFORE they enter the context, content-
aware and reversible: the original stays byte-exact in the session log
(single source of truth — no side store), and the replacement carries a
retrieval marker naming the original's hash and seq.

### Added

- `toolResultProjection`, a separate optional cordis service (independent of
  `ctx.compaction`; the pruner stays mounted as the overflow fallback):
  - listens on the `tools/post-execute` waterfall and measures each
    candidate's text blocks with the real `ctx.tokenMeter` service —
    thresholds are token-based, no char heuristics;
  - returns every waterfall decision UNCHANGED, so the original event still
    lands in the log first; the reversible commit then shadows the original
    (compaction/prune) and appends the replacement, exactly like the
    tool-result pruner's shadow+replace pattern;
  - reducers: structured explorers for JSON/YAML/XML/delimited/code,
    git-diff hunk compaction, search-result clipping, and CLI rule
    reduction; a meter-priced head/tail slice as the final fallback;
  - markers are emitted ONLY when the original is durably stored in the log,
    so a marker never dangles; if the materialized result shrinks or the
    plan cannot beat the threshold, nothing is committed;
  - store/persistence failures during a commit are logged loudly — the
    original remains byte-exact in the log.
- `context_retrieve`, the sixth context tool: returns a stored original
  byte-exact by 24-hex sha-256 hash or by seq, from the shadowed log event;
  unknown or expired keys return a diagnostic string, never fabricated
  content. Originals survive restarts because they are session-log events.
- Config block `projection` with `enabled` (default `true`) and
  `thresholdTokens` (default `1000`).

## [0.2.2] - 2026-09-12

Port to harness core `@deepseek-ai/dsh-*` `0.1.5-rc.2`. On a `0.1.5` core the
surface fold rejected the agent loop's durable `system/message` events — core
made the system prompt a surface-eligible event — so every context tool
(`context_status` included) failed with `session event "system/message" is not
surface-eligible and cannot carry surfaceOp`.

### Fixed

- Read the fallback summarizer's `system` from the log's latest non-empty
  `system/message` event (new `sessionSystemPrompt` in `region.ts`);
  `EpochHeader` no longer carries a `system` field.
- Rename the replace `surfaceOp` bounds to `startSeq`/`endSeq` in the commit
  and restore paths, matching the `0.1.5` surface contract.
- Protect the surface head system-prompt node. The head-history
  recommendation collapsed to that single node (it sat unprotected in front
  of the protected first user message), and core rejects any user checkpoint
  replacing it — so a 310k-token session compressed by ~10k instead of the
  full-history drop.
- `context_search` degrades instead of dying when the query service's
  persistence observation fails (`SESSION_QUERY_PERSISTENCE_FAILED`): one
  corrupt or legacy-format sibling log previously killed search in every
  scope, because the observation loads all persisted logs. The tool now
  returns an empty hit list with the diagnostic so the offending log can be
  identified and moved.

### Changed

- Peer/dev dependencies and the workspace override range now admit
  `^0.1.5-rc.2` (semver excludes prereleases whose `major.minor.patch` tuple
  differs from the range floor, so the old `^0.1.2-rc.1` never matched
  `0.1.5-rc.2`).
- Test fixtures embed the now-required empty assistant `stream` array.

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
