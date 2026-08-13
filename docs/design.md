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
  - name: "@dsh-asc/compaction-agentic"
    config:
      auto: true
```

It also registers four model-facing tools (`context_compress`,
`context_decompress`, `context_status`, `context_search`) and, optionally,
the invariant companion row (`@dsh-asc/compaction-agentic/invariant`).

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
- Decompression replays the log. `context_decompress` reconstructs the
  shadowed transcript from the events that remain in the log and appends it
  as a durable `user/message`. Tier-aware: one tier up by default, `full:
  true` expands recursively to raw content.
- Nudges are logged and precisely priced. The nudge state machine folds
  `context/nudge` and `context/compress` records plus the token meter; the
  nudge itself is an appended `user/message`, so "model-visible ⟺ logged"
  holds and its cost is measurable.
- Search covers the full log. `context_search` runs session-query FTS over
  *all* events — including `shadowed` ones — and reports each hit's surface
  status and owning checkpoint.
- Degradation is deterministic. Overflow recovery and manual compaction
  fall back to head-anchored selection plus one cache-friendly
  `ctx.llm.stream()` summarization call, exactly like `compaction-basic`.

## 3. Session events owned by the package

All three are log-only (no `surfaceOp`); each is immediately followed by
the model-visible `user/message` it records, mirroring the shadow-price
adjacency protocol of `compaction/prune`.

### `context/nudge`
```ts
{
  kind: 'pressure' | 'iteration' | 'tier'
  tier?: number                    // recommended distillation target
  totalTokens: number              // token-meter total at emission
  surfaceTokens: number
  growthSinceBaseline: number
  tierTokens?: { tier: number; tokens: number }[]
  recommendation?: { start: number; end: number; reason: string }[]
}
```
The following `user/message` carries the nudge text with source
`{ kind: 'plugin', plugin: 'dsh-asc', purpose: 'nudge' }` and
`surfaceOp: 'append'`.

### `context/compress`
```ts
{
  compactionId: CompactionId       // matches the enclosing bracket
  author: 'model' | 'fallback'
  tier: number                     // derived from the shadow chain
  totalTokens: number              // post-replacement total (next baseline)
  tierTokens?: { tier: number; tokens: number }[]
  quality?: { passed: boolean; blocking: boolean; gate: string; note?: string }
}
```
Appended between the replacement and `compaction/end`.

### `context/decompress`
```ts
{
  compactionId: CompactionId
  tier: number
  full: boolean
  restoredSeqs: number[]
  restoredTokens: number
  restoredChars: number
}
```
The following `user/message` carries the restored transcript with source
`{ kind: 'plugin', plugin: 'dsh-asc', op: 'decompress', compactionId, tier,
full }` and `surfaceOp: 'append'`.

## 4. The four tools

### `context_compress`
Compresses one or more surface ranges into model-written checkpoints.

- `content: [{ topic?, startSeq, endSeq, summary }]` — up to 64 entries.
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
- Quality gate: L1 length/retention floor + L2 ROUGE-1/keyword recall.
  Blocking failures reject the whole plan once; the exact-range retry with
  `acknowledgeRisk` bypasses. Non-blocking mode records the outcome.
- Result: `{ compressed: [...], failures: [...] }` with per-entry
  `compactionId`, `tier`, shadowed seqs/tokens, summary tokens, author.

### `context_decompress`
Restores compressed content by replay.

- `compactionIds?: string[]` and/or `startSeq/endSeq` (mutually exclusive
  targeting; a range resolves every checkpoint whose shadowed span
  overlaps it).
- `full?: boolean` — one tier up by default; recursive to raw content with
  `full: true`.
- Budgets: `decompress.maxTokens` per call (over-budget targets are skipped
  and reported) and `decompress.maxBlocks` per call (hard error).
- Result: `{ restored: [{ compactionId, tier, checkpointSeq, restoredSeqs,
  restoredTokens, restoredChars, preview }], skipped: [...] }`.

### `context_status`
Reports usage (token-meter baseline kind/tokens, total, window, percent),
checkpoints by tier with their shadowed spans, per-tier token totals,
protected seqs, recommended ranges, and the recent surface nodes with
seq/kind/tokens/tier/preview so the model can choose ranges.

### `context_search`
Full-text search through the optional session-query service. `scope:
session` searches the current session; `scope: workspace` searches all
sessions. Hits carry `seq`, `type`, `surface` (`visible` | `shadowed` |
`log-only`), and a snippet. Requires a session-query backend such as
`@deepseek-ai/dsh-session-query-sqlite`.

## 5. Automatic behavior

Registered only when `auto: true` (default):

- `agent/pre-step` (waterfall): pressure evaluation. The first observation
  establishes a transient baseline; afterwards `decideNudge` decides
  `pressure` (over-max, frequency-gated), `tier` (per-tier growth past
  `tiers.growthTokens`, only for tiers below the cap with consumable
  checkpoints), or `iteration` (messages since the last user prompt past
  `nudge.iterationThreshold`, in the over-min band). On a decision, the
  engine appends `context/nudge` + the nudge `user/message`. Always calls
  `next()`.
- `agent/request-error` (waterfall): on `CONTEXT_WINDOW_EXCEEDED`, prunes
  tool results through the optional `toolResultPruner`, selects a range with
  the deterministic fallback, and commits an LLM-summarized compaction
  (author `fallback`), then returns `{ kind: 'retry' }`. Bounded by
  `fallback.maxOverflowRetries`; durable surface progress after a failure
  also counts as retry proof.
- `agent/status` + `session/event` (assistant/message): reset the overflow
  retry counters.

Nudge baseline semantics (folded from the log): a nudge resets its own
cadence; a compression resets the baseline of the tier it *consumed*
(a tier-2 checkpoint resets the tier-1 pile; a tier-1 capture only grows
it). This is what lets distillation accumulate growth across captures.

## 6. Deterministic fallback

`compactIfNeeded('context-overflow')`, `compactNow`, and `compactRegion`
share one path: head-anchored selection (skipping leading protected nodes,
balanced and protected-free), one `ctx.llm.stream()` call whose prefix
reuses the conversation's own system prompt, tools, and leading messages
(KV-cache friendly), then the same durable transaction with author
`fallback`. `compactNow` additionally runs under `agent.runMaintenance`,
writes a standalone bracket (owner `null`), and flushes through
`ctx.sessions.flush`.

## 7. Protection policy

| Rule | Default | Config |
|---|---|---|
| First human user message never compressed | on | `protection.protectFirstUserMessage` |
| Recent tail never included in a range | 20 nodes | `protection.retainRecentMessages` |
| `context_compress`/`context_decompress` calls+results force-protected | on | fixed |
| Tool outputs excluded from ranges | `[]` | `protection.protectedTools` |
| Plugin-sourced injected messages excluded | `[]` | `protection.protectedSources` |
| All human user messages excluded | off | `protection.protectUserMessages` |
| Checkpoints at the tier cap cannot be consumed | tier 3 | `tiers.maxTier` |

## 8. Invariants (the companion row)

The companion registers under `@dsh-asc/compaction-agentic/invariant` and
validates with pre-commit veto:

- every `context/nudge` is immediately followed by the dsh-asc nudge
  `user/message`;
- every `context/decompress` is immediately followed by the matching
  restore `user/message`;
- every `context/compress` matches the enclosing bracket, appears only
  after its `compaction/summary` and before its `compaction/end`, once per
  bracket;
- seeds are validated at mount; an unmatched record at the end of a seed
  refuses the session.

The `compaction/*` bracket structure itself is enforced by the upstream
`@deepseek-ai/dsh-compaction/invariant` companion.

## 9. Configuration reference

See [usage.md](usage.md#configuration) for the full table with defaults.

## 10. Reliability properties

- **Reversible**: every compression is a log replacement; the original
  events remain in the log and `context_decompress` restores them exactly.
- **Searchable**: FTS indexes the full log including shadowed events.
- **Auditable**: model-visible ⟺ logged; every nudge, compression, and
  decompression is a durable event with its own provenance.
- **Crash-safe**: the transaction bracket and the end-seed boundary are the
  upstream mechanisms; a failed commit leaves a detectable unmatched start.
- **No state drift**: block state, tier, and nudge baselines are folds over
  the log; the only transient state is the first-observation baseline and
  overflow retry counters, both restart-safe.
- **Deterministic degradation**: overflow and manual compaction never
  depend on the model's willingness to compress.
