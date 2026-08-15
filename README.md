# dsh-asc

[![GitHub tag](https://img.shields.io/github/v/tag/lmst2/dsh-asc)](https://github.com/lmst2/dsh-asc/releases)
[![license](https://img.shields.io/github/license/lmst2/dsh-asc.svg)](LICENSE)

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

**From GitHub** (the current distribution channel):

```sh
dsh plugin --profile <name> add github:lmst2/dsh-asc
```

`dsh plugin` adds the plugin to the profile and enables it automatically
based on the `dsh.bundle` declaration in the package; the tools and the
system prompt load together with that profile.

> **Restart required**: after installing, restart the running DeepSeek
> Harness service.

### Other install options

**From npm** — once the package is published to the npm registry:

```sh
dsh plugin --profile <name> add dsh-asc
```

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
- injects **nudge prompts** on demand when context usage runs high (gated by
  real growth and cadence — no per-turn nagging);
- provides **deterministic degradation** (tool-result pruning + LLM
  summarization) on overflow or manual compaction, without requiring model
  cooperation.

The plugin provides five model tools:

| Tool | Purpose |
|---|---|
| `context_status` | context usage, tiered checkpoints, system/dialogue composition, recommended ranges, recent surface nodes |
| `context_compress` | replace a surface range with a checkpoint you write (batching supported; tool-call pairs auto-extended; quality gate) |
| `context_decompress` | undo a compaction: the original text returns to the surface at the checkpoint's own position (tier-aware; `full: true` reaches raw content) |
| `context_recap` | re-read checkpoint summaries without decompressing the originals |
| `context_search` | full-text search over the whole log (including compacted content) |

Compacted content is never lost: the originals stay in the session log and
can be decompressed or searched at any time.

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
  index.ts      plugin entry: registers ctx.compaction + the five tools
  config.ts     strict config validation
  types.ts      shared config and result types
  events.ts     session-event vocabulary documentation (no custom members)
  invariant.ts  runtime invariant companion (subpath export)
  engine/       the compaction engine core (engine, region, tier,
                quality gate, fallback, prompt, restore)
  policy/       protected-node policy and the nudge state machine
  tools/        the five model tools
  utils/        shared text helpers
tests/          vitest suites
docs/           usage, design, analysis, e2e-validation
```

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
(AGPL) are used, no source code. See [NOTICE](NOTICE).
