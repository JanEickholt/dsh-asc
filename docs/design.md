# ASC Design: Agentic Surface Compaction for DeepSeek Harness

> The design rationale and the comparison that motivate it live in
> [analysis.md](analysis.md). This document is the implemented contract:
> what the package does, the events it owns, the tools it exposes, and the
> invariants it enforces.

## 1. Position in the harness

The package mounts on the standard `ctx.compaction` seam — the same seam
`@deepseek-ai/dsh-compaction-basic` uses — as a function plugin row:

```yaml
# cordis.yml (profile patch or preset)
plugins:
  - name: "dsh-asc"
    config:
      auto: true
```

It also registers five model-facing tools (`context_compress`,
`context_decompress`, `context_recap`, `context_status`,
`context_search`) and, optionally, the invariant companion row
(`dsh-asc/invariant`).

Nothing in the agent loop changes. Everything the plugin produces is either
a session event on the existing log or a registration on an existing seam:
`ctx.compaction`, `ctx.tools`, `agent/pre-step`, `agent/request-error`,
`agent/status`, `session/event`, and the invariant registry. Unmounting the
plugin row removes every effect.

## 2. The philosophy

**The model decides when and what to compact; the log decides how it is
represented.**

- Compression decisions and summaries are written by the model through
  `context_compress`. The backend validates hard constraints and commits
  the standard DSH compaction transaction (`compaction/start` →
  `compaction/summary` → replacement `user/message` with `surfaceOp:
  replace` → `compaction/end`).
- Block state is *derived from the log*. A checkpoint is any surface node
  whose source is `compactCheckpointSource`; its tier is a fold over the
  shadow chain (T1 shadows raw nodes, T2 shadows T1 checkpoints, …). There
  is no side file, so the entire ACP bug family — state drift between side
  stores and the message stream — is structurally impossible.
- Decompression undoes a compression in place. `context_decompress`
  reconstructs the shadowed transcript from the events that remain in the
  log and commits it back into the surface at the checkpoint's own position
  (an in-place replace: the checkpoint node is shadowed by a `user/message`
  carrying the original content), so the model sees the original content
  where it used to be. Tier-aware: one tier up by default, `full: true`
  expands recursively to raw content.
- Nudges are logged and precisely priced. Every nudge is an appended
  `user/message`, so "model-visible ⟺ logged" holds and its cost is
  measurable; the cadence state machine combines the token meter with
  transient per-session baselines.
- Search covers the full log. `context_search` runs session-query FTS over
  *all* events — including `shadowed` ones — and reports each hit's surface
  status. Retrieval is recognition-first: every checkpoint text carries its
  topic and Compaction id, so a visible summary can be expanded directly.
  Search is the locator only for details whose owning block no visible
  summary names; decompression is the fetcher for a recognized or located
  block.
- Degradation is deterministic. Overflow recovery and manual compaction
  fall back to head-anchored selection plus one cache-friendly
  `ctx.llm.stream()` summarization call, exactly like `compaction-basic`.

## 3. Durable facts and platform compatibility

The backend deliberately declares **no custom `SessionEventMap` members**.
This harness release refuses to persist or index logs containing event types
outside its generated vocabulary unless the event carries the envelope's
`ignorable` marker — and `Session.append` does not yet expose a way to set
that marker for out-of-tree plugins. Every durable fact therefore rides on
already-known event types:

| Fact | Known event type |
|---|---|
| Compression transaction | `compaction/start` → `compaction/summary` → replacement `user/message` (`surfaceOp: replace`, `compactCheckpointSource`) → `compaction/end` |
| Summary authorship | `compaction/summary.llmStreamCall` — `true` means the fallback LLM call; model-written summaries never carry it |
| A nudge | an appended `user/message` with source `{ kind: 'plugin', plugin: 'dsh-asc', purpose: 'nudge' }` and `surfaceOp: 'append'` |
| A decompressed transcript | an in-place replacement `user/message` with source `{ kind: 'plugin', plugin: 'dsh-asc', op: 'decompress', compactionId }`, committed over the checkpoint node (`surfaceOp: replace`) |
| Checkpoint tier | derived from the shadow chain (`tierSnapshot`) |

Nudge cadence and tier baselines are **transient in-memory state**
(`WeakMap<Session, NudgeState>`): a fresh process re-establishes the
baseline before nudging again, so a restart can never double-fire, and the
nudge messages themselves remain durable and replayable. The pending
blocking quality-gate rejection (`WeakMap<Session, …>`) is transient for
the same reason: after a restart the model simply re-submits the summary
and receives a fresh gate evaluation. An in-place `context_decompress` also
resets the transient nudge baseline, so the model's own restore is not
counted as unexpected growth on the next step.

