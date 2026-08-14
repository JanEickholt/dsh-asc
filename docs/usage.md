# Usage

Install the package into the environment that runs DeepSeek Harness, then
mount it in the composition instead of (or alongside — see below) the basic
compaction backend.

## Installation

```sh
# inside the deployment that runs dsh (where dsh's node_modules live)
npm install dsh-asc
# or with pnpm
pnpm add dsh-asc
```

> The package is published to npm as `dsh-asc`. Until
> the first publish, build from source and link it:
> `pnpm install && pnpm build` in this repository, then reference the
> package path in your composition.

## Mounting

The package is a function plugin on the standard `ctx.compaction` seam.
Mount it in a profile patch (`cordis.patch.yml`), a profile bundle, or a
preset composition. DSH patches either insert rows or replace a row's whole
config by id:

```yaml
# cordis.patch.yml — insert the agentic backend
- insert:
    - id: compaction-agentic
      name: "dsh-asc"
      config:
        auto: true
```

Then remove or disable the basic backend row, because only one provider can
own `ctx.compaction`:

```yaml
# target the base bundle's compaction-basic row by id
- id: compaction-basic
  disabled: true
```

Verify the composed tree with:

```sh
dsh --profile web --dump-config | grep -A 20 compaction
```

### Optional: the invariant companion

```yaml
- insert:
    - id: compaction-agentic-invariant
      name: "dsh-asc/invariant"
```

It requires the `@deepseek-ai/dsh-invariants` service (shipped in the base
bundle). It vetoes log writes that violate the adjacency and bracket
relations of the `context/*` events.

### Optional: full-text search

`context_search` needs a session-query backend:

```yaml
- insert:
    - id: session-query-sqlite
      name: "@deepseek-ai/dsh-session-query-sqlite"
```

Without it, `context_search` fails with a clear message; the other three
tools work normally.

### Optional: model-free tool-result pruning

Mount the upstream pruner to make overflow recovery first prune oversized
tool results before summarizing:

```yaml
- insert:
    - id: tool-result-pruner
      name: "@deepseek-ai/dsh-compaction-tool-result-pruner"
      config:
        thresholdChars: 20000
```

## Configuration

All fields are optional; every unknown key fails plugin load.

### Top level

| Key | Default | Meaning |
|---|---|---|
| `auto` | `true` | Register automatic nudge injection and overflow recovery. |
| `thresholdRatio` | `0.8` | Context fraction at which pressure is considered high (used by fallback selection and recommendations). |
| `retainRatio` | `0.16` | Recent-tail budget as a fraction of the context window (fallback selection). |
| `retainTokens` | — | Absolute recent-tail budget; mutually exclusive with `retainRatio`. |
| `modelPolicies` | `[]` | Per `{provider, model}` overrides of the three fields above; duplicate targets fail load. |

### `compress`

| Key | Default | Meaning |
|---|---|---|
| `autoExpandToolPairs` | `true` | Extend a compress request that would split a tool-call/result pair to the minimal complete tool turns instead of rejecting it. The extension is reported in the result (`expandedFrom`). Disable to reject unbalanced ranges (the failure names the nearest balanced span). |

### `nudge`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch for automatic nudge injection. |
| `minRatio` | `0.45` | Below this fraction of the window, no nudges fire. |
| `maxRatio` | `0.8` | Above this fraction, strong nudges fire every `frequency` steps. |
| `growthTokens` | `50000` | Token growth since the last baseline required to nudge again. Applies to iteration nudges (and tiers have their own); without real growth a session the model chose not to compress stays quiet. |
| `frequency` | `5` | Step interval for pressure and iteration nudges. |
| `iterationThreshold` | `15` | Nudge after this many messages since the last user prompt (in the over-min band, past the growth floor and frequency gate). |
| `force` | `"soft"` | Nudge wording intensity: `"soft"` or `"strong"`. |

### `tiers`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Enable tier-distillation nudges. |
| `maxTier` | `3` | Deepest checkpoint tier (1–5). Checkpoints at this tier cannot be consumed. |
| `growthTokens` | `10000` | Per-tier summary-token growth that triggers the next-tier nudge. 10K fits real sessions; 50K made distillation nudges unreachable. |

