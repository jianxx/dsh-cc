import { describe, expect, it } from 'vitest'
import { MEMORY_AGENT_TOOLS, MEMORY_TOOL_FILTER } from '../src/tools.ts'
import { buildConsolidationPrompt, buildExtractionPrompt } from '../src/prompts.ts'

describe('MEMORY_TOOL_FILTER', () => {
  it('allows only read/search and memory-writing file tools', () => {
    expect([...MEMORY_AGENT_TOOLS].sort()).toEqual(['Edit', 'Glob', 'Grep', 'Read', 'Write'])
    expect(MEMORY_TOOL_FILTER.allow).toBe(MEMORY_AGENT_TOOLS)
  })
})

describe('buildExtractionPrompt', () => {
  it('names the memory directory, tool filter, and message count', () => {
    const prompt = buildExtractionPrompt(3, '/mem', '- a.md: desc')
    expect(prompt).toContain('last 3 messages')
    expect(prompt).toContain('`/mem`')
    expect(prompt).toContain('a.md: desc')
    expect(prompt).toContain('user` | `feedback` | `project` | `reference`')
  })
})

describe('buildConsolidationPrompt', () => {
  it('lists the sessions to review and restricts writes to memory', () => {
    const prompt = buildConsolidationPrompt('/mem', '/transcripts', ['s1', 's2'])
    expect(prompt).toContain('`/mem`')
    expect(prompt).toContain('`/transcripts`')
    expect(prompt).toContain('- s1')
    expect(prompt).toContain('- s2')
    expect(prompt).toContain('Read, Grep, Glob, Write, Edit')
  })
})