## 4. The five tools

### `context_compress`
Compresses one or more surface ranges into model-written checkpoints.

- `content: [{ topic?, startSeq, endSeq, summary, acknowledgeRisk? }]` — up
  to 64 entries. A supplied topic is persisted as a heading inside the
  checkpoint summary, so later search/recap can locate it by topic.
- `acknowledgeRisk?: boolean` — retries a blocked quality-gate rejection for
  the exact range set.
- Hard constraints enforced before commit (per entry, failures reported
  without committing):
  1. both seqs on the current surface, in order;
  2. balanced tool-pairing at both edges;
  3. no protected node inside (recent tail, protected tools/sources, user
     messages when configured, tier-capped checkpoints);
  4. non-empty summary;
  5. the framed checkpoint must be strictly smaller than the shadowed
     content (token-meter priced);
  6. the durable compaction lock must be free.
- Quality gate: L1 length/retention floor + L2 ROUGE-1/keyword recall for
  raw (tier-1) summaries. Tier >= 2 distillation uses its own shorter
  length/retention floors and waives the keyword-coverage layer, because
  the tier-2/3 writing rules intentionally drop the lower-level vocabulary.
  Blocking failures reject the whole plan once; the exact-range retry with
  `acknowledgeRisk` bypasses. Non-blocking mode records the outcome.
- Result: `{ compressed: [...], failures: [...] }` with per-entry
  `compactionId`, `tier`, shadowed `startSeq`/`endSeq`, `shadowedSeqs`,
  `shadowedTokenCount`, `summaryTokenCount`, `author`, `topic?`,
  `expandedFrom?`, `quality?`.

### `context_decompress`
Restores compressed content by replaying the log.

- `compactionIds?: string[]` or `startSeq/endSeq` (mutually exclusive
  targeting; a range resolves every checkpoint whose current surface
  position — the position of its collapsed shadowed span — lies inside it).
- `full?: boolean` — one tier up by default; recursive to raw content with
  `full: true`.
- Budgets: `decompress.maxTokens` per call (priced as the combined
  `user/message` that will actually be appended; over-budget targets are
  skipped and reported) and `decompress.maxBlocks` per call (hard error).
- Each restored transcript is committed back into the surface at its
  checkpoint's position — an in-place replace (the checkpoint node is
  shadowed by a `user/message` carrying the original content with
  `restoredSource(compactionId)` provenance) — so the compression is
  undone and the original content appears where it used to be. A target
  whose checkpoint is no longer on the surface (already restored) is
  skipped and reported.
- `toFile` writes the transcript through the optional fs service and keeps
  the checkpoint compressed. A single target uses the requested path
  verbatim; multiple targets receive derived sibling paths (`name-1.ext`,
  `name-2.ext`, …) so no transcript overwrites another, and each result
  reports the path it wrote.
- The tool result reports statistics and a preview or path only (no inline
  content), keeping the model-visible footprint equal to the restored
  transcript rather than doubling it.
- Result: `{ restored: [{ compactionId, tier, checkpointSeq, restoredSeqs,
  restoredTokens, restoredChars, preview, path? }], skipped: [...] }`.

### `context_recap`
Re-reads checkpoint summaries without decompressing the originals.

- `compactionIds?: string[]` — omit to recap every checkpoint on the
  current surface. Explicit ids resolve against the full log, including
  checkpoints that a later compression consumed.
- `tier?: number` — optional level filter (1 full detail, 2 decisions,
  3 facts); combine with omitted ids to read one whole pile.
- Summaries are read from the durable `compaction/summary` events, so a
  recap never depends on the original compress call still being visible.
- Read-only: no surface mutation, no budget is charged beyond the returned
  summary text itself.

### `context_status`
Reports usage (token-meter baseline kind/tokens, total, window, percent),
checkpoints by tier with their shadowed spans, per-tier token totals,
protected seqs (protection policy, recent tail, tier cap), recommended
ranges, and the recent surface nodes with
seq/position/kind/tokens/tier/protection/preview. Positions are 0-based
surface positions (0 = the oldest current surface node); the recent-node
list is capped to the last 40 nodes and each entry carries its own
position.