### `qualityGate`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Evaluate model-written summaries after validation. |
| `blocking` | `true` | Reject the plan on failure until the exact range set is retried with `acknowledgeRisk`. |
| `layer1MinChars` | `200` | L1: minimum summary length in characters. |
| `layer1MinRetentionPct` | `1.0` | L1: minimum summary tokens as a percent of shadowed tokens. |
| `layer2MaxRougeF1` | `0.05` | L2: fail when ROUGE-1 F1 is below this (AND with keyword recall). |
| `layer2MaxTop20Recall` | `0.20` | L2: fail when top-20 keyword recall is below this (AND with ROUGE-1 F1). |

### `fallback`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Allow deterministic LLM summarization for overflow recovery and manual compaction. |
| `summarizationProvider` / `summarizationModel` | `""` | Summary route; empty inherits the conversation target. Must be set together. |
| `maxTokens` | `8192` | Generation cap for fallback summaries. |
| `maxOverflowRetries` | `1` | Overflow-recovery retries after prune + compaction. |

### `protection`

| Key | Default | Meaning |
|---|---|---|
| `protectUserMessages` | `false` | Protect every human user message from compression. |
| `protectFirstUserMessage` | `true` | Always protect the first human prompt. |
| `retainRecentMessages` | `20` | Protect the last N surface nodes from inclusion in a range. |
| `protectedTools` | `[]` | Tool names whose calls and results are excluded from ranges (`context_compress` and `context_decompress` are always protected). |
| `protectedSources` | `[]` | Plugin names whose injected `user/message` nodes are excluded. |

### `decompress`

| Key | Default | Meaning |
|---|---|---|
| `maxTokens` | `60000` | Combined restored-token budget per call; over-budget targets are skipped and reported. |
| `maxBlocks` | `8` | Maximum checkpoints restored per call; exceeding it is a hard error. |

`context_decompress` restores in place: the restored transcript is
committed back into the surface at the checkpoint's own position (the
checkpoint node is shadowed by a `user/message` carrying the original
content), so the compression is undone and the original content appears
where it used to be. The tool result reports statistics and a preview
only; large restores are governed by the `maxTokens` budget instead.

## Model experience

The plugin injects a pinned compression-philosophy section into the system
prompt (`tool:compaction-agentic`, order 114): the two failure modes, the
single test ("is this content still needed by the current task step?"),
proactive frugality, reversibility, and the four-tool workflow. The model
therefore compresses proactively instead of waiting for nudges or overflow.

The tools are self-describing: `context_status` lists the current surface
with seqs, kinds, tiers, protection flags, and previews (and every
recommended range is pre-validated, so acting on one never hits a
commit-time rejection); `context_compress` takes exactly those seqs and
auto-extends tool-pair-splitting ranges; `context_decompress` takes the
`compactionId`s that `context_status` reports.
Recommended ranges appear both in `context_status` and in nudges. The nudge
text is pinned and test-asserted; it always tells the model that context
management is optional and that content is never lost (it can be searched
with `context_search` and restored with
`context_decompress`).

## Operation notes

- **Only one compaction provider.** Mount either the basic backend or this
  one, not both.
- **Subagents** inherit the host composition: the tools and listeners apply
  to every agent, including delegated ones. There is no separate switch;
  scope per-agent via presets if needed.
- **Log growth.** Compressions, nudges, and restores are durable events.
  The log is append-only by design; compressing keeps the *model-visible*
  surface bounded while the log grows. Persistence backends that prune the
  log (none shipped) would break replay-based restore.
- **Restarts.** Nudge cadence and tier baselines are transient in-memory
  state: a fresh process re-establishes the baseline before nudging again,
  so a restart can never double-fire. Checkpoints and tiers derive from the
  log and survive restarts.
- **Disabling.** Set `auto: false` to stop nudges and overflow recovery
  while keeping the tools; remove the row to disable everything.
