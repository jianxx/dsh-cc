import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { scanMemoryDirectory } from '../src/scan.ts'
import { renderMemorySection } from '../src/section.ts'
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
    fs.seed('/root/MEMORY.md', '- [User role](user_role.md) — principal\n')
    fs.seed('/root/user_role.md', '---\nname: user role\ndescription: principal engineer\ntype: user\n---\nbody\n')
    const state = await scanMemoryDirectory(fs, '/root')
    const rendered = renderMemorySection('/root', state)
    expect(rendered).toContain('# Memory')
    expect(rendered).toContain('## MEMORY.md')
    expect(rendered).toContain('- [User role](user_role.md) — principal')
    expect(rendered).toContain('## Memory index')
    expect(rendered).toContain('- [user role](user_role.md) — principal engineer [user]')
    expect(rendered).toContain('## Searching past context')
    expect(rendered).toContain('grep -rn "<search term>" /root/ --include="*.md"')
  })

  it('renders empty when there is no entrypoint (memoryless sessions present no section)', async () => {
    const { fs } = await mountedFs()
    fs.seed('/root/user_role.md', '---\nname: a\ndescription: b\n---\nbody\n')
    const state = await scanMemoryDirectory(fs, '/root')
    expect(renderMemorySection('/root', state)).toBe('')
  })

  it('renders an empty index when only the entrypoint exists', async () => {
    const { fs } = await mountedFs()
    fs.seed('/root/MEMORY.md', 'No memories yet.\n')
    const state = await scanMemoryDirectory(fs, '/root')
    const rendered = renderMemorySection('/root', state)
    expect(rendered).toContain('## MEMORY.md')
    expect(rendered).not.toContain('## Memory index')
    expect(rendered).not.toContain('## Searching past context')
  })
})
