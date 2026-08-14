# dsh-asc — Agentic Surface Compaction for DeepSeek Harness

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
  Ranges that would split a tool call from its result are automatically
  extended to the minimal complete tool turns (configurable via
  `compress.autoExpandToolPairs`), and every recommended range is
  pre-validated so acting on one never hits a commit-time rejection.
  Failures teach the repair: unbalanced spans name the nearest balanced
  range, and quality-gate rejections report the measured metrics.
- **`context_decompress`** — undo a compression: the original content is
  committed back into the surface at the checkpoint's own position
  (tier-aware: one tier up by default, `full: true` to the raw bottom).
- **`context_status`** — usage, checkpoints by tier, per-tier token totals,
  a system/conversation breakdown, protected content (per-node flags),
  pre-validated recommendations, and a preview of the recent surface.
- **`context_recap`** — re-fetch checkpoint summaries without decompressing
  the original content, read from the durable log.
- **`context_search`** — full-text search over the whole session log,
  including shadowed (compressed) content.

Plus a pinned compression-philosophy section in the system prompt (the two
failure modes, the single test, proactive frugality), automatic, logged,
token-priced **nudges** gated on real context growth and a cadence floor
so a session that declined compression goes quiet — and a deterministic
**fallback** that handles provider-confirmed overflow and manual compaction
without the model, announcing each automatic compaction on the surface.

## Quick start

```sh
pnpm install && pnpm test && pnpm build
```

Install into a DSH profile (standard bundle install — pnpm-links the package
and reconciles it into the profile's `dsh.profile.bundles` layer list):

```sh
dsh plugin --profile <name> add ./packages/compaction-agentic   # local checkout
dsh plugin --profile <name> add dsh-asc     # npm (when published)
dsh plugin --profile <name> add github:you/dsh-asc  # git (runs prepare)
```

The bundle patch mounts the backend row. Then disable the basic backend in
the profile's own `cordis.patch.yml` — only one provider owns `ctx.compaction`:

```yaml
- id: compaction-basic
  disabled: true
# optional rows:
- insert:
    - id: compaction-agentic-invariant   # runtime invariant companion
      name: "dsh-asc/invariant"
    - id: session-query-sqlite           # context_search full-text backend
      name: "@deepseek-ai/dsh-session-query-sqlite"
```

See [docs/usage.md](docs/usage.md) for the full configuration reference and
operation notes.

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
