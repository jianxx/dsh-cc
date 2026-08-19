import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scanMemoryDirectory } from '../src/scan.ts'
import { MemorySection, renderMemorySection } from '../src/section.ts'
import { FakeMemoryFs } from './helpers.ts'

async function mountedFs(): Promise<{ fs: FakeMemoryFs }> {
  const ctx = new Context()
  await ctx.plugin(FakeMemoryFs)
  return { fs: ctx.fs as FakeMemoryFs }
}

describe('scanMemoryDirectory', () => {
  it('reads the entrypoint and frontmatter-valid topic files', async () => {
    const { fs } = await mountedFs()
    fs.seed('/root/MEMORY.md', '- [User role](user_role.md) — principal\n')
    fs.seed('/root/user_role.md', '---\nname: user role\ndescription: principal engineer\ntype: user\n---\nbody\n')
    fs.seed('/root/feedback_testing.md', '---\nname: testing\ndescription: no mocks\ntype: feedback\n---\nrule\n')
    const state = await scanMemoryDirectory(fs, '/root')
    expect(state.entrypoint).toContain('- [User role](user_role.md)')
    expect(state.topics.map(t => t.filename).sort()).toEqual(['feedback_testing.md', 'user_role.md'])
    expect(state.topics[0]?.frontmatter.name).toBe('testing')
  })

  it('returns an empty state for a missing directory', async () => {
    const { fs } = await mountedFs()
    const state = await scanMemoryDirectory(fs, '/missing')
    expect(state.entrypoint).toBeUndefined()
    expect(state.topics).toEqual([])
  })

  it('ignores non-markdown files and topics with broken frontmatter', async () => {
    const { fs } = await mountedFs()
    fs.seed('/root/notes.txt', 'not a memory')
    fs.seed('/root/broken.md', 'no frontmatter here')
    fs.seed('/root/good.md', '---\nname: a\ndescription: b\n---\nbody')
    const state = await scanMemoryDirectory(fs, '/root')
    expect(state.topics).toHaveLength(1)
    expect(state.topics[0]?.filename).toBe('good.md')
  })
})

describe('renderMemorySection', () => {
  it('renders entry content, an index, and search guidance', async () => {
    const { fs } = await mountedFs()
    fs.seed('/ws/MEMORY.md', '- [User role](user_role.md) — principal\n')
    fs.seed('/ws/user_role.md', '---\nname: user role\ndescription: principal engineer\ntype: user\n---\nbody\n')
    const state = await scanMemoryDirectory(fs, '/ws')
    const rendered = renderMemorySection('/global', '/ws', undefined, state)
    expect(rendered).toContain('# Memory')
    expect(rendered).toContain('## MEMORY.md (this workspace)')
    expect(rendered).toContain('## MEMORY.md (global)')
    expect(rendered).toContain('- [User role](user_role.md) — principal')
    expect(rendered).toContain('## Memory index')
    expect(rendered).toContain('- [user role](user_role.md) — principal engineer (workspace) [user]')
    expect(rendered).toContain('## Searching past context')
    expect(rendered).toContain('grep -rn "<search term>" /ws/ --include="*.md"')
  })

  it('always renders with save guidance and placeholders when memoryless', async () => {
    const { fs } = await mountedFs()
    fs.seed('/ws/user_role.md', '---\nname: a\ndescription: b\n---\nbody\n')
    const state = await scanMemoryDirectory(fs, '/ws')
    const rendered = renderMemorySection('/global', '/ws', undefined, state)
    expect(rendered).toContain('# Memory')
    expect(rendered).toContain('memory_save')
    expect(rendered).toContain('(no memories yet)')
    expect(rendered).toContain('`/global`')
    expect(rendered).toContain('`/ws`')
    expect(rendered).toContain('scope: "global"')
  })

  it('renders an empty index when only the entrypoint exists', async () => {
    const { fs } = await mountedFs()
    fs.seed('/ws/MEMORY.md', 'No memories yet.\n')
    const state = await scanMemoryDirectory(fs, '/ws')
    const rendered = renderMemorySection('/global', '/ws', undefined, state)
    expect(rendered).toContain('## MEMORY.md (this workspace)')
    expect(rendered).not.toContain('## Memory index')
    expect(rendered).not.toContain('## Searching past context')
  })

  it('keeps the workspace and global layers distinct', async () => {
    const { fs } = await mountedFs()
    fs.seed('/ws/MEMORY.md', '- [ws topic](ws.md) — here\n')
    fs.seed('/global/MEMORY.md', '- [global topic](g.md) — everywhere\n')
    const wsState = await scanMemoryDirectory(fs, '/ws')
    const globalState = await scanMemoryDirectory(fs, '/global')
    const rendered = renderMemorySection('/global', '/ws', globalState, wsState)
    expect(rendered).toContain('- [ws topic](ws.md) — here')
    expect(rendered).toContain('- [global topic](g.md) — everywhere')
  })
})

