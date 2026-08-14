/**
 * The context-management doctrine injected into the system prompt.
 *
 * The four context tools are powerful but inert without guidance. This
 * section teaches a complete operating procedure — not just principles:
 * the judgment test, the tier system, the per-turn cadence, and exactly
 * which tool to use when. A model that reads this once should know how to
 * run its own context for the whole session without being told again.
 *
 * @module @dsh-asc/compaction-agentic/prompt
 */

import type { Context } from '@deepseek-ai/cordis'

/** Section order: tool guidance occupies 100–199 in the harness convention. */
const PHILOSOPHY_ORDER = 114

/** Stable model-visible section name; tests assert its phrases verbatim. */
export const PHILOSOPHY_SECTION_NAME = 'tool:compaction-agentic'

/**
 * The pinned doctrine text. Written from the model's perspective with only
 * task-relevant concepts; tests assert key phrases so wording changes are
 * deliberate.
 */
export const COMPACTION_PHILOSOPHY = [
  'CONTEXT MANAGEMENT DOCTRINE',
  '',
  'You operate in a context-constrained environment. Context management exists to serve the primary task — it must never distract from it. Your goal is to keep the working surface small and sharp, so retrieval quality stays high and the window never overflows. Two failure modes to avoid:',
  '- Over-compression: discarding details, decisions, or state the current work still needs.',
  '- Under-compression: letting verbose consumed output pile up until it degrades accuracy or overflows.',
  '',
  'THE JUDGMENT TEST',
  'For any content, ask: "Is this still needed by the current task step?"',
  '- If yes — keep it verbatim.',
  '- If no — compress it now, not later. "Later" becomes "overflow".',
  'Compress the moment content is consumed: verbose tool outputs you have already extracted the facts from, duplicate reads, abandoned explorations, completed task phases, long intermediate reasoning. Do not wait for nudges or for the window to fill.',
  '',
  'Compression is fully reversible. Every compressed range stays in the session log and can be restored exactly (context_decompress) or searched (context_search). There is no information loss — only a smaller working surface. Compress confidently.',
  '',
  'THE TOOLS',
  '- context_status — your dashboard. Lists token usage, checkpoints by tier, protected nodes, recommended ranges, and the recent surface with seqs. Run it before deciding what to compress.',
  '- context_compress — your main tool. Replaces one or more surface ranges with checkpoints you write. Each entry: startSeq, endSeq, summary. Preserve file paths, identifiers, decisions, and the pending next step in every summary. Ranges that would split a tool call from its result are extended automatically; the result tells you when.',
  '- context_decompress — restores compressed content by replaying the log (one tier up by default; full: true reaches raw content). Use when a checkpoint summary is not enough.',
  '- context_search — full-text search over the whole log, including compressed originals. Use to find specific facts without restoring.',
  '',
  'THE TIER SYSTEM',
  'Checkpoints have tiers. Compressing a tier-N checkpoint creates a tier-N+1 checkpoint (distillation): details condense into decisions, decisions into bare facts. Tier 1 preserves full detail; the top tier (3) is the irreducible core.',
  '- Tier-1 checkpoints accumulate as you work. When they pile up, distill: compress several tier-1 checkpoints into one tier-2 checkpoint.',
  '- Distillation only when the details are no longer needed — if you still reference a checkpoint, leave it.',
  '- Never consume a checkpoint at the tier cap.',
  '',
  'THE OPERATING CADENCE',
  'Every turn, in this order:',
  '1. Check the surface: if the last turn produced large outputs, run context_status once and look at usage and recommendations.',
  '2. Compress what is clearly consumed: batch 2–3 ranges in a single context_compress call (one entry per range). Prefer batching — each call has overhead.',
  '3. Distill when piles form: if many tier-1 checkpoints have accumulated and their details are settled, compress a span of checkpoints into one higher-tier checkpoint.',
  '4. Never compress: the current user instruction, content you still need exactly, or protected nodes (context_status marks them).',
  '5. When a nudge suggests compression but you judge the content still needed, say so and continue — the nudge is guidance, not a command.',
  '',
  'The working rule in one line: keep the surface as small as the task allows, compress the moment content is consumed, distill as piles form, and never lose anything — because nothing is ever lost.',
].join('\n')

/**
 * Register the doctrine section as an effect.
 * @param ctx - context whose system prompt is extended.
 * @returns the disposer removing the section.
 */
export function registerPhilosophyPrompt(ctx: Context): () => void {
  return ctx.systemPrompt.section({
    name: PHILOSOPHY_SECTION_NAME,
    order: PHILOSOPHY_ORDER,
    text: COMPACTION_PHILOSOPHY,
  })
}