### `context_search`
Full-text search through the optional session-query service. `scope:
session` searches the current session; `scope: workspace` searches all
sessions. `surface` optionally restricts hits to `current`, `shadowed`, or
`log-only`. Hits carry `seq`, `type`, `surface`, and a snippet;
session-scope shadowed hits also carry the owning `checkpointId`. Requires
a session-query backend such as
`@deepseek-ai/dsh-session-query-sqlite`.

## 5. Automatic behavior

Registered only when `auto: true` (default):

- `agent/pre-step` (waterfall): pressure evaluation. The first observation
  establishes a transient baseline; afterwards `decideNudge` decides
  `pressure` (over-max, frequency-gated), `tier` (per-tier growth past
  `tiers.growthTokens`, only for tiers below the cap with consumable
  checkpoints), or `iteration` (messages since the last user prompt past
  `nudge.iterationThreshold`, in the over-min band). On a decision, the
  engine appends the nudge `user/message`. Always calls
  `next()`.
- `agent/request-error` (waterfall): on `CONTEXT_WINDOW_EXCEEDED`, prunes
  tool results through the optional `toolResultPruner`, selects a range with
  the deterministic fallback, and commits an LLM-summarized compaction
  (author `fallback`), then returns `{ kind: 'retry' }`. Bounded by
  `fallback.maxOverflowRetries`; durable surface progress after a failure
  also counts as retry proof.
- `agent/status` + `session/event` (assistant/message): reset the overflow
  retry counters.

Nudge baseline semantics: a nudge resets its own cadence; a compression
resets the baseline of the tier it *consumed* (a tier-2 checkpoint resets
the tier-1 pile; a tier-1 capture only grows it). This is what lets
distillation accumulate growth across captures.

## 6. Deterministic fallback

`compactIfNeeded('context-overflow')`, `compactNow`, and `compactRegion`
share one path: selection with the routed-model retention budget
(`retainRatio`/`retainTokens`/`modelPolicies`, scaled by the adapter's
context window; `thresholdRatio` is the validation ceiling the budget must
stay below), hard fences for protected nodes, the configured recent-tail
node count, and the tier cap; then one
`ctx.llm.stream()` call whose envelope reuses the conversation's own system
prompt and tool schemas and carries the shadowed region in surface order
(KV-cache friendly); then the same durable transaction with author `fallback`. `compactRegion` re-validates
its explicit range against the protection and tier-cap policy before
summarizing. `compactNow` additionally runs under `agent.runMaintenance`,
uses selected-span stability (context may land outside the span between the
marker pair), writes a standalone bracket (owner `null`), and flushes
through `ctx.sessions.flush`.

## 7. Protection policy

| Rule | Default | Config |
|---|---|---|
| First human user message never compressed | on | `protection.protectFirstUserMessage` |
| Recent tail never included in a range | 20 nodes | `protection.retainRecentMessages` |
| `context_compress`/`context_decompress` call records are compressible like any other surface content; compression audit lives in log-only `compaction/*` events and decompression audit lives in the restored `user/message` plus shadowed originals | — | fixed |
| Tool outputs excluded from ranges | `[]` | `protection.protectedTools` |
| Plugin-sourced injected messages excluded (including `dsh-asc`'s own nudges/notices/restores when listed) | `[]` | `protection.protectedSources` |
| All human user messages excluded | off | `protection.protectUserMessages` |
| Checkpoints at the tier cap cannot be consumed | tier 3 | `tiers.maxTier` |

## 8. Invariants (the companion row)

The companion (`dsh-asc/invariant`) registers under the
package name and is currently an empty installer: the backend declares no
custom event vocabulary, and the `compaction/*` bracket structure is
enforced by the upstream `@deepseek-ai/dsh-compaction/invariant` companion.
The row exists so compositions that mount it keep working as the vocabulary
story evolves.

## 9. Configuration reference

See [usage.md](usage.md#configuration) for the full table with defaults.

## 10. Reliability properties

- **Reversible**: every compression is a log replacement; the original
  events remain in the log and `context_decompress` replays their original
  text content as a serialized transcript back into the surface.
- **Searchable**: FTS indexes the full log including shadowed events.
- **Auditable**: model-visible ⟺ logged; every nudge is a durable user
  message, every compression is the upstream bracket, and every restored
  transcript is an in-place replacement logged over the checkpoint.
- **Crash-safe**: the transaction bracket and the end-seed boundary are the
  upstream mechanisms; a failed commit leaves a detectable unmatched start.
- **Platform-compatible**: no custom session-event types, so persistence,
  replay, resume, and FTS all accept the logs this backend writes.
- **Deterministic degradation**: overflow and manual compaction never
  depend on the model's willingness to compress.
