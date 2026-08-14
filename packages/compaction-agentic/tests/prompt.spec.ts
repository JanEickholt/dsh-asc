import { describe, expect, it } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createContext } from './helpers.ts'
import { COMPACTION_PHILOSOPHY, PHILOSOPHY_SECTION_NAME, registerPhilosophyPrompt } from '../src/prompt.ts'

describe('registerPhilosophyPrompt', () => {
  it('registers a section whose text teaches the active-compression philosophy', async () => {
    const ctx = createContext()
    void new SystemPrompt(ctx, {})
    const dispose = registerPhilosophyPrompt(ctx)
    const assembled = await ctx.systemPrompt.assemble({})
    const section = assembled.sections.find(section => section.name === PHILOSOPHY_SECTION_NAME)
    expect(section).toBeDefined()
    expect(section!.text).toContain('CONTEXT MANAGEMENT PHILOSOPHY')
    expect(section!.text).toContain('is this content still needed by the current task step?')
    expect(section!.text).toContain('Compression is reversible')
    expect(section!.text).toContain('context_status')
    expect(section!.text).toContain('context_compress')
    expect(section!.text).toContain('context_decompress')
    expect(section!.text).toContain('context_search')
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

  it('pins the philosophy text verbatim for model-visible stability', () => {
    // The model sees this text every request; wording changes must be
    // deliberate. Tests assert key phrases so edits are noticed.
    expect(COMPACTION_PHILOSOPHY).toContain('Over-compression')
    expect(COMPACTION_PHILOSOPHY).toContain('Under-compression')
    expect(COMPACTION_PHILOSOPHY).toContain('Be frugal proactively')
    expect(COMPACTION_PHILOSOPHY).toContain('Never compress the current user instruction')
  })
})
