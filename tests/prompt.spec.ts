import { describe, expect, it } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createContext } from './helpers.ts'
import { COMPACTION_PHILOSOPHY, PHILOSOPHY_SECTION_NAME, registerPhilosophyPrompt } from '../src/engine/prompt.ts'

describe('registerPhilosophyPrompt', () => {
  it('registers a section following the ACP-proven structure', async () => {
    const ctx = createContext()
    void new SystemPrompt(ctx, {})
    const dispose = registerPhilosophyPrompt(ctx)
    const assembled = await ctx.systemPrompt.assemble({})
    const section = assembled.sections.find(section => section.name === PHILOSOPHY_SECTION_NAME)
    expect(section).toBeDefined()
    // Opening principle: frugal but task-first.
    expect(section!.text).toContain('All compression serves the primary task, but be frugal')
    // Surface annotation: seqs from context_status.
    expect(section!.text).toContain('SURFACE SEQS')
    expect(section!.text).toContain('context_status')
    // Summary safety: checkpoint content is historical.
    expect(section!.text).toContain('CHECKPOINT CONTENT IS HISTORICAL')
    expect(section!.text).toContain('NOT user messages')
    // Tools with exact usage and batch example.
    expect(section!.text).toContain('THE TOOLS')
    expect(section!.text).toContain('five context-management tools')
    expect(section!.text).toContain('context_compress')
    expect(section!.text).toContain('context_decompress')
    expect(section!.text).toContain('context_recap')
    expect(section!.text).toContain('context_search')
    expect(section!.text).toContain('Batch (multiple unrelated ranges')
    // Philosophy: failure modes + single test.
    expect(section!.text).toContain('COMPRESSION PHILOSOPHY')
    expect(section!.text).toContain('Is this content still needed by the current task step?')
    // When to / when not.
    expect(section!.text).toContain('WHEN TO COMPRESS')
    expect(section!.text).toContain('WHEN NOT TO COMPRESS')
    // How to compress: keep verbatim + drop + priority.
    expect(section!.text).toContain('HOW TO COMPRESS')
    expect(section!.text).toContain('KEEP VERBATIM')
    expect(section!.text).toContain('load-bearing')
    expect(section!.text).toContain('DROP')
    expect(section!.text).toContain('PRIORITY')
    // Multi-tier: the levels and their restore path are explicit.
    expect(section!.text).toContain('MULTI-TIER COMPRESSION')
    expect(section!.text).toContain('RAW SURFACE (tier 0)')
    expect(section!.text).toContain('DISTILL (T2)')
    expect(section!.text).toContain('CONDENSE (T3)')
    expect(section!.text).toContain('TIER 2 DISTILLATION')
    expect(section!.text).toContain('TIER 3 CONDENSATION')
    expect(section!.text).toContain('lookup index, not a knowledge base')
    // Context retrieval and maintenance: the plugin teaches the complete
    // read/update/archive workflow, not just how to write a summary.
    expect(section!.text).toContain('COMPRESSION CONTRACT FOR RETRIEVAL')
    expect(section!.text).toContain('CONTEXT RETRIEVAL (LOCATE FIRST, EXPAND SECOND)')
    expect(section!.text).toContain('BLOCK NAVIGATION')
    expect(section!.text).toContain('TOKEN SEARCH')
    expect(section!.text).toContain('checkpointId')
    expect(section!.text).toContain('CONTEXT MAINTENANCE (UPDATE / ARCHIVE)')
    // Our additions: planned review + cadence.
    expect(section!.text).toContain('WHEN TO REVIEW')
    expect(section!.text).toContain('complete a large phase or a major task')
    expect(section!.text).toContain('THE OPERATING CADENCE')
    expect(section!.text).toContain('batch 2–3 raw ranges in a single context_compress call')
    // Guidance, not a command.
    expect(section!.text).toContain('the nudge is guidance, not a command')
    dispose()
  })

  it('removes the section on dispose (registration is an effect)', async () => {
    const ctx = createContext()
    void new SystemPrompt(ctx, {})
    const dispose = registerPhilosophyPrompt(ctx)
    dispose()
    const assembled = await ctx.systemPrompt.assemble({})
    expect(assembled.sections.some(section => section.name === PHILOSOPHY_SECTION_NAME)).toBe(false)
  })

  it('duplicate registration of the same section name throws', () => {
    const ctx = createContext()
    void new SystemPrompt(ctx, {})
    registerPhilosophyPrompt(ctx)
    expect(() => registerPhilosophyPrompt(ctx)).toThrow()
  })

  it('pins the doctrine text verbatim for model-visible stability', () => {
    expect(COMPACTION_PHILOSOPHY).toContain('CONTEXT MANAGEMENT DOCTRINE')
    expect(COMPACTION_PHILOSOPHY).toContain('Over-compression')
    expect(COMPACTION_PHILOSOPHY).toContain('Under-compression')
    expect(COMPACTION_PHILOSOPHY).toContain('SURFACE SEQS')
    expect(COMPACTION_PHILOSOPHY).toContain('CHECKPOINT CONTENT IS HISTORICAL')
    expect(COMPACTION_PHILOSOPHY).toContain('WHEN TO COMPRESS')
    expect(COMPACTION_PHILOSOPHY).toContain('MULTI-TIER COMPRESSION')
    expect(COMPACTION_PHILOSOPHY).toContain('WHEN TO REVIEW')
    expect(COMPACTION_PHILOSOPHY).toContain('THE OPERATING CADENCE')
  })
})
