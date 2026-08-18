import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@jianxx/dsh-cc-tools'
import { FakeMemoryFs } from './helpers.ts'
import {
  MEMORY_SAVE_TOOL,
  registerMemorySaveTool,
  renderTopicFile,
  upsertPointer,
} from '../src/save.ts'
import type { MemorySection } from '../src/section.ts'

/**
 * The `memory_save` tool over a bare ToolRuntime with the in-memory fs: the
 * model-facing save channel must generate frontmatter, maintain the MEMORY.md
 * pointer, write host-side under the confined per-call policy, and refresh the
 * section — while rejecting invalid input with zero writes.
 */

const DIR = '/mem'

async function setup(seed: Record<string, string> = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeMemoryFs)
  const fs = ctx.fs as unknown as FakeMemoryFs
  for (const [path, content] of Object.entries(seed)) fs.seed(path, content)
  const section = { refresh: vi.fn(async () => {}) }
  const dispose = registerMemorySaveTool(ctx, DIR, section as unknown as MemorySection)
  return { ctx, fs, section, dispose }
}

let callCounter = 0
function call(ctx: Context, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`call-${++callCounter}`),
    name: MEMORY_SAVE_TOOL,
    arguments: args,
  })
}

const VALID = {
  name: 'user-profile',
  type: 'user',
  description: 'principal engineer, Chinese communication',
  body: '- works on dsh plugins\n',
}

describe('renderTopicFile / upsertPointer (pure)', () => {
  it('renders rationalized frontmatter above the trimmed body', () => {
    expect(renderTopicFile(VALID)).toBe(
      '---\nname: user-profile\ndescription: principal engineer, Chinese communication\ntype: user\n---\n\n- works on dsh plugins\n',
    )
  })

  it('appends a pointer to an empty or populated index', () => {
    expect(upsertPointer('', VALID)).toBe('- [user-profile](user-profile.md) — principal engineer, Chinese communication\n')
    const existing = '- [other](other.md) — o\n'
    expect(upsertPointer(existing, VALID)).toBe(
      '- [other](other.md) — o\n- [user-profile](user-profile.md) — principal engineer, Chinese communication\n',
    )
  })

  it('replaces the pointer line for the same topic', () => {
    const existing = '- [user-profile](user-profile.md) — old description\n- [other](other.md) — o\n'
    expect(upsertPointer(existing, VALID)).toBe(
      '- [user-profile](user-profile.md) — principal engineer, Chinese communication\n- [other](other.md) — o\n',
    )
  })
})

describe('memory_save tool', () => {
  it('registers under the tools service with the structured parameters', async () => {
    const { ctx, dispose } = await setup()
    expect(dispose).toBeTypeOf('function')
    const tool = ctx.tools.get(MEMORY_SAVE_TOOL)!
    expect(tool.description).toContain('ONLY')
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain(MEMORY_SAVE_TOOL)
  })

  it('writes the topic file and index host-side under the confined policy, then refreshes', async () => {
    const { ctx, fs, section } = await setup()
    const writeSpy = vi.spyOn(fs, 'writeText')

    const result = await call(ctx, VALID)

    expect(result.isError).toBeFalsy()
    expect(fs.backingText(`${DIR}/user-profile.md`)).toBe(renderTopicFile(VALID))
    expect(fs.backingText(`${DIR}/MEMORY.md`)).toBe('- [user-profile](user-profile.md) — principal engineer, Chinese communication\n')
    for (const callArgs of writeSpy.mock.calls) {
      expect(callArgs[4]).toEqual({ mode: 'workspace-write', workspaceRoot: DIR })
    }
    expect(section.refresh).toHaveBeenCalledTimes(1)
  })

  it('re-saving the same name replaces its pointer line instead of duplicating it', async () => {
    const { ctx, fs } = await setup({
      [`${DIR}/MEMORY.md`]: '- [user-profile](user-profile.md) — old\n',
    })

    const result = await call(ctx, VALID)

    expect(result.isError).toBeFalsy()
    expect(fs.backingText(`${DIR}/MEMORY.md`)).toBe('- [user-profile](user-profile.md) — principal engineer, Chinese communication\n')
  })

  it('rejects invalid input with an error result and zero writes', async () => {
    const cases = [
      { ...VALID, name: '../escape' },
      { ...VALID, name: 'Memory' }, // reserved, case-insensitive
      { ...VALID, name: 'has_underscore' },
      { ...VALID, type: 'task' },
      { ...VALID, description: 'two\nlines' },
      { ...VALID, description: 'x'.repeat(201) },
      { ...VALID, body: '   ' },
    ]
    for (const args of cases) {
      const { ctx, fs, section } = await setup()
      const result = await call(ctx, args)
      expect(result.isError).toBe(true)
      expect(fs.backingSize()).toBe(0)
      expect(section.refresh).not.toHaveBeenCalled()
    }
  })

  it('is not registered when the host has no tools service', () => {
    const ctx = new Context()
    const section = { refresh: vi.fn(async () => {}) }
    expect(registerMemorySaveTool(ctx, DIR, section as unknown as MemorySection)).toBeUndefined()
  })
})
