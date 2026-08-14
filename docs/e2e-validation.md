# End-to-End Validation on a Real Deployment

> This is the evidence record of running the plugin inside a real DeepSeek
> Harness deployment (headless profile `asc-test`, real `DEEPSEEK_API_KEY`,
> default model deepseek-v4-flash, 1M context window) on 2026-08-14. The
> report body below was produced by the harness itself during the final
> validation run; the section above it summarizes what the four runs
> established and the defects they surfaced.

## Summary of the validation campaign

Four consecutive headless runs exercised compress / decompress /
context_status / context_search / error paths end to end:

| Run | Outcome | Defect surfaced |
|---|---|---|
| 1 | compress + decompress round-trip works (38k→18.8k tokens; 48,843 chars restored verbatim) | an interleaved restore user message violated the provider's tool-call pairing contract (`INVALID_REQUEST`) |
| 2 | same round-trip works | custom `context/nudge` events made persistence/FTS refuse the whole log (no `ignorable` writing surface in this release) |
| 3 | round-trip works; search no longer crashes | `context_status`/`context_search` rendered the ARGUMENTS instead of the result (`render(args, value)` arity bug) |
| 4 | **all six capabilities pass together** | — |

Fixes shipped as a result: decompression no longer interleaves a surface
event between a tool call and its result (Run 1); the backend declares no
custom session-event types (all durable facts ride upstream known types;
nudge baselines are transient and restart-safe); renderers take both
`(args, value)`.

**Superseded after the campaign** (commit `fc152bd`, in-place restore
semantics): `context_decompress` now commits the restored transcript back
into the surface at the checkpoint's own position — an in-place replace
that shadows the checkpoint node — instead of returning it in the tool
result. The Run 4 observation "restore is a replay, not an un-shadow" no
longer describes the shipped behavior: the compression is undone and the
checkpoint record is consumed. The two remaining Run 4 recommendations
have since been closed: tier-2 distillation produced a live tier-2
checkpoint (`fbf2c4cf-4c5b-4bb7-936f-dfacffaa68d9`, 98 nodes / 47,154
tokens to a 138-token summary), and decompress semantics are now the
documented in-place contract in [design.md](design.md).

---# E2E Test Report —Agentic Context-Compaction Plugin

- **Date**: 2026-08-14 (this file now covers **four executions** of the canonical E2E sequence)
- **Run 4 driver**: session `session-2a2d1144-be77-4cb9-893b-9361c44077cf` (workspace `E:\WorkSpace`, DSH file policy `workspace-write`, approval `ask`; context window 1,000,000 tokens, usage 2% at start)
- **Input (all runs)**: the triggering message contained **no step list** —only a runtime-context snapshot. The canonical E2E sequence was executed instead: baseline →compress →verify checkpoint →search shadowed content →decompress →verify restore, plus error-path probes.
- **Plugin under test**: dsh-asc (ASC —Agentic Surface Compaction), repo at `E:\WorkSpace\dsh-asc` (7 commits, 103 unit tests green per HANDOFF.md).
- **Run history**: Run 1 = session `68001db5-4550-4190-b16d-1ffe72c50a1f` (≥1.8× ratio; `context/nudge` unknown-event error at seq 2047 blocked `context_search`). Run 2 = session `1d47d797-8948-4eb4-892d-1fc36f8d28de` (≥.0× ratio; same nudge error at seq 466). Run 3 = session `a207d246-7fdf-49c5-a701-1740860b6957` (≥.35× ratio; `context_status` `{}`, search silent zero-hit). **Run 4 = this execution** (see below; first fully green run).

---

## Run 4 —step log (exact outputs)

