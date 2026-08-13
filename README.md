# dsh-compaction-agentic — Agentic Surface Compaction for DeepSeek Harness

[English](./README.md) | [中文](./README.zh.md)

The model decides **when** and **what** to compact — committed as durable
session-log replacements on DeepSeek Harness's event-sourced surface.

This is the "model-owned compression" philosophy proven by
[opencode-acp](https://github.com/ranxianglei/opencode-acp), rebuilt on the
foundation that makes it reliable: an append-only session log where every
decision is a replayable event, every block is a derived view, and nothing
is ever lost.

## Why

| | Classic compaction (basic backend) | ACP-style model autonomy | This package |
|---|---|---|---|
| Who decides what to compress | fixed policy | the model | the model |
| Who writes the summary | a second LLM call | the model | the model |
| Reversible (decompress) | no | yes (side state) | yes (log replay) |
| Searchable after compression | no | yes (side state) | yes (full-log FTS) |
| Auditable / replayable | yes | no | yes |
| State drifts from messages | n/a | the 39-bug family | structurally impossible |
| Overflow safety net | yes | hardcoded GC | deterministic fallback |

**The fusion:** compression decisions to the model, compression
representation on the log. Decompression replays shadowed events (zero
stored state), block tiers derive from the shadow chain (no side files),
nudges are logged and exactly priced by the token meter, search covers the
full log including compressed originals, and overflow recovery falls back
to deterministic selection plus cache-friendly LLM summarization.

## The four tools

- **`context_compress`** — replace surface ranges with model-written
  checkpoints, one durable `compaction/*` transaction per range, with
  balanced tool-pairing, protection, shrink, and quality-gate validation.
- **`context_decompress`** — restore compressed content by replaying the
  log (tier-aware: one tier up by default, `full: true` to the raw bottom).
- **`context_status`** — usage, checkpoints by tier, per-tier token totals,
  protected content, recommendations, and a preview of the recent surface.
- **`context_search`** — full-text search over the whole session log,
  including shadowed (compressed) content.

Plus automatic, logged, token-priced **nudges** that tell the model when
context is high and what to consider compressing — and a deterministic
**fallback** that handles provider-confirmed overflow and manual compaction
without the model.

## Quick start

```sh
pnpm install && pnpm test && pnpm build
```

Mount in a DSH composition:

```yaml
- name: "@dsh-asc/compaction-agentic"
  config:
    auto: true
- name: "@dsh-asc/compaction-agentic/invariant"   # optional, recommended
- name: "@deepseek-ai/dsh-session-query-sqlite"   # optional: context_search
```

Remove or disable the `@deepseek-ai/dsh-compaction-basic` row — only one
provider owns `ctx.compaction`. See [docs/usage.md](docs/usage.md) for the
full configuration reference and operation notes.

## Documentation

- [docs/analysis.md](docs/analysis.md) — first-hand architecture analysis of
  DeepSeek Harness vs opencode-acp context management, and the derivation
  of this design.
- [docs/design.md](docs/design.md) — the implemented contract: events,
  tools, automatic behavior, fallback, protection, invariants.
- [docs/usage.md](docs/usage.md) — installation, mounting, configuration,
  model experience, operations.

## Development

```sh
pnpm install
pnpm test          # vitest: 98 unit + integration tests
pnpm typecheck
pnpm build         # tsc emits lib/types
```

The repository follows DSH conventions: ESM, strict TypeScript, `.ts`
import specifiers, registrations as reversible effects, model-visible ⟺
logged, closed-union switches with documented defaults, and an invariant
companion per package.

## License

MIT. This project adapts algorithms from
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT)
and takes only *ideas* from
[opencode-acp](https://github.com/ranxianglei/opencode-acp) (AGPL) — no
source code. See [NOTICE](NOTICE).
