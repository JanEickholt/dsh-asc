# Analysis: Context Management in DeepSeek Harness vs opencode-acp

> This document was written from a first-hand re-reading of the two codebases
> (DeepSeek Harness @ `packages/` and opencode-acp @ `lib/`), deliberately
> without trusting a prior handoff summary. It records the derived
> conclusions that motivate this repository's design. The companion design
> document is [design.md](design.md).

## 1. DeepSeek Harness: context management as a derived model over an append-only log

### 1.1 The session log is the single source of truth

`Session` (`packages/core/session`) is an append-only log of typed
`SessionEvent`s. Every event is lossless JSON with a monotonic `seq`
(`seq = log.length`), a `time`, and a `type`-discriminated payload.
Message history is **never stored separately**: `deriveMessages()` projects
the model-visible transcript from the log on demand, and replay is
re-derivation from the same events. This is the "model-visible ⟺ logged"
invariant: anything that reaches a model request must be reconstructable
from the log, and the runtime enforces it (a new model-visible input
requires a new session event).

The **surface** is the ordered projection of message-producing events
(`user/message`, `assistant/message`, `tool/result`). Each such event carries
a `surfaceOp`: `'append'` (normal tail growth) or
`{ op: 'replace', start, end }` (shadow a positional span with one new node).
A replacement cites every shadowed node in `sourceEventSeqs`. The surface is
the *only* source of derived history; a compaction `replace` therefore
deletes the shadowed nodes from the derivation while the log retains them
forever. `replaceGeneration` increments per committed replacement so
incremental consumers can distinguish pure tail growth from a rewrite.

The log is durable via a persistence seam (`session/persistence-*`), crash
recovery closes only genuinely open turn/step/tool brackets, and the
`session/end-seed` marker lets a plugin owning an open/close bracket decide
whether an unmatched opening marker belongs to a dead seed lifecycle or a
live one.

### 1.2 The compaction capability seam (`ctx.compaction`)

`@deepseek-ai/dsh-compaction` declares an abstract `CompactionEngine` service
with three operations:

- `compactIfNeeded(agent, trigger, signal)` — automatic policy entry for
  `'pressure'` (step-boundary pressure) and `'context-overflow'`
  (provider-confirmed overflow);
- `compactNow(agent, signal, sourceCommandId)` — explicit idle-session
  compaction serialized through `agent.runMaintenance`;
- `compactRegion(start, end, agent, signal)` — force-compact a positional
  surface span.

The vocabulary is durable **`compaction/*` session events** (log-only, no
surface op): `compaction/start` (the lock, holding a `compactionId`),
`compaction/summary` (the summary, its shadowed range/seqs/token count, the
provider/model that wrote it, raw output, and usage), and `compaction/end`
(release, with `error` on failure). A **model-free prune** variant
(`compaction/prune`) carries the shadow price of a replaced tool-result node
so pure consumers can subtract tokens without per-node state. The actual
replacement is a `user/message` whose source is
`compactCheckpointSource(compactionId)` — a backend-independent marker
(`{ kind: 'plugin', plugin: 'compact' }`) that consumers and UI use to
recognize checkpoints. The shadow-price protocol requires the metering event
and its replacement to be appended synchronously adjacent.

### 1.3 The transaction (`compaction-basic`)

`compactSurfaceRegion` implements the complete bracket:

1. **Validate** the positional span: both edges on the current surface,
   ordered, and **tool-pairing balanced** (no open tool call crosses a cut —
   `toolPairingBalancedBefore/After` folds the surface incrementally);
2. **Lock**: inspect the log tail for an unmatched `compaction/start`
   (bounded by the last `session/end-seed`), append `compaction/start`;
3. **Prepare**: price the span through the token meter, build the
   summarization input by replaying the region's own derived messages;
4. **Summarize**: one `ctx.llm.stream()` call whose envelope reuses the
   conversation's own system prompt and tool schemas and carries the
   shadowed region in surface order, so the provider can reuse the cached
   **prefix** of the last routed request;