| # | Step | Tool / Input | Result |
|---|------|--------------|--------|
| 1 | Baseline status | `context_status` | **STRUCTURED RESULT —first time in 4 runs**: `{"sessionId": "session-2a2d1144-be77-4cb9-893b-9361c44077cf", "usage": {"totalTokens": 20723, "surfaceTokens": 8448, "contextWindow": 1000000, "surfaceNodes": 12}, "checkpoints": [], "protectedSeqs": [7], "recommendations": [seqs 8..188 history 2,831 tok; seq 188 tool-result 2,287 tok; seq 402 tool-result 835 tok], "recentNodes": [12 nodes with seq/kind/tokens/tier/preview]}`. Harness notice also arrived. |
| 2 | Baseline search | `context_search "jiachen_project.tar"` | **HITS —first time in 4 runs**: 4 hits with `seq`/`type`/`surface`/`snippet`: seq 534 `tool/result` current (e2e report content), seq 186 `tool/result` current (workspace listing, `jiachen_project.tar 151562291200`), seq 1785 `tool/call` log-only, seq 1784 `assistant/message` current. |
| 3 | Error path: out-of-surface range | `context_compress` seqs [100000, 100001] | **ERROR**: `entry 0 failed: start seq 100000 is not on the current surface` —clean rejection, exact message, no surface mutation (matches runs 1—). |
| 4 | **Compress** | `context_compress` seqs 8..534 (9 nodes, ~7,417 tokens) | **PASS**: `compressed seqs 8..534 (9 nodes, ~7417 tokens) into checkpoint d7a3b741-d088-4969-8a6c-432d8707e85f (tier 1, ~2382 summary tokens)` —≥.1× reduction. |
| 5 | Verify checkpoint | `context_status` | **STRUCTURED**: `"checkpoints": [{"compactionId": "d7a3b741-—, "seq": 5646, "tier": 1, "shadowedSeqs": [8,184,186,188,400,402,404,532,534], "shadowedTokenCount": 7417, "summaryChars": 9460, "author": "model"}]`, `"tierTokens": {"1": 2382}`, `protectedSeqs` grew to [7, 2147, 2149, 5642, 5648], `"lastCompression"` present. Totals 20,723 →19,494. |
| 6 | Search shadowed content | `context_search "jiachen_project.tar"` | **HITS OVER SHADOWED ORIGINALS —reaction 鈶?validated for the first time**: 11 hits incl. seq 534 and seq 186 both tagged `"surface": "shadowed"` (FTS over compressed originals works live). |
| 7 | **Decompress (restore)** | `context_decompress ["d7a3b741-d088-4969-8a6c-432d8707e85f"]` | **PASS**: `restored checkpoint d7a3b741-d088-4969-8a6c-432d8707e85f (tier 1): 9 events, ~7417 tokens, 29781 chars` —raw events replayed verbatim: runtime snapshot, workspace listing, glob result (114,096 paths), HANDOFF.md full text, reports/repos listings, and `e2e-compaction-test.md` in full (105 lines). |
| 8 | Verify restore | `context_search "jiachen_project.tar"` | **PASS**: 16 hits; restored content back on the surface (seq 6676 `tool/result` `current` = replay containing the workspace listing). Observable semantics: the checkpoint record **persists** in `context_status` after restore and the original seqs remain `shadowed` —restore is a replay, not an un-shadow. |
| 9 | Error path: unknown id | `context_decompress ["00000000-0000-0000-0000-000000000000"]` | `skipped: 00000000-0000-0000-0000-000000000000` —graceful no-op, no crash (matches runs 1—). |

## Run 4 —Pass / Fail summary

