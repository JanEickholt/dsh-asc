# Cache economics: joining dsh-asc folds with the bili proxy ledger

dsh-asc keeps the model-visible surface bounded, but every fold has a cost the
session log cannot see: the upstream provider's prompt cache. When a
compaction rewrites the conversation surface, the request that follows no
longer shares a prefix with the previous one, so the provider's cache misses
and the whole (new, smaller) surface is re-billed as input. This guide shows
how to measure that cost offline, per fold, by running dsh-asc behind the
bili proxy in `--passthrough` mode and joining its cache ledger to the
session log afterwards.

Everything here is read-only analytics over already-written artifacts. The
join runs offline, after the session, and touches neither the live session
nor the proxy.

## Running dsh-asc with bili as a passive observer

bili is a local LLM proxy with an ACP (agentic context protocol) prompt-cache
ledger. In `--passthrough` mode (verified with bili 0.1.185) it forwards
request bodies to the upstream **uncompressed**: it never compacts or rewrites
them. That is the required setup — dsh-asc stays the sole compactor, so the
model-visible surface is exactly what the session log says it is, while bili
still records every upstream request and how much of it the provider served
from cache.

```sh
# 1. Run the proxy in front of the provider, passthrough:
bili --passthrough --port <port>

# 2. Point the harness's provider route at the proxy:
#    provider base URL = http://127.0.0.1:<port>/...   (profile/route config)

# 3. Run the session normally. dsh-asc folds; bili only observes and bills.

# 4. Export the ledger when the session is done (see below), then join:
tsx scripts/bili-cache-join.ts --session <session-log.jsonl> --cache <report.json>
```

## Exporting the bili ledger

Two artifacts matter:

- **The request ledger / `acp_cache` report.** bili's `acp_cache` accounting
  keeps a grand ledger — total input, cached, and output tokens with an
  overall hit rate — and per-request rows where every request's cache miss is
  split into *new content*, *compression re-pay*, and
  *upstream-TTL-or-client-rewrite* (unattributed stable-prefix misses). Its
  fold-economics section adds, per fold: `S` (shadowed tokens), `σ` (summary
  tokens), `h` (hit rate), `T` (re-pay charged), `ΔC₁` (first-request
  re-pay), `Δs` (per-turn savings once the new prefix is cached), `n*`
  (breakeven turns), `k` (measured post-fold cadence), and a per-fold verdict
  of `PAID BACK` / `NOT PAID BACK` / `unobserved`.
- **The adjacent-pair diff.** `bili acp-cache diff <dir>` classifies adjacent
  request pairs from `ACP_DUMP_BODY` dumps into `pure-append` (the previous
  request is a strict prefix — cache-friendly), `mid-stream-rewrite` (the
  tail changed mid-prefix — the cache break a compaction causes), and
  `prefix-stable-miss` (stable prefix, miss attributable to upstream TTL or
  client rewrite).

The join script accepts the report as JSON or JSONL, the diff's text export
(`key: value` blocks), or a dump directory of body files:

```sh
# report as JSON (either shape works):
tsx scripts/bili-cache-join.ts --session session.v4.jsonl --cache acp-report.json [--json]

# raw dump directory — one file per request body:
tsx scripts/bili-cache-join.ts --session <dir-of-logs> --cache <ACP_DUMP_BODY-dir>
```

The parser is schema-tolerant by design (neither export is a frozen
contract): it accepts the field spellings both tools emit, treats unknown
fields as null, and skips malformed records instead of throwing. If it
prints `skipped N malformed cache-side records`, those units could not be
decoded into a usable request at all.

## What the join shows

```sh
tsx scripts/bili-cache-join.ts --session session.v4.jsonl --cache acp-report.json
```

```text
compactionId              foldSeq   shadowed   rePay    reqIdx  n*     k     verdict
c-aaa                     2         5000       120      1       2.0    2     PAID BACK
c-bbb                     9         250        -        -       -      -     unobserved
```

One row per fold:

| Column | Meaning |
|---|---|
| `compactionId`, `foldSeq` | The fold's durable id and session-log seq. |
| `shadowed` | `S`: tokens the fold took off the surface. |
| `rePay` | `ΔC₁`: compression re-pay charged on the request right after the fold — the cost of rebuilding the cache prefix. |
| `reqIdx` | Index of the matched bili request; `-` means no re-pay request followed the fold (the cache never broke, or the export ends first). |
| `n*` | Breakeven turns: `ΔC₁ / Δs` — how many post-fold turns must bank the per-turn saving before the fold pays for itself. |
| `k` | Measured post-fold cadence: requests observed after the matched one. |
| `verdict` | `PAID BACK` (`k >= n*`), `NOT PAID BACK` (`k < n*`), or `unobserved` (no match, or `Δs` not derivable offline). |

**The join rule.** Each `compaction/summary` event is matched to the first
bili request *after its timestamp* with compression re-pay > 0 — the
mid-stream-rewrite the fold caused, within a 10-minute window. Exports
without timestamps fall back to list order. A fold whose `mid-stream-rewrite`
re-pay is never observed reads `unobserved`, which is itself a finding: the
compaction landed without breaking the provider cache (small folded span,
or the upstream TTL had already expired the prefix anyway).

**The footer** aggregates the ledger: total input and cached tokens, overall
hit rate, and the re-pay share of input. Healthy dsh-asc traffic on this
setup reads **95–97% hit rate** with **compression re-pay at or under 2% of
input**. A much lower hit rate means something other than folds is rewriting
the prefix (see the diff's `prefix-stable-miss` class — upstream TTL expiry,
not compaction); a re-pay share far above 2% means folds are firing too
often for how long the post-fold prefix survives.

## Reading verdicts

- `PAID BACK`: the fold's per-turn saving, banked over the observed cadence,
  exceeded the one-time re-pay. `k >= n*` is the whole rule.
- `NOT PAID BACK`: the session ended (or the export window closes) before
  the fold amortized. A fold that dsh-asc kept alive — never decompressed,
  never regretted — can still be `NOT PAID BACK` on cache economics alone:
  the model stopped needing those tokens, but too few turns followed to
  repay the prefix rebuild. Clusters of these near the session tail are
  usually fine; clusters early in long sessions mean fold cadence is
  mistuned against prefix survival (compare `n*` with how long the upstream
  actually holds the prefix).
- `unobserved`: no re-pay request matched. Either the fold never broke the
  cache, or the export does not cover the post-fold requests. Treat it as
  "no evidence", not "no cost".

`NOT PAID BACK` here is a cache-economics statement only. Whether the fold
was *right* is a different question — answered by dsh-asc's own analytics
(the `asc-stats` regret signals: a fold followed by `context_decompress` of
the shadowed content is regret regardless of cache arithmetic). The two
views compose: regret + `NOT PAID BACK` is the expensive mistake;
`PAID BACK` + quiet is the healthy fold; `PAID BACK` + regret is cheap but
still worth a tuning look.

## Scope and limits

- The join is timestamp- and order-based; it never inspects message bodies.
  Two artifacts from different sessions can be joined but will produce
  mostly `unobserved` rows (no re-pay falls in the folds' windows).
- `Δs` (per-turn savings) is only computable when the export's fold
  economics provide it; without it the row stays `unobserved` even when a
  re-pay matched, and `n*` reads `-`. The session log alone does not persist
  the framed summary size, so the offline join cannot derive it.
- `--passthrough` mode is required. Any proxy-side compaction would make
  bili the second compactor and the joined numbers would describe bili's
  folds, not dsh-asc's.