/**
 * The mounted MemorySection serves every agent from ONE registration: the
 * text callback receives the assembling agent through the assemble scope and
 * renders that agent's workspace layer, so two workspaces never see each
 * other's memories.
 */
describe('MemorySection (per-agent rendering)', () => {
  const agentAt = (cwd: string): Agent => ({ session: { header: { cwd } } }) as unknown as Agent

  async function setup() {
    const ctx = new Context()
    await ctx.plugin(FakeMemoryFs)
    const fs = ctx.fs as unknown as FakeMemoryFs
    let textFn: ((context: { scope?: unknown }) => string) | undefined
    ctx.provide('systemPrompt' as never, {
      section: (def: { text: (context: { scope?: unknown }) => string }) => { textFn = def.text },
    } as never)
    const changes = vi.fn()
    ctx.on('system-prompt/change' as never, changes)
    const section = new MemorySection(ctx, '/mem')
    const text = (scope?: unknown) => {
      if (textFn === undefined) throw new Error('section text callback not captured')
      return textFn({ scope })
    }
    // Seed FIRST, then start: start()'s immediate global scan must not race
    // the test's seeds.
    const start = () => section.start()
    return { ctx, fs, section, text, changes, start }
  }

  it('renders each agent its own workspace layer plus the shared global layer', async () => {
    const { ctx, fs, section, text, start } = await setup()
    fs.seed('/mem/projects/work-repo-a/MEMORY.md', '- [alpha](alpha.md) — A\n')
    fs.seed('/mem/projects/work-repo-b/MEMORY.md', '- [beta](beta.md) — B\n')
    fs.seed('/mem/MEMORY.md', '- [shared](shared.md) — G\n')
    start()
    const agentA = agentAt('/work/repo-a')
    const agentB = agentAt('/work/repo-b')
    await section.refresh(agentA)
    await section.refresh(agentB)

    const textA = text(agentA)
    expect(textA).toContain('- [alpha](alpha.md) — A')
    expect(textA).toContain('- [shared](shared.md) — G')
    expect(textA).not.toContain('- [beta](beta.md) — B')
    const textB = text(agentB)
    expect(textB).toContain('- [beta](beta.md) — B')
    expect(textB).toContain('- [shared](shared.md) — G')
    expect(textB).not.toContain('- [alpha](alpha.md) — A')
    await ctx.fiber.dispose()
  })

  it('renders only the global layer when the assemble scope carries no agent', async () => {
    const { ctx, fs, section, text, start } = await setup()
    fs.seed('/mem/MEMORY.md', '- [shared](shared.md) — G\n')
    start()
    await section.refresh()

    const rendered = text()
    expect(rendered).toContain('# Memory')
    expect(rendered).toContain('memory_save')
    expect(rendered).toContain('- [shared](shared.md) — G')
    expect(rendered).not.toContain('/mem/projects/')
    await ctx.fiber.dispose()
  })

  it('emits system-prompt/change only when a layer fragment changes', async () => {
    const { ctx, fs, section, text, changes, start } = await setup()
    fs.seed('/mem/projects/work-repo-a/MEMORY.md', '- [alpha](alpha.md) — A\n')
    start()
    const agentA = agentAt('/work/repo-a')
    await section.refresh(agentA)
    const emitted = changes.mock.calls.length
    expect(emitted).toBeGreaterThan(0)
    expect(text(agentA)).toContain('- [alpha](alpha.md) — A')

    // Unchanged disk: no further emission.
    await section.refresh(agentA)
    expect(changes.mock.calls.length).toBe(emitted)

    // A host-side write: the next refresh emits again.
    fs.seed('/mem/projects/work-repo-a/MEMORY.md', '- [alpha](alpha.md) — A2\n')
    await section.refresh(agentA)
    expect(changes.mock.calls.length).toBeGreaterThan(emitted)
    expect(text(agentA)).toContain('- [alpha](alpha.md) — A2')
    await ctx.fiber.dispose()
  })

  it('triggers a lazy scan on first render of an unknown workspace', async () => {
    const { ctx, fs, text, start } = await setup()
    fs.seed('/mem/projects/work-repo-a/MEMORY.md', '- [alpha](alpha.md) — A\n')
    start()
    const agentA = agentAt('/work/repo-a')

    // First render: placeholders plus guidance; the lazy scan kicks off.
    const first = text(agentA)
    expect(first).toContain('(no memories yet)')
    expect(first).toContain('memory_save')
    await vi.waitFor(() => expect(text(agentA)).toContain('- [alpha](alpha.md) — A'))
    await ctx.fiber.dispose()
  })
})