| Capability | Verdict | Evidence |
|---|---|---|
| Compress (checkpoint creation) | 鉁?PASS | tier-1 checkpoint `d7a3b741-...`, 9 nodes / 7,417 tokens →2,382-token summary (≥.1×) |
| Decompress (log replay, zero storage) | 鉁?PASS | 9 events restored, 29,781 chars, content verified verbatim in replay output |
| Invalid-range rejection | 鉁?PASS | exact error, no surface mutation |
| Unknown-id handling | 鉁?PASS | graceful skip |
| context_status surface report | 鉁?**PASS (fixed)** | structured result on every call —usage, checkpoints (shadowedSeqs / tier / summaryChars / author), tierTokens, protectedSeqs, recommendations, recentNodes, lastCompression. Run 3 recommendation #2 addressed. |
| context_search (FTS incl. shadowed originals) | 鉁?**PASS (fixed)** | hits with seq/type/surface/snippet for current, log-only **and shadowed** content; FTS-over-shadowed originals (ASC reaction 鈶? validated live. Run 3 recommendation #1 addressed. |

## Run 4 —Key findings

1. **First fully green run —all six capabilities PASS together.** Both Run 3 blockers are resolved in this session: `context_status` returns structured data on every call, and `context_search` returns real hits (current / log-only / shadowed). Nothing regressed on the error paths.
2. **FTS-over-shadowed originals is now proven live** (reaction 鈶?: immediately after compressing seqs 8..534, `context_search "jiachen_project.tar"` returned seqs 534 and 186 tagged `"surface": "shadowed"` —the searchable-compressed-originals property holds, not just designed. This was the top blocker across runs 1—.
3. **Decompress semantics observable**: restore replays the log into the surface (9 events, 29,781 chars). Afterwards the checkpoint record persists in `context_status` and the original seqs stay `shadowed`; search returns both the shadowed original and the replayed copy (`current`). Reversibility = replay, not mutation of the original log events.
4. **Checkpoint metadata is now first-class**: `shadowedSeqs` list, `shadowedTokenCount` (7,417), `summaryChars` (9,460), `author: "model"`, checkpoint event seq 5646 —the auditability story (DSH-side) is observable end-to-end.
5. Compression ratio this run: 7,417 →2,382 (≥.1×). Across runs: ≥1.8×, ≥.0×, ≥.35×, ≥.1× —ratio varies with range coverage and summary density; all four checkpoints functional.

## Run 4 —Recommendations

- **Exercise tier-2/tier-3 (LSM distillation)**: now that status/search surfaces are observable, run a second compression pass over the tier-1 checkpoint (or a fresh tier-1 pass followed by distilling the checkpoint) and verify tiered `tierTokens`/restore behavior —out of reach in runs 1—.
- **Clarify decompress semantics**: decide whether the checkpoint record should be consumed/dropped on restore (currently it persists with originals still `shadowed`; replay is the only mechanism returning content). Document the intended contract.
- **Re-run the full sequence once more in a fresh session** to confirm the fixed `context_status`/`context_search` surfaces are stable across sessions (runs 1—'s failures were also session-specific), and re-check the `context/nudge` unknown-event compatibility for older logs.

---

## Run 3 —step log (exact outputs)

| # | Step | Tool / Input | Result |
|---|------|--------------|--------|
| 1 | Baseline status | `context_status` | `{}` (empty object). Harness `[context-management]` notice supplied the data instead: 29,099 total / 17,379 surface tokens; recommendable range seqs 8..600 (~12,098 tokens), large tool results at seqs 598 (~7,818) and 387 (~2,287). |
| 2 | Baseline search | `context_search "jiachen_project.tar"` | `{"query": "jiachen_project.tar"}` —**NO ERROR this run** (runs 1— hit the hard `context/nudge` unknown-event error here), but the result carries **no `hits` array**. |
| 3 | Error path: out-of-surface range | `context_compress` seqs [100000, 100001] | **ERROR**: `entry 0 failed: start seq 100000 is not on the current surface` —clean rejection, exact message, no surface mutation. |
| 4 | **Compress** | `context_compress` seqs 8..743 (11 nodes, ~15,714 tokens) | **PASS**: `compressed seqs 8..743 (11 nodes, ~15714 tokens) into checkpoint 7ff50848-a51a-416b-835d-313984c5324d (tier 1, ~3614 summary tokens)` —≥.35× reduction. |
| 5 | Verify checkpoint | `context_status` | `{}` (still empty; checkpoint id only reported by the compress result). Notice confirmed the effect: totals 29,653 →21,069, surface 17,873 →11,475. |
| 6 | Search shadowed content | `context_search "jiachen_project.tar"` | `{"query": "jiachen_project.tar"}` —no error, no `hits` (FTS over shadowed originals still not observable). |
| 7 | **Decompress (restore)** | `context_decompress ["7ff50848-a51a-416b-835d-313984c5324d"]` | **PASS**: `restored checkpoint 7ff50848-a51a-416b-835d-313984c5324d (tier 1): 11 events, ~15714 tokens, 62979 chars` —raw events replayed verbatim: workspace listing, HANDOFF.md full text, plugin/reports directory tree, both report files in full (`e2e-compaction-test.md`, `asc-phase1-implementation.md`), and the first `[context-management]` notice. |
| 8 | Verify restore | `context_search "jiachen_project.tar"` | `{"query": "jiachen_project.tar"}` —no error, no `hits` even though the target content is back on the current surface. `context_status` →`{}`. |
| 9 | Error path: unknown id | `context_decompress ["00000000-0000-0000-0000-000000000000"]` | `skipped: 00000000-0000-0000-0000-000000000000` —graceful no-op, no crash. |
| D | Diagnostic (extra) | `context_search "HANDOFF.md"` (guaranteed current-surface match after step 7) | `{"query": "HANDOFF.md"}` —still no `hits` array. Confirms the empty result is **not specific to shadowed content**: the search tool never returns hits in this deployment. |

## Run 3 —Pass / Fail summary

| Capability | Verdict | Evidence |
|---|---|---|
| Compress (checkpoint creation) | 鉁?PASS | tier-1 checkpoint `7ff50848-...`, 11 nodes / 15,714 tokens →3,614-token summary (≥.35×) |
| Decompress (log replay, zero storage) | 鉁?PASS | 11 events restored, 62,979 chars, content verified verbatim in replay output (largest restore across all runs) |
| Invalid-range rejection | 鉁?PASS | exact error, no surface mutation |
| Unknown-id handling | 鉁?PASS | graceful skip |
| context_status surface report | 鈿狅笍 PARTIAL | tool returns `{}` on every call (3rd run unchanged); surface info only via harness `[context-management]` notices |
| context_search (FTS incl. shadowed originals) | 鉂?NOT VALIDATED (failure mode changed) | no hard error this run, but **zero hits ever returned** —for shadowed AND current-surface queries with guaranteed matches. FTS-over-shadowed (ASC reaction 鈶? still unvalidated |

## Run 3 —Key findings

1. **Core round-trip works 3rd consecutive run**: compress →checkpoint →decompress →verbatim restore. This run set the largest restore record: 15,714 tokens in →62,979 chars across 11 events (the range included the two full report files).
2. **Search blocker changed from crash to silent empty result**: the fresh session had no `context/nudge` event (or the harness now tolerates it), so `context_search` executes without the runs-1/2 error —but it returns only the query echo with no `hits` field, for both shadowed (`jiachen_project.tar`) and current-surface (`HANDOFF.md`) queries with guaranteed matches. FTS-over-shadowed originals therefore remains unvalidated; the cause is now a presentation/index gap rather than a version-skew crash.
3. `context_status` never returned a structured result (`{}` every call, all 3 runs); checkpoint metadata is only visible in the compress result.
4. Compression ratio this run: 15,714 →3,614 summary tokens (≥.35×); prior runs ≥.0× and ≥1.8×. Ratio varies with summary density and range coverage; all three passes produced functional checkpoints.

## Run 3 —Recommendations

- **Investigate `context_search`'s zero-hit result contract** (new top blocker, replacing the nudge error): verify whether the FTS index is populated for this session's log and whether `hits` are dropped in result presentation. Fix either side so hits (with `surface`/`snippet`) are returned, then re-validate FTS over current and shadowed content (reaction 鈶?.
- **Wire `context_status` structured output** (surface nodes, tiers, checkpoint ids, recommended ranges) into the tool result instead of `{}` (open for 3 runs).
- Re-run the FTS and tier-2/tier-3 (LSM distillation) checks once the search tool returns hits; tiered distillation remains out of reach while checkpoint verification depends on the status/search surfaces.

---

## Run 2 —step log (exact outputs; preserved from prior version of this file)

| # | Step | Tool / Input | Result |
|---|------|--------------|--------|
| 1 | Baseline status | `context_status` | `{}` (empty object). Harness `[context-management]` notice supplied the data instead: ~21,707 total / 8,785 surface tokens; recommendable range seqs 8..532 (~4,246 tokens), large tool results at seqs 318 (~2,287) and 530 (~835). |
| 2 | Baseline search | `context_search "jiachen_project.tar"` | **ERROR**: `Error: session-search persistence observation failed: session "session-1d47d797-8948-4eb4-892d-1fc36f8d28de" contains event type "context/nudge" (seq 466) unknown to this harness and not marked ignorable; refusing to interpret the log —it was likely written by a newer harness (raw log: C:\Users\wujia\.dsh\sessions\--E-WorkSpace--\session-1d47d797-8948-4eb4-892d-1fc36f8d28de\session.jsonl.zstd)` |
| 3 | Error path: out-of-surface range | `context_compress` seqs [1000, 1100] | **ERROR**: `entry 0 failed: start seq 1000 is not on the current surface` —clean rejection, exact message, no surface mutation. |
| 4 | **Compress** | `context_compress` seqs 8..1290 (14 nodes, ~8,912 tokens) | **PASS**: `compressed seqs 8..1290 (14 nodes, ~8912 tokens) into checkpoint 3a8e9f18-a245-4d6e-b1be-70535470c3fc (tier 1, ~2230 summary tokens)` —~4.0× reduction. |
| 5 | Verify checkpoint | `context_status` | `{}` (still empty; checkpoint id only reported by the compress result). |
| 6 | Search shadowed content | `context_search "jiachen_project.tar"` | Same **ERROR** as step 2 (nudge event, verbatim above) —search over shadowed originals could not be exercised in this deployment. |
| 7 | **Decompress (restore)** | `context_decompress ["3a8e9f18-a245-4d6e-b1be-70535470c3fc"]` | **PASS**: `restored checkpoint 3a8e9f18-a245-4d6e-b1be-70535470c3fc (tier 1): 14 events, ~8912 tokens, 35742 chars` —raw events replayed verbatim (workspace listing, HANDOFF.md, prior E2E report, plugin README, AGENTS.md instructions, first `[context-management]` notice all present in the replay output). |
| 8 | Verify restore | `context_search "jiachen_project.tar"` | Same **ERROR** as step 2 (nudge event). `context_status` →`{}`. |
| 9 | Error path: unknown id | `context_decompress ["00000000-0000-0000-0000-000000000000"]` | `skipped: 00000000-0000-0000-0000-000000000000` —graceful no-op, no crash. |

### Run 2 —Pass / Fail summary

| Capability | Verdict | Evidence |
|---|---|---|
| Compress (checkpoint creation) | 鉁?PASS | tier-1 checkpoint `3a8e9f18-...`, 14 nodes / 8,912 tokens →2,230-token summary |
| Decompress (log replay, zero storage) | 鉁?PASS | 14 events restored, 35,742 chars, content verified verbatim in replay output |
| Invalid-range rejection | 鉁?PASS | exact error, no surface mutation |
| Unknown-id handling | 鉁?PASS | graceful skip |
| context_status surface report | 鈿狅笍 PARTIAL | tool returns `{}`; surface info only via harness `[context-management]` notices |
| context_search (FTS incl. shadowed originals) | 鉂?BLOCKED | persistent error —session log contains `context/nudge` (seq 466) unknown to this harness and not marked ignorable |

### Run 2 —Key findings

1. **Core round-trip works end-to-end (2nd consecutive run)**: compress →checkpoint →decompress →verbatim restore. The ASC design's "decompress replays the log with zero storage" behavior is confirmed live again (8,912 tokens in, 35,742 chars restored across 14 events).
2. **Version-skew bug in the observability layer, reproduced in a fresh session**: this session's log carries a `context/nudge` event at **seq 466** (prior session: seq 2047) that is **unknown to this harness** and not marked ignorable, so `context_search` (and its persistence observation) refuses to interpret the log. The log is append-only, so the failure persists before and after compression —the FTS-over-shadowed-originals capability (ASC reaction 鈶? still cannot be validated in this deployment.
3. `context_status` never returned a structured result (`{}` every call) —the plugin/harness status report is not wired through in this session; checkpoint metadata is only visible in the compress result.
4. Compression ratio this run: 8,912 →2,230 summary tokens (≥.0×) in one tier-1 pass (prior run: ≥1.8×). Ratio varies with summary density and range coverage; both passes produced functional checkpoints.

### Run 2 —Recommendations

- **Upgrade the harness search/observation layer** to know (or ignore) the `context/nudge` event type, or mark it ignorable in the log schema —this unblocks `context_search` for both visible and shadowed content. (Superseded in Run 3: the nudge crash no longer occurs; the new blocker is the zero-hit result contract.)
- **Wire `context_status` structured output** (surface nodes, tiers, checkpoint ids, recommended ranges) into the tool result instead of `{}`.
- Re-run the FTS and tier-2/tier-3 (LSM distillation) checks once the search blocker is fixed; tiered distillation was out of reach in this run because checkpoint verification depends on the status/search surfaces.

---

## Run 1 —recap

- Driver session `68001db5-4550-4190-b16d-1ffe72c50a1f`; previous version of this file. Same canonical sequence; core compress/decompress round-trip 鉁?(≥1.8× ratio), invalid-range rejection 鉁? unknown-id graceful skip 鉁? `context_status` `{}`; `context_search` blocked by the same `context/nudge` unknown-event error (that session's nudge event at seq 2047).

## Cross-run comparison (2026-08-14)

| Metric | Run 1 | Run 2 | Run 3 | Run 4 |
|---|---|---|---|---|
| Compress range | (per run-2 report) | seqs 8..1290, 14 nodes | seqs 8..743, 11 nodes | seqs 8..534, 9 nodes |
| Tokens shadowed →summary | —(≥1.8× ratio) | 8,912 →2,230 (≥.0×) | 15,714 →3,614 (≥.35×) | 7,417 →2,382 (≥.1×) |
| Restore | 鉁?| 鉁?14 events / 35,742 chars | 鉁?11 events / 62,979 chars | 鉁?9 events / 29,781 chars |
| context_status | `{}` | `{}` | `{}` | 鉁?structured (all calls) |
| context_search | 鉂?nudge crash | 鉂?nudge crash (seq 466) | 鉂?silent zero-hit (no crash) | 鉁?hits (current / log-only / shadowed) |
| Error paths (C1-range, unknown id) | 鉁?/ 鉁?| 鉁?/ 鉁?| 鉁?/ 鉁?| 鉁?/ 鉁?|

