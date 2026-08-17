import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsObservation, FsTarget, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import {
  ccPathMatcher,
  ccRestriction,
  registerPathActivator,
} from '../src/translate.ts'

describe('ccRestriction', () => {
  it('builds a harness allow restriction from CC tool names', () => {
    expect(ccRestriction(['Read', 'Grep', 'Glob'])).toEqual({
      allow: ['read', 'read_image', 'grep', 'glob'],
    })
  })

  it('strips arg-spec parens from Bash names', () => {
    expect(ccRestriction(['Bash(git status)'])).toEqual({ allow: ['bash'] })
  })

  it('returns undefined when every name is dropped, with a diagnostic', () => {
    const diagnostics: string[] = []
    expect(ccRestriction(['mcp__github__foo'], (m) => diagnostics.push(m))).toBeUndefined()
    expect(diagnostics.length).toBeGreaterThan(0)
  })

  it('passes already-known harness names through', () => {
    expect(ccRestriction(['read', 'grep'])).toEqual({ allow: ['read', 'grep'] })
  })

  it('returns undefined for an empty or match-all list', () => {
    expect(ccRestriction([])).toBeUndefined()
    expect(ccRestriction(['*'])).toBeUndefined()
  })

  it('returns undefined when no tools are declared', () => {
    expect(ccRestriction(undefined)).toBeUndefined()
  })
})

describe('ccPathMatcher', () => {
  it('matches a directory prefix pattern against relative paths', () => {
    const match = ccPathMatcher(['src'])
    expect(match('src/app.ts')).toBe(true)
    expect(match('lib/app.ts')).toBe(false)
  })

  it('supports ** globs', () => {
    const match = ccPathMatcher(['docs/**'])
    expect(match('docs/a/b.md')).toBe(true)
    expect(match('src/a.ts')).toBe(false)
  })

  it('supports a specific file pattern', () => {
    const match = ccPathMatcher(['package.json'])
    expect(match('package.json')).toBe(true)
    expect(match('other.json')).toBe(false)
  })

  it('matches nested paths beneath a directory without trailing /**', () => {
    const match = ccPathMatcher(['src'])
    expect(match('src/deep/nested/file.ts')).toBe(true)
  })
})

describe('registerPathActivator', () => {
  function target(path: string): FsTarget {
    return { targetKey: FsTargetKey(path), displayPath: path }
  }
  function observation(): FsObservation {
    return { kind: 'present', version: FsVersion('1') }
  }
  function actor(name: string): object {
    return { name }
  }

  it('activates matching skills on read, write, and edit', async () => {
    const ctx: Context = new Context()
    const activated: string[] = []
    const dispose = registerPathActivator(ctx, {
      projects: [{ root: '/proj', matcher: ccPathMatcher(['src']), skillNames: ['demo'] }],
      onActivate(name) {
        activated.push(name)
      },
    })
    ctx.emit('fs/observed', target('/proj/src/app.ts'), observation(), actor('read'))
    ctx.emit('fs/observed', target('/proj/src/app.ts'), observation(), actor('write'))
    ctx.emit('fs/observed', target('/proj/src/app.ts'), observation(), actor('edit'))
    expect(activated).toEqual(['demo', 'demo', 'demo'])
    dispose()
  })

  it('ignores touches that do not match the path patterns', async () => {
    const ctx: Context = new Context()
    const activated: string[] = []
    const dispose = registerPathActivator(ctx, {
      projects: [{ root: '/proj', matcher: ccPathMatcher(['src']), skillNames: ['demo'] }],
      onActivate(name) {
        activated.push(name)
      },
    })
    ctx.emit('fs/observed', target('/proj/lib/other.ts'), observation(), actor('read'))
    expect(activated).toEqual([])
    dispose()
  })

  it('does not activate for tools other than reading/writing/editing', async () => {
    const ctx: Context = new Context()
    const activated: string[] = []
    const dispose = registerPathActivator(ctx, {
      projects: [{ root: '/proj', matcher: ccPathMatcher(['src']), skillNames: ['demo'] }],
      onActivate(name) {
        activated.push(name)
      },
    })
    ctx.emit('fs/observed', target('/proj/src/app.ts'), observation(), actor('bash'))
    expect(activated).toEqual([])
    dispose()
  })
})
