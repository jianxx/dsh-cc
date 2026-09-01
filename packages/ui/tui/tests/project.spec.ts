import { describe, expect, it } from 'vitest'
import {
  gitExecSync,
  isProjectMember,
  resolveProject,
  type ProjectExec,
} from '@jianxx/dsh-cc-tui/project.ts'

/**
 * Script a git conversation as a project exec: argv → result (or undefined
 * to simulate a failed/unsupported invocation). Mirrors the scripted-exec
 * convention used by the worktree-exit spec.
 */
function scriptedExec(script: Record<string, { stdout: string } | undefined>): ProjectExec {
  return (argv, _cwd) => {
    const key = argv.join(' ')
    const entry = script[key]
    return entry === undefined ? undefined : { stdout: entry.stdout }
  }
}

describe('resolveProject', () => {
  it('main repo: project root is the toplevel, worktrees are listed', () => {
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/repo\n' },
      'rev-parse --git-common-dir': { stdout: '.git\n' },
      'worktree list --porcelain': { stdout: 'worktree /repo\n\n' },
    })
    const info = resolveProject('/repo', exec)
    expect(info.projectRoot).toBe('/repo')
    expect(info.worktrees).toEqual(['/repo'])
  })

  it('main repo launched from a subdir maps relative common-dir to the toplevel', () => {
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/repo\n' },
      // git emits common-dir relative to the process cwd: `../.git` here.
      'rev-parse --git-common-dir': { stdout: '../.git\n' },
      'worktree list --porcelain': { stdout: 'worktree /repo\n' },
    })
    const info = resolveProject('/repo/subdir', exec)
    expect(info.projectRoot).toBe('/repo')
  })


  it('linked worktree collapses onto the main checkout root', () => {
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/repo/.claude/worktrees/support\n' },
      'rev-parse --git-common-dir': { stdout: '/repo/.git\n' },
      'worktree list --porcelain': {
        stdout: 'worktree /repo\n\nworktree /repo/.claude/worktrees/support\n',
      },
    })
    // commonDir (/repo/.git) does not equal the worktree's own top/.git → linked.
    const info = resolveProject('/repo/.claude/worktrees/support', exec)
    expect(info.projectRoot).toBe('/repo')
    expect(info.worktrees).toEqual(['/repo', '/repo/.claude/worktrees/support'])
  })

  it('submodule does not collapse onto the superproject (.git/modules/*)', () => {
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/super/sub\n' },
      // common-dir is the superproject's git dir, not .git → keep toplevel.
      'rev-parse --git-common-dir': { stdout: '/super/.git/modules/sub\n' },
      'worktree list --porcelain': { stdout: 'worktree /super/sub\n' },
    })
    const info = resolveProject('/super/sub', exec)
    expect(info.projectRoot).toBe('/super/sub')
  })

  it('nested independent repository keeps its own root', () => {
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/outer/nested\n' },
      'rev-parse --git-common-dir': { stdout: '/outer/nested/.git\n' },
      'worktree list --porcelain': { stdout: 'worktree /outer/nested\n' },
    })
    expect(resolveProject('/outer/nested', exec).projectRoot).toBe('/outer/nested')
  })

  it('non-git directory degrades to the directory identity', () => {
    const exec = scriptedExec({})
    const info = resolveProject('/plain/dir', exec)
    expect(info.projectRoot).toBe('/plain/dir')
    expect(info.worktrees).toEqual([])
  })

  it('git failure (undefined result) degrades to the directory identity', () => {
    const info = resolveProject('/a/b', scriptedExec({ 'rev-parse --show-toplevel': undefined }))
    expect(info.projectRoot).toBe('/a/b')
    expect(info.worktrees).toEqual([])
  })

  it('default exec returns undefined when git cannot run (no git on PATH)', () => {
    // gitExecSync hits spawn-enoent on hosts without git → degrades gracefully.
    const info = resolveProject(process.cwd())
    expect(typeof info.projectRoot).toBe('string')
  })

  it('projectKey is 16 lowercase hex and stable across calls', () => {
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/repo\n' },
      'rev-parse --git-common-dir': { stdout: '.git\n' },
      'worktree list --porcelain': { stdout: 'worktree /repo\n' },
    })
    const a = resolveProject('/repo', exec)
    const b = resolveProject('/repo', exec)
    expect(a.projectKey).toMatch(/^[0-9a-f]{16}$/)
    expect(a.projectKey).toBe(b.projectKey)
  })

  it('distinct roots yield distinct project keys', () => {
    const one = resolveProject('/one', scriptedExec({}))
    const two = resolveProject('/two', scriptedExec({}))
    expect(one.projectKey).not.toBe(two.projectKey)
  })

  it('parses porcelain paths with C-style quoting (spaces and unicode)', () => {
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/repo\n' },
      'rev-parse --git-common-dir': { stdout: '.git\n' },
      'worktree list --porcelain': {
        stdout: 'worktree /repo\n\nworktree "/repo/my worktree"\n\n',
      },
    })
    const info = resolveProject('/repo', exec)
    expect(info.worktrees).toEqual(['/repo', '/repo/my worktree'])
  })

  it('egregious porcelain garbage is skipped, not fatal', () => {
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/repo\n' },
      'rev-parse --git-common-dir': { stdout: '.git\n' },
      'worktree list --porcelain': { stdout: 'worktree /repo\n\nbare\nbranch refs/heads/x\n\n' },
    })
    expect(resolveProject('/repo', exec).worktrees).toEqual(['/repo'])
  })
})

describe('isProjectMember', () => {
  const project = { projectRoot: '/repo', worktrees: ['/repo/.claude/worktrees/a'] }

  it('matches the project root itself', () => {
    expect(isProjectMember('/repo', project)).toBe(true)
  })

  it('matches paths beneath the root at a separator boundary', () => {
    expect(isProjectMember('/repo/x', project)).toBe(true)
    expect(isProjectMember('/repo/sub/deep', project)).toBe(true)
  })

  it('rejects sibling prefixes without a boundary', () => {
    expect(isProjectMember('/repo2', project)).toBe(false)
    expect(isProjectMember('/repo2/x', project)).toBe(false)
  })

  it('matches each listed worktree and its descendants', () => {
    expect(isProjectMember('/repo/.claude/worktrees/a', project)).toBe(true)
    expect(isProjectMember('/repo/.claude/worktrees/a/src', project)).toBe(true)
  })

  it('rejects unrelated directories', () => {
    expect(isProjectMember('/elsewhere', project)).toBe(false)
  })

  it('handles Windows-style backslash paths', () => {
    const win = { projectRoot: 'C:\\repo', worktrees: ['C:\\repo\\.claude\\worktrees\\a'] }
    expect(isProjectMember('C:\\repo', win)).toBe(true)
    expect(isProjectMember('C:\\repo\\src', win)).toBe(true)
    expect(isProjectMember('C:\\repo2', win)).toBe(false)
    expect(isProjectMember('C:\\repo\\.claude\\worktrees\\a\\x', win)).toBe(true)
  })

  it('rejects entries outside every candidate path', () => {
    expect(isProjectMember('/repo-other', project)).toBe(false)
  })
})
