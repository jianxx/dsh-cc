import { describe, expect, it } from 'vitest'
import {
  flattenSlug,
  parseWorktreeFlag,
  planWorktree,
  randomWorktreeSlug,
  slugRetryDecision,
  validateWorktreeSlug,
  WORKTREE_ENV,
  worktreeAddArgv,
  worktreeBranch,
  worktreeEnv,
  worktreePathFor,
} from '../bootstrap.mjs'

describe('parseWorktreeFlag', () => {
  it('reports undefined when the flag is absent and forwards everything', () => {
    expect(parseWorktreeFlag(['--verbose', 'x'])).toEqual({ name: undefined, args: ['--verbose', 'x'] })
  })

  it('parses a bare --worktree as a random-name request', () => {
    expect(parseWorktreeFlag(['--worktree'])).toEqual({ name: null, args: [] })
  })

  it('parses --worktree <name> and forwards the rest', () => {
    expect(parseWorktreeFlag(['--worktree', 'feat', '--verbose']))
      .toEqual({ name: 'feat', args: ['--verbose'] })
  })

  it('does not swallow a following flag as the name', () => {
    expect(parseWorktreeFlag(['--worktree', '--new'])).toEqual({ name: null, args: ['--new'] })
  })

  it('parses --worktree=<name>', () => {
    expect(parseWorktreeFlag(['--worktree=feat'])).toEqual({ name: 'feat', args: [] })
  })

  it('treats --worktree= (empty value) as a random-name request', () => {
    expect(parseWorktreeFlag(['--worktree='])).toEqual({ name: null, args: [] })
  })
})

// These cases mirror packages/workspace/tool-git-worktree/tests/worktree.spec.ts —
// the launcher duplicates the slug rules (plain JS, no TS import) and parity is
// locked by testing the same inputs here.
describe('validateWorktreeSlug (parity with tool-git-worktree)', () => {
  it('accepts nested slugs and common names', () => {
    expect(() => validateWorktreeSlug('feat')).not.toThrow()
    expect(() => validateWorktreeSlug('user/feature-x.1')).not.toThrow()
  })

  it('rejects traversal and empty segments', () => {
    for (const bad of ['../escape', '.', 'a//b', '/lead', 'trail/', '']) {
      expect(() => validateWorktreeSlug(bad)).toThrow(/invalid worktree name/)
    }
  })

  it('rejects whitespace and overlong names', () => {
    expect(() => validateWorktreeSlug('has space')).toThrow(/invalid worktree name/)
    expect(() => validateWorktreeSlug('x'.repeat(65))).toThrow(/64 characters or fewer/)
  })
})

describe('slug derivations', () => {
  it('flattens, prefixes, and places the path under .claude/worktrees', () => {
    expect(flattenSlug('user/feature')).toBe('user+feature')
    expect(worktreeBranch('user/feature')).toBe('worktree-user+feature')
    expect(worktreePathFor('/repo', 'user/feature')).toBe('/repo/.claude/worktrees/user+feature')
  })

  it('generates slugs in the swift-fox-8f3a shape', () => {
    expect(randomWorktreeSlug(() => 0.999)).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4}$/)
  })
})

describe('planWorktree', () => {
  it('plans a named worktree', () => {
    expect(planWorktree('/repo', 'feat')).toEqual({
      slug: 'feat',
      worktreePath: '/repo/.claude/worktrees/feat',
      branch: 'worktree-feat',
    })
  })

  it('plans a random worktree when name is null and validates it', () => {
    const plan = planWorktree('/repo', null, () => 0.999)
    expect(plan.slug).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4}$/)
    expect(plan.branch).toBe(`worktree-${plan.slug}`)
  })

  it('validates the requested name', () => {
    expect(() => planWorktree('/repo', '../escape')).toThrow(/invalid worktree name/)
  })
})

describe('worktreeAddArgv', () => {
  it('builds the execFile argv with -B and HEAD base', () => {
    expect(worktreeAddArgv({ worktreePath: '/repo/.claude/worktrees/feat', branch: 'worktree-feat' }))
      .toEqual(['worktree', 'add', '-B', 'worktree-feat', '/repo/.claude/worktrees/feat', 'HEAD'])
  })
})

describe('worktreeEnv', () => {
  it('carries the session descriptor as JSON', () => {
    const env = worktreeEnv(
      { worktreePath: '/repo/.claude/worktrees/feat', branch: 'worktree-feat' },
      '/repo',
      'abc123',
    )
    expect(Object.keys(env)).toEqual([WORKTREE_ENV])
    expect(JSON.parse(env[WORKTREE_ENV])).toEqual({
      repoRoot: '/repo',
      worktreePath: '/repo/.claude/worktrees/feat',
      branch: 'worktree-feat',
      baseHead: 'abc123',
    })
  })
})

describe('slugRetryDecision', () => {
  it('never retries a user-named slug', () => {
    expect(slugRetryDecision({ named: true, attempt: 1 })).toBe('fail')
    expect(slugRetryDecision({ named: true, attempt: 4 })).toBe('fail')
  })

  it('retries random slugs until the attempt cap', () => {
    expect(slugRetryDecision({ named: false, attempt: 1 })).toBe('retry')
    expect(slugRetryDecision({ named: false, attempt: 4 })).toBe('retry')
    expect(slugRetryDecision({ named: false, attempt: 5 })).toBe('fail')
  })

  it('honours a custom cap', () => {
    expect(slugRetryDecision({ named: false, attempt: 2, maxAttempts: 2 })).toBe('fail')
  })
})