5. **Frame + shrink check**: wrap the summary in checkpoint framing and
   require the framed node to be strictly smaller than the shadowed content
   (token-meter priced);
6. **Stability check**: whole-surface (automatic) or selected-span (manual)
   unchanged during the async window;
7. **Commit**: append `compaction/summary`, then the replacement
   `user/message` with `surfaceOp: { op: 'replace', start, end }`, then
   `compaction/end` — synchronously adjacent;
8. **Failure discipline**: every later failure makes exactly one
   `compaction/end` attempt with `error`; a failed close deliberately leaves
   the unmatched start detectable. Manual compaction classifies failures
   (`busy`, `cancelled`, `changed`, `summary`, `commit`, `persistence`).

Selection is head-anchored with a priced recent tail: walk the measurement
backward until the `retainTokens` budget is met, then walk further back to a
balanced cut. Automatic pressure policy (`thresholdRatio`, `retainRatio` of
the resolved model's context window), per-target `modelPolicies`, retry
loops, and overflow recovery (`agent/request-error` +
`CONTEXT_WINDOW_EXCEEDED_CODE` → prune → compact → `{ kind: 'retry' }`) all
live in `compaction-basic`.

### 1.4 The token meter

`ctx.tokenMeter` is a single replay-aware fold over the log: it measures
`{ baseline, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes[] }`,
anchors to provider-reported usage when the latest successful call's
canonical header matches `requestHeader` (and the usage total is not below
the full heuristic anchor), and otherwise heuristically reprices the whole
envelope. Every pricing decision in compaction uses this one singleton, so
pressure, retention, cited sources, and shrink checks cannot disagree.

### 1.5 What DSH gives and what it lacks

Gives: correctness by construction — state is derived, replay is exact,
compaction is transactional, auditable, crash-safe, cache-friendly, and
cheap to operate (deterministic, no side files).

Lacks: **the model has no say**. The automatic backend decides ranges by a
fixed head-anchored policy and writes a single generic summary through a
second LLM call. There is no decompression (the original text stays in the
log but nothing restores it to the visible surface), no tiered distillation,
no search over shadowed content from the model's point of view (the FTS
corpus indexes *all* events — shadowed text is searchable, but no tool
surfaces that), and no nudge guidance. `session-query` provides
`searchEvents`/`searchSessions` with per-event `surface: current | shadowed |
log-only` classification, which is exactly the missing retrieval primitive.

## 2. opencode-acp: context management as model-owned state

### 2.1 The philosophy

ACP hands all context-management authority to the model: four tools —
`compress` (range or message mode, batch entries), `decompress` (block or
range mode, tier-aware), `acp_status` (usage + block coverage + protected
content), `search_context` (search summaries and consumed content). The
model compresses *when* pressure guidance says so and *what* it judges
worthless; a hardcoded 100% GC truncation is the only automatic fallback.
Measured: 97% of requests under 200K tokens, ~91% prompt-cache hit rate,
sessions of 3,300+ messages / 300M+ cumulative tokens.

### 2.2 The block model

A `CompressionBlock` (bN) records the span it covers (`directMessageIds`,
`effectiveMessageIds`), its **nesting** (`consumedBlockIds`,
`parentBlockIds`), a `generation` (young → old), a `tier` (1/2/3), token
accounting, `survivedCount`, `active` flag, and the model-written `summary`.
State is persisted **per session to a side JSON file** keyed by raw message
UUIDs, with a bidirectional raw↔`mNNNNN` ref mapping.

### 2.3 Three-tier LSM distillation and nudges

T1 capture (raw → detailed summary, ~45×) fires on context pressure; T2
distill (T1 summaries → decisions, ~10×) and T3 condense (T2 → facts, ~5×)
fire when their tier's summary tokens grow past `nudgeGrowthTokens`. Tier is
detected from consumed blocks. The nudge brain runs in the message-transform
hook on every LLM call: anchors, growth-since-last-nudge baselines, per-tier
cadence baselines, a compress-detection lock, and over/under-limit bands
decide whether to inject compression guidance as a synthetic suffix message.
A non-blocking pluggable quality gate (length floor + ROUGE-1/keyword
recall, with `acknowledgeRisk` retry) catches catastrophic summary loss.

