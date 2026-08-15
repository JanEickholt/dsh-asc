# AGENTS.md

dsh-asc is a standalone plugin repository for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It
implements **Agentic Surface Compaction (ASC)**: the model decides when and
what to compact, and every compaction is committed as a durable
session-log replacement on DSH's event-sourced surface.

## Where things live

```
src/           plugin entry + public API surface
  index.ts     plugin entry: registers ctx.compaction + tools
  config.ts    strict config validation
  types.ts     config and result vocabulary
  events.ts    session-event vocabulary documentation (no custom members)
  invariant.ts runtime invariant companion
  engine/      the compaction engine core
    engine.ts  AgenticCompactionEngine (extends CompactionEngine)
    region.ts  the compaction transaction bracket
    tier.ts    checkpoint tier derivation from the log
    quality-gate.ts  model-summary quality gate (L1 floor + L2 recall)
    fallback.ts  LLM summarizer for overflow/manual fallback
    prompt.ts  context-management philosophy prompt
    restore.ts decompression by replaying the log
  policy/      policy and gating
    protected.ts protected-node policy
    nudge.ts   nudge state machine (pure fold + decision)
  tools/       the five model tools
    tools.ts   context_status/compress/decompress/recap/search
  utils/       shared helpers
    text.ts    text serialization and preview helpers
tests/         vitest suites
docs/          analysis, design, usage, e2e-validation
```

## Non-negotiables

- **The session log is the single source of truth.** Any model-visible input
  this plugin produces (nudges, restored content, checkpoints) is appended as
  a session event. Nothing is kept in side files.
- **Never fork DSH internals.** Depend on the published `@deepseek-ai/dsh-*`
  packages and the `ctx.compaction` seam. If a needed contract is missing,
  extend this repo's own modules, not DSH's.
- **Every commit builds and tests green.** `pnpm install && pnpm test &&
  pnpm typecheck && pnpm build` must pass before commit.
- **Registration is an effect.** Every `ctx.on`, `ctx.tools.register`, and
  service contribution returns or yields a disposer; unload must leave no
  trace.
- **Closed unions end in exhaustive switches with a documented default.**
  Merge-extensible unions (SessionEvent, MessageSource) never use
  `assertNever`; handle known cases and fall through.
- **Switch on discriminant tags**, never chained `if`s, so narrowing is
  checked.
- **Model-facing contracts are written from the model's perspective.** Tool
  descriptions, results, and nudge text contain only task-relevant concepts.
  Pin stable model-visible text; test behavior, not implementation.
- **No hardcoded tunables in plugin logic.** Deployment-varying choices are
  validated `Config` fields; protocol constants stay fixed.
- **Misconfiguration fails loud** at load.
- **An empty `catch` names what it swallows** and why nothing else can reach
  it.
- **Tests describe behavior.** Change obsolete behavior with its tests and
  explain why.
- Files end with exactly one trailing newline; `git diff --cached --check`
  must pass.
- **Non-trivial changes include a doc update** in the same commit (README,
  usage, or design as appropriate).

## Conventions

- ESM everywhere; `"type": "module"` in every package.
- Source imports use explicit `.ts` extensions (DSH style); `tsc` rewrites
  them on emit (`rewriteRelativeImportExtensions`).
- `tsconfig.json` holds the shared strict compiler options (dev, `noEmit`);
  `tsconfig.build.json` extends it with `rootDir: src`, `outDir: lib/types`.
- Tests live under `tests/` at package level, not in `src/`.
- Branded cross-boundary ids (compaction ids, session ids) come from the
  owning DSH package; never invent bare-string ids for protocol fields.
- Public API docs live in JSDoc on the declaration; the repo keeps a `docs/`
  design doc in sync with the implemented contract.

## Commands

```sh
pnpm install      # pnpm workspaces, node ^22.19 || >=24
pnpm test         # vitest unit + integration
pnpm typecheck
pnpm build        # tsc emits lib/types
pnpm clean
```
