import { describe, expect, it } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createContext } from './helpers.ts'
import { COMPACTION_PHILOSOPHY, PHILOSOPHY_SECTION_NAME, registerPhilosophyPrompt } from '../src/prompt.ts'

describe('registerPhilosophyPrompt', () => {
  it('registers a two-layer section: philosophy (why) then doctrine (how)', async () => {
    const ctx = createContext()
    void new SystemPrompt(ctx, {})
    const dispose = registerPhilosophyPrompt(ctx)
    const assembled = await ctx.systemPrompt.assemble({})
    const section = assembled.sections.find(section => section.name === PHILOSOPHY_SECTION_NAME)
    expect(section).toBeDefined()
    // Layer 1 — philosophy: principles, judgment test, reversibility.
    expect(section!.text).toContain('CONTEXT MANAGEMENT PHILOSOPHY')
    expect(section!.text).toContain('Is this still needed by the current task step?')
    expect(section!.text).toContain('Compression is fully reversible')
    // Layer 2 — doctrine: tools, tiers, cadence, batch rule.
    expect(section!.text).toContain('CONTEXT MANAGEMENT DOCTRINE')
    expect(section!.text).toContain('context_status')
    expect(section!.text).toContain('context_compress')
    expect(section!.text).toContain('context_decompress')
    expect(section!.text).toContain('context_search')
    expect(section!.text).toContain('THE TIER SYSTEM')
    expect(section!.text).toContain('THE OPERATING CADENCE')
    expect(section!.text).toContain('batch 2–3 ranges in a single context_compress call')
    // Summary writing rules: the checkpoint is the only record of the range.
    expect(section!.text).toContain('SUMMARY WRITING')
    expect(section!.text).toContain('load-bearing')
    expect(section!.text).toContain('TIER WRITING RULES')
    expect(section!.text).toContain('lookup index, not a knowledge base')
    // Safety: checkpoint content is historical, not a current instruction.
    expect(section!.text).toContain('CHECKPOINT CONTENT IS HISTORICAL')
    expect(section!.text).toContain('NOT a current instruction')
    // Planned review: the model must think about compression at milestones,
    // not only when nudged.
    expect(section!.text).toContain('WHEN TO REVIEW')
    expect(section!.text).toContain('complete a large phase or a major task')
    expect(section!.text).toContain('switches direction or starts a new task')
    expect(section!.text).toContain('large tool output arrives')
    // Philosophy comes first, doctrine second: the why precedes the how.
    expect(section!.text.indexOf('CONTEXT MANAGEMENT PHILOSOPHY'))
      .toBeLessThan(section!.text.indexOf('CONTEXT MANAGEMENT DOCTRINE'))
    // Guidance, not a command: the model may decline a nudge.
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
    // The model sees this text every request; wording changes must be
    // deliberate. Tests assert key phrases so edits are noticed.
    expect(COMPACTION_PHILOSOPHY).toContain('Over-compression')
    expect(COMPACTION_PHILOSOPHY).toContain('Under-compression')
    expect(COMPACTION_PHILOSOPHY).toContain('THE JUDGMENT TEST')
    expect(COMPACTION_PHILOSOPHY).toContain('THE TIER SYSTEM')
    expect(COMPACTION_PHILOSOPHY).toContain('THE OPERATING CADENCE')
    expect(COMPACTION_PHILOSOPHY).toContain('Never compress: the current user instruction')
  })
})