### 2.4 What ACP gives and what it lacks

Gives: model autonomy, high-fidelity summaries written by the very model
that will later read them, tiered density, reversibility, search over
compressed content, and demonstrated cost control.

Lacks — and this is the whole 39-bug family: **state is separated from
messages**. Blocks, refs, and visibility live in side files keyed by message
UUIDs while OpenCode's own compaction and UI mutate the message stream;
every drift (orphaned blocks, stale refs, reappearing hidden messages,
phantom batches, cache-invalidating in-place rewrites) is a new bug class.
There is no replay, no audit, no crash recovery for the side state, and
compression replaces content in the *request* (mutating existing messages
invalidated the prefix cache — bug 38) rather than in a durable log.

## 3. My comparison (derived, not inherited)

| Dimension | DSH | ACP |
|---|---|---|
| Source of truth | append-only log; state derived | side JSON files; request mutated |
| Correctness | transactional brackets, stability checks, runtime "model-visible ⟺ logged" invariant | correctness by discipline; drift is the bug family |
| Compaction decision | fixed policy + LLM summary | model decides range + writes summary |
| Reversibility | none on the surface (log retains text) | decompress restores blocks |
| Tiering | single-level | 3-tier LSM |
| Search of shadowed content | possible (FTS indexes all events) but unsurfaced | `search_context` tool |
| Cost control | threshold-driven; summarization costs an extra call | model-written summaries; nudges guide; ~91% cache hit |
| Audit/replay | exact | impossible |
| Cache friendliness | auxiliary call reuses conversation prefix | compressions are rare; suffix injection keeps prefix stable |

Both sides are strong where the other is weak. DSH's event-sourced surface
is the correct foundation for *any* context management, but it has no model
autonomy; ACP's model autonomy is the most effective *policy* ever shipped,
but it sits on a fragile foundation.

**The bet: DSH is the next-generation base, and ACP's philosophy is the
layer to build on it.** That is what this repository does.

## 4. The fusion: Agentic Surface Compaction (ASC)

Put the model in charge of *what* to compact and *how* to summarize, and put
every decision on DSH's log:

1. **Compression decision and summary → the model.** A `context_compress`
   tool takes `{startSeq, endSeq, summary}` ranges; the engine validates
   them (balanced edges, protected content, tier caps, shrink check) and
   commits the same durable `compaction/start|summary|end` + `replace`
   bracket. No auxiliary summarization call; the checkpoint is written by
   the model that will later read it.
2. **Block state → derived from the log.** Checkpoints are recognized by
   `isCompactCheckpointSource`; their tier is a fold over the shadow chain
   (T1 = shadows raw nodes, T2 = shadows T1 checkpoints, …). No side files,
   so the entire 39-bug state-drift family is structurally impossible.
3. **Decompression → replay in place.** `context_decompress` reconstructs the
   shadowed transcript from the log (tier-aware: one level up by default,
   `full: true` to the raw bottom) and replaces the checkpoint node with a
   durable `user/message` carrying that transcript. No side-state store; the
   original events stay shadowed in the log.
4. **Nudges → logged, precisely priced.** The nudge state machine folds the
   token meter with transient per-session baselines; the nudge itself is an
   appended `user/message`, so "model-visible ⟺ logged" holds and its cost
   is measurable.
5. **Search → the full log.** `context_search` runs session-query FTS over
   the whole log, including `shadowed` events, and reports each hit's
   surface status (session-scope shadowed hits also name their checkpoint).
6. **Degradation → the deterministic backend.** If overflow recovery needs
   automatic action (or manual compaction is requested), the engine falls
   back to deterministic selection + LLM summarization, exactly like
   `compaction-basic`.
7. **Quality gate → before commit.** The model's summary is gated (length
   floor + keyword recall); blocking failures require `acknowledgeRisk`
   retry, so catastrophic loss is prevented without removing autonomy.

Net increment over either side alone: **reversible + searchable + auditable
at the same time**, with model-owned density and deterministic safety nets.
