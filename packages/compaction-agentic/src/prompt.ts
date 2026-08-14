/**
 * The compression philosophy injected into the system prompt.
 *
 * The four context tools are powerful but inert without guidance: nothing in
 * the harness tells the model WHEN to compress or WHY. This section teaches
 * the active-compression discipline — the single test for whether content
 * should be compressed, the two failure modes to avoid, and the
 * tool workflow — so the model acts proactively instead of waiting for
 * nudges or overflow.
 *
 * @module @dsh-asc/compaction-agentic/prompt
 */

import type { Context } from '@deepseek-ai/cordis'

/** Section order: tool guidance occupies 100–199 in the harness convention. */
const PHILOSOPHY_ORDER = 114

/** Stable model-visible section name; tests assert its phrases verbatim. */
export const PHILOSOPHY_SECTION_NAME = 'tool:compaction-agentic'

/**
 * The pinned philosophy text. Written from the model's perspective with only
 * task-relevant concepts; tests assert key phrases so wording changes are
 * deliberate.
 */
export const COMPACTION_PHILOSOPHY = [
  'CONTEXT MANAGEMENT PHILOSOPHY',
  '',
  'You operate in a context-constrained environment. Context management exists to serve the primary task — it must never distract from it. Two failure modes to avoid:',
  '- Over-compression: discarding details, decisions, or state the current work still needs.',
  '- Under-compression: letting verbose consumed output pile up until it degrades accuracy or overflows.',
  '',
  'The single test for compression: is this content still needed by the current task step? If yes, keep it. If no, compress it.',
  '',
  'Be frugal proactively. Compress obvious waste the moment it is consumed — verbose outputs you have already extracted the facts from, duplicate reads, abandoned explorations, completed task phases — without waiting for context to fill up. Waiting until the window is nearly full harms retrieval quality and risks overflow.',
  '',
  'Compression is reversible: the original content stays in the session log and can be restored with context_decompress or found with context_search. Compress confidently; you can always get the details back.',
  '',
  'Workflow:',
  '- context_status lists usage, checkpoints, protected content, and recommended ranges. Use it before compressing.',
  '- context_compress replaces a surface range with a checkpoint you write. Preserve file paths, identifiers, decisions, and next steps in the summary. Ranges that would split a tool call from its result are extended automatically to keep the pair intact; the result tells you when that happened.',
  '- context_decompress restores compressed content by replaying the log (one tier up by default, full: true to the raw bottom).',
  '- context_search finds any content in the full log, including compressed originals.',
  '',
  'Never compress the current user instruction or content you still need exactly. When a nudge suggests compression but you judge the content still needed, say so and continue — the nudge is guidance, not a command.',
].join('\n')

/**
 * Register the philosophy section as an effect.
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
