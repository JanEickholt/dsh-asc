/**
 * Corpus statistics extractor: authentic, reproducible numbers from real
 * DSH session logs.
 *
 * Scans ~/.dsh/sessions (or a directory passed as argv[2]) for session logs,
 * attributes folds to engines by tool fingerprints (dsh-asc registers the six
 * `context_*` tools; billion-context-dsh registers bare `compress` /
 * `decompress` / `search`), and reports production compaction numbers:
 * folds, shadowed tokens, retrieval usage, cache hit rate, and post-fold
 * re-pay. Uses only committed log events — every number is auditable by
 * replaying the logs.
 *
 * Usage: node scripts/corpus-stats.mjs [sessions-dir]
 */
import { execSync } from 'node:child_process'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? `${process.env.HOME}/.dsh/sessions`
if (!existsSync(root)) {
  console.error(`no sessions directory at ${root}`)
  process.exit(1)
}

/** Recursively collect session.v*.jsonl.zstd logs (the versioned format;
 * bare session.jsonl.zstd is a legacy pre-versioning format). */
function collectLogs(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...collectLogs(p))
    else if (/^session\.v\d+\.jsonl\.zstd$/.test(name)) out.push(p)
  }
  return out
}

const files = collectLogs(root)
// Dedupe session ids across format generations (v3/v4 = same session).
const byId = new Map()
for (const f of files) {
  const id = f.match(/sessions\/[^/]+\/([^/]+)\//)?.[1] ?? f
  if (!byId.has(id)) byId.set(id, [])
  byId.get(id).push(f)
}

const CONTEXT_TOOLS = ['context_compress', 'context_decompress', 'context_recap', 'context_retrieve', 'context_search', 'context_status']
const BCD_TOOLS = ['compress', 'decompress', 'search']

let sessions = 0, folds = 0, shadowed = 0, summaryChars = 0
let input = 0, cache = 0, output = 0
let requestCount = 0
let dec = 0, recap = 0, retrieve = 0, search = 0, status = 0, compress = 0
let regret = 0
let errEnds = 0
let fallbackAuthor = 0, modelAuthor = 0
const postFoldMiss = []
const foldShadowedAll = []
// per-session request tally fix
let sessionReqCount = 0

for (const [id, fs] of byId) {
  // Newest format generation only.
  const file = fs.sort().pop()
  let json
  try {
    json = execSync(`zstd -dc "${file}"`, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 })
  } catch {
    continue
  }
  let hasCtx = false, hasBcd = false
  const reqs = []
  const foldSeqs = []
  const decSeqs = []
  let sFolds = 0, sShadowed = 0, sSummaryChars = 0
  let sInput = 0, sCache = 0, sOutput = 0
  let sDec = 0, sRecap = 0, sRetrieve = 0, sSearch = 0, sStatus = 0, sCompress = 0
  for (const line of json.split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type === 'tool/call') {
      const n = e.data?.name ?? ''
      if (n.startsWith('context_')) hasCtx = true
      if (BCD_TOOLS.includes(n)) hasBcd = true
      if (n === 'context_decompress') { sDec++; decSeqs.push(e.seq) }
      else if (n === 'context_recap') sRecap++
      else if (n === 'context_retrieve') sRetrieve++
      else if (n === 'context_search') sSearch++
      else if (n === 'context_status') sStatus++
      else if (n === 'context_compress') sCompress++
    }
    if (e.type === 'compaction/summary') {
      sFolds++
      sShadowed += e.data?.shadowedTokenCount ?? 0
      sSummaryChars += (e.data?.summary ?? []).reduce((a, b) => a + (b?.text?.length ?? 0), 0)
      foldSeqs.push(e.seq)
      if (e.data?.llmStreamCall === true) fallbackAuthor++
      else modelAuthor++
    }
    if (e.type === 'compaction/end' && e.data?.error) errEnds++
    if (e.type === 'assistant/message' && e.data?.usage?.inputTokens != null) {
      const u = e.data.usage
      reqs.push({ seq: e.seq, input: u.inputTokens ?? 0, cache: u.cacheReadTokens ?? 0 })
      sInput += u.inputTokens ?? 0
      sCache += u.cacheReadTokens ?? 0
      sOutput += u.outputTokens ?? 0
    }
  }
  // Engine attribution: a session belongs to dsh-asc when the context_* tools
  // were registered (tool calls observed) — folds in sessions without any
  // context_* call could come from another engine and are excluded.
  if (!hasCtx || sFolds === 0) continue
  sessions++
  folds += sFolds; shadowed += sShadowed; summaryChars += sSummaryChars
  input += sInput; cache += sCache; output += sOutput
  dec += sDec; recap += sRecap; retrieve += sRetrieve; search += sSearch; status += sStatus; compress += sCompress
  sessionReqCount += reqs.length
  for (const f of foldSeqs) {
    const next = reqs.find(r => r.seq > f)
    if (next) postFoldMiss.push(next.input)
    foldShadowedAll.push(sShadowed / Math.max(sFolds, 1))
  }
  for (const d of decSeqs) {
    for (const f of foldSeqs) if (d > f && d - f <= 200) { regret++; break }
  }
}

const fmt = n => Math.round(n).toLocaleString('en-US')
const med = arr => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }
const hit = 100 * cache / Math.max(cache + input, 1)

console.log(`sessions (dsh-asc, folds > 0):   ${sessions}`)
console.log(`folds:                           ${folds}`)
console.log(`tokens shadowed by folds:        ${fmt(shadowed)}`)
console.log(`summary chars committed:         ${fmt(summaryChars)}`)
console.log(`model-authored summaries:        ${modelAuthor} (fallback: ${fallbackAuthor})`)
console.log(`failed folds (compaction/end error): ${errEnds}`)
console.log(`context_compress calls:          ${compress}`)
console.log(`context_decompress calls:       ${dec}  (regret window 200 seqs: ${regret})`)
console.log(`context_recap calls:            ${recap}`)
console.log(`context_retrieve calls:         ${retrieve}`)
console.log(`context_search calls:           ${search}`)
console.log(`context_status calls:           ${status}`)
console.log(`LLM requests metered:           ${fmt(sessionReqCount)}`)
console.log(`cache hit rate:                  ${hit.toFixed(1)}%  (${fmt(cache)} cached / ${fmt(input)} miss)`)
console.log(`median fold size (tokens):       ${fmt(med(foldShadowedAll))}`)
console.log(`median post-fold request miss:   ${fmt(med(postFoldMiss))}`)
