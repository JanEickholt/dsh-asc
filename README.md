# dsh-asc

[![npm](https://img.shields.io/npm/v/@internetnutzer/dsh-asc.svg)](https://www.npmjs.com/package/@internetnutzer/dsh-asc)
[![GitHub tag](https://img.shields.io/github/v/tag/JanEickholt/dsh-asc)](https://github.com/JanEickholt/dsh-asc/releases)
[![license](https://img.shields.io/github/license/JanEickholt/dsh-asc.svg)](LICENSE)

[English](./README.md) | [中文](./README.zh.md)

**dsh-asc** (full name **DeepSeek Harness Agentic Surface Compaction**) is a
context-compaction plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): **the
model itself decides when and what to compact**, and every compaction decision
is committed as a durable session-log replacement event
(`surfaceOp: replace`) — replayable, searchable, and reversible.

Inspired by the model-driven compaction philosophy of
[opencode-acp](https://github.com/ranxianglei/opencode-acp), but built on
DSH's event-sourced log: compaction creates no side-state files,
decompression is log replay, and search covers the full log including
compacted originals.

## Install

**Prerequisites**: a working [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
installation (`dsh` CLI available); Node.js `^22.19` or `>=24`.

**Harness compatibility**: the built plugin targets core `@deepseek-ai/dsh-*`
`0.2.0-rc.1` or newer (`>=0.2.0-rc.1 <0.3.0`); its `peerDependencies` also
admit `^0.1.5-rc.2` so an older host still resolves the install. `0.1.0-rc.6`
cores need the `0.2.0` release and `0.1.2-rc.1` cores the `0.2.1` release;
core changed the `Session` API between the generations (0.1.5 additionally
made the system prompt a surface-eligible `system/message` event and renamed
the replace `surfaceOp` bounds to `startSeq`/`endSeq`), and the plugin fails
at runtime when the core is newer than the release supports.

**From npm** (recommended):

```sh
dsh plugin --profile <name> add @internetnutzer/dsh-asc
```

**From GitHub** — to use a commit newer than the npm release:

```sh
dsh plugin --profile <name> add github:JanEickholt/dsh-asc
```

`dsh plugin` adds the plugin to the profile and enables it automatically
based on the `dsh.bundle` declaration in the package; the tools and the
system prompt load together with that profile.

> **Restart required**: after installing, restart the running DeepSeek
> Harness service.

### Other install options

**From source** — to modify the plugin itself, or to contribute:

```sh
git clone https://github.com/lmst2/dsh-asc.git
cd dsh-asc
pnpm install
pnpm build
dsh plugin --profile <name> add "link:$(pwd)"
```

### Disabling the basic backend

`ctx.compaction` allows only one provider at a time. Disable the default
basic backend in your profile's own `cordis.patch.yml`:

```yaml
- id: compaction-basic
  disabled: true
```

Optionally mount the invariant companion and the full-text-search backend:

```yaml
- insert:
    - id: dsh-asc-invariant          # runtime invariant checks (optional, recommended)
      name: "dsh-asc/invariant"
    - id: session-query-sqlite       # context_search full-text backend (optional)
      name: "@deepseek-ai/dsh-session-query-sqlite"
```

## Usage

After installing and restarting, no configuration is required — the plugin:

- injects the **context-management discipline** into the system prompt
  (judgment rules, tool usage, tiered compaction cadence), so the model
  actively manages context from the very first turn;
- injects **nudge prompts** on demand when context usage runs high (cadence-gated; iteration nudges additionally require real token growth — no per-turn nagging);
- provides **deterministic degradation** (LLM summarization, plus tool-result
  pruning when the optional upstream pruner is mounted) on overflow or
  manual compaction, without requiring model cooperation.

The plugin provides six model tools:

| Tool | Purpose |
|---|---|
| `context_status` | context usage, tiered checkpoints, system/dialogue composition, recommended ranges, recent surface nodes |
| `context_compress` | replace a surface range with a checkpoint you write (batching supported; tool-call pairs auto-extended; quality gate) |
| `context_decompress` | undo a compaction: the original text returns to the surface at the checkpoint's own position (tier-aware; `full: true` reaches raw content) |
| `context_recap` | re-read checkpoint summaries without decompressing the originals |
| `context_search` | full-text search over the whole log (including compacted content) |
| `context_retrieve` | return a projected tool-result original byte-exact by its 24-hex sha-256 hash or seq |

Compacted content is never lost: the originals stay in the session log and
can be decompressed or searched at any time.

### Reversible tool-result projection

Separately from model-driven compaction, an optional projection service
compresses oversized tool results BEFORE they enter the context. It listens
on the `tools/post-execute` waterfall, measures every candidate's text
blocks with the real token meter, and returns every decision unchanged so
the original event still lands in the log first. A reversible commit then
shadows the original and appends a replacement whose content embeds a
retrieval marker:

```
[dsh-asc projection: structured:json compressed 4200→312 tokens. Full
original (seq 57, stored in this session log): context_retrieve(hash="…").]
```

- The original stays byte-exact in the session log (single source of truth;
  no side store), so it survives restarts; a marker is emitted only when the
  original is durably stored — a marker never dangles.
- Reducers are content-aware: structured explorers for
  JSON/YAML/XML/delimited/code, git-diff hunk compaction, search-result
  clipping, CLI rule reduction, and a meter-priced head/tail slice as the
  last fallback. `context_retrieve` returns the stored original byte-exact
  by hash or seq; unknown keys get a diagnostic, never fabricated content.
- The projection mounts as its own cordis service row, independent of
  `ctx.compaction` — disabling it never disables compaction, and the
  overflow-triggered tool-result pruner stays mounted as the fallback.
- Config: `projection.enabled` (default `true`),
  `projection.thresholdTokens` (default `1000`).

The system prompt ties the tools into one operating loop: capture consumed
raw work into tier-1 checkpoints, distill settled tier-1 piles into tier-2
decisions and tier-2 piles into a tier-3 fact index. Every checkpoint text
carries its topic and Compaction id, so when a visible summary already
points at the needed detail the model decompresses that block directly;
`context_search` is used only when no visible summary says where a detail
lives, and decompression always proceeds one tier at a time.

## How it works

- **Event sourcing**: a compaction is a transaction in the log
  (`compaction/start` → `compaction/summary` → replaced `user/message` →
  `compaction/end`); no side state.
- **Tiered compaction**: checkpoints have tiers (T1 full detail → T2
  distilled decisions → T3 bare facts); summaries get thinner as they are
  reused.
- **Reversible**: decompression replays the events shadowed in the log and
  commits one in-place replacement event; no side state is needed.
- **Auditable**: who compacted what, the full summary text, and the token
  cost are all in the log.

## Repository layout

```
src/
  index.ts      plugin entry: registers ctx.compaction + the six tools
  config.ts     strict config validation
  types.ts      shared config and result types
  events.ts     session-event vocabulary documentation (no custom members)
  invariant.ts  runtime invariant companion (subpath export)
  engine/       the compaction engine core (engine, region, tier,
                quality gate, fallback, prompt, restore)
  policy/       protected-node policy and the nudge state machine
  tools/        the six model tools
  projection/   reversible tool-result projection service + reducers
  analytics/    session-log usage scanner, regret signals, asc-stats command
  utils/        shared text helpers
tests/          vitest suites
scripts/        corpus-stats and bili-cache-join measurement scripts
docs/           usage, design, analysis, e2e-validation, cache-join
```

## Using dsh-asc alongside the official tool-result pruner

dsh-asc aims at post-execute, **reversible** tool-result compression: every
projection keeps a `context_retrieve` lookup so the full original can be
restored at any time. The official
[`@deepseek-ai/dsh-compaction-tool-result-pruner`](https://github.com/deepseek-ai/deepseek-harness)
(the tool-pruning patch shipped by the dsh-compaction bundle) complements this
as a last-resort overflow guard: when a request still overflows the context
window, it truncates oversized tool results to head + tail so the turn
survives.

We recommend installing both:

- **dsh-asc projection** — primary path: reversible post-execute management.
- **tool-result pruner** — overflow insurance: caps results at head 4096 +
  tail 1024 characters, but only after a request actually fails on overflow.

Caveat: pruner truncation is irreversible and fires only on overflow —
nothing intervenes between a tool's execution and the failed request, so
oversized results sit at full length mid-turn. Rely on projection first; the
pruner is the safety net, not the standard path.

The two compose cleanly: `pruneSession()` is idempotent and projection keeps
its own retrieval index, so either can run first.

## Measured in production

The numbers below come from real sessions on the maintainer's machine — every
one is reproducible by running [scripts/corpus-stats.mjs](scripts/corpus-stats.mjs)
against your own DSH session logs (usage: `node scripts/corpus-stats.mjs
[~/.dsh/sessions]`). Session logs are durable, so nothing here is estimated or
simulated: folds, shadowed-token counts, and per-request cache usage are all
committed events.

Corpus scanned 2026-10-08 — 240 sessions with folds, at least one
`context_*` tool call each (engine attribution: only sessions where dsh-asc's
tools were registered count; sessions from the compaction-engine swap
experiment are excluded by that fingerprint):

| Metric | Value |
|---|---|
| Sessions with folds | 240 |
| Folds (compaction transactions) | 721 |
| Tokens shadowed by folds | 51.9M |
| Model-authored summaries | 721 (fallback: 10) |
| Failed folds | 16 (2.2%) |
| Median fold size | 60.5K tokens |
| Prompt-cache hit rate across all metered requests | 94.8% |
| Median first-request-after-fold cache miss | 27.6K tokens |
| `context_decompress` after a fold | 9 calls — 0.7% of folds |
| `context_recap` | 12 calls |
| `context_retrieve` (projection lookups) | 1,188 calls |
| `context_search` | 38 calls |

The story the table tells: across ~721 folds covering ~52M tokens of
compacted history, the model asked for originals back **9 times**. Summaries
plus tiered checkpoints carried the work; when detail was genuinely needed,
`context_retrieve` restored it reversibly (1,188 lookups without a single
irreversible loss). The 94.8% cache hit rate — measured across all
78,927 metered LLM requests in those sessions, including the re-pay spikes
every fold causes — shows compaction coexisting with prompt caching at a
healthy level rather than destroying it.

### How a fold plays out

```mermaid
flowchart TD
    A[Model calls context_compress] --> B[compaction/start]
    B --> C[Quality gate: summary must pass L1 floor + L2 recall]
    C -->|pass| D[compaction/summary: shadowedRange + tiered summary committed]
    C -->|fail| G[ fold rejected — original stays ]
    D --> E[user/message replace event: surface switches to the summary]
    E --> F[compaction/end]
    F --> H{Model needs detail later?}
    H -->|usually not| I[Work continues on the summary]
    H -->|9 of 721 folds| J[context_decompress / context_retrieve]
    J --> K[Log replay restores byte-exact originals]
    K --> L[One in-place replace event — still no side state]

    style C fill:#f9f
    style J fill:#ff9
```

Two properties visible in this flow that no wire-level compressor can offer:
the quality gate (a fold that fails the floor/recall check never destroys
history — it is rejected) and reversibility (decompression is log replay, not
a cache of originals; the log is the only source of truth).

### Cost of compaction, honestly

Each fold rewrites the message list, so the next request re-pays the prompt
cache: the median first-request-after-fold miss is 27.6K tokens (vs a 60.5K
median fold). Folds are one-time costs paid for by the per-turn savings of a
smaller surface — the [cache-join script](docs/cache-join.md) measures
exactly this trade against a wire proxy's ledger, per fold, with PAID BACK /
NOT PAID BACK verdicts.

Numbers, not adjectives: the corpus-stats and cache-join scripts exist so the
"does compaction pay?" question gets answered from your own logs.

## Documentation

| Doc | Contents |
|---|---|
| [docs/usage.md](docs/usage.md) | install, configuration, model experience, operations |
| [docs/design.md](docs/design.md) | implemented contract: events, tools, automatic behavior, protection, invariants |
| [docs/analysis.md](docs/analysis.md) | comparison of DSH and opencode-acp context management |

## License

MIT. Algorithmic inspiration from
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT);
only the ideas of [opencode-acp](https://github.com/ranxianglei/opencode-acp)
(AGPL) are used, no source code. The tool-result projection is adapted from
the MIT-licensed flowctx-dsh port of flowctx. See [NOTICE](NOTICE).
