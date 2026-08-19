import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { defaultDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { cwdOf, projectSlug, resolveMemoryHome, resolveWorkspaceMemoryDir } from '../src/paths.ts'

/**
 * Regression coverage for the default memdir resolution: the default must be
 * `<dsh home>/memory`, NEVER the harness home itself. `apply()` regressed this
 * once by forwarding `defaultDshHome()` as the configured root, which pinned
 * memory writes (MEMORY.md and topic files) into the harness home root.
 */
describe('resolveMemoryHome', () => {
  it('resolves the default to the memory subdirectory of the harness home', () => {
    expect(resolveMemoryHome(undefined)).toBe(join(defaultDshHome(), 'memory'))
    expect(resolveMemoryHome('')).toBe(join(defaultDshHome(), 'memory'))
  })

  it('never returns the bare harness home', () => {
    expect(resolveMemoryHome(undefined)).not.toBe(defaultDshHome())
  })

  it('honors an explicit root verbatim', () => {
    expect(resolveMemoryHome('/tmp/mem')).toBe('/tmp/mem')
  })
})

/**
 * The workspace slug is ported from upstream `projectKey`
 * (session-persistence-jsonl) minus the `--` wrapper, so a workspace's memory
 * directory matches its session-transcript grouping.
 */
describe('projectSlug', () => {
  it('collapses separators and drive colons to single dashes', () => {
    expect(projectSlug('/Users/x/work/repo')).toBe('Users-x-work-repo')
    expect(projectSlug('C:\\src\\repo')).toBe('C-src-repo')
    expect(projectSlug('/a//b\\\\c')).toBe('a-b-c')
  })

  it('strips leading dashes and falls back to root', () => {
    expect(projectSlug('/')).toBe('root')
    expect(projectSlug('')).toBe('root')
  })

  it('escapes unsafe code units as ~XXXX', () => {
    expect(projectSlug('/a b/c')).toBe('a~0020b-c')
    expect(projectSlug('/a~b')).toBe('a~007Eb')
  })

  it('keeps dots, underscores and dashes readable', () => {
    expect(projectSlug('/x/y_z.q-r')).toBe('x-y_z.q-r')
  })

  it('truncates to 251 chars', () => {
    const slug = projectSlug(`/${'a'.repeat(300)}`)
    expect(slug.length).toBe(251)
  })
})

describe('resolveWorkspaceMemoryDir', () => {
  it('nests the workspace slug under <home>/projects', () => {
    expect(resolveWorkspaceMemoryDir('/mem', '/work/repo')).toBe('/mem/projects/work-repo')
  })
})

describe('cwdOf', () => {
  it('prefers the session header cwd and falls back to the process cwd', () => {
    const agent = { session: { header: { cwd: '/work/repo' } } } as unknown as Agent
    expect(cwdOf(agent)).toBe('/work/repo')
    const bare = { session: { header: {} } } as unknown as Agent
    expect(cwdOf(bare)).toBe(process.cwd())
  })
})
