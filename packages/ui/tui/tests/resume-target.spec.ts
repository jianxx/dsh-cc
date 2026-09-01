import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  clearResumeTarget,
  readResumeTarget,
  resumeMarkerFile,
  writeResumeTarget,
} from '@jianxx/dsh-cc-tui/resume-target.ts'

function markerName(cwd: string): string {
  return `resume-${createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16)}.txt`
}

describe('resume target file', () => {
  it('round-trips a session id under a given home, keyed by cwd', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-'))
    const cwd = '/repo/.claude/worktrees/feat'
    writeResumeTarget('sess-abc', { home, cwd })
    expect(readResumeTarget({ home, cwd })).toBe('sess-abc')
    expect(readFileSync(join(home, markerName(cwd)), 'utf8').trim()).toBe('sess-abc')
    expect(resumeMarkerFile({ home, cwd })).toBe(join(home, markerName(cwd)))
  })

  it('isolates markers across cwds', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-'))
    writeResumeTarget('sess-a', { home, cwd: '/repo/.claude/worktrees/a' })
    writeResumeTarget('sess-b', { home, cwd: '/repo/.claude/worktrees/b' })
    expect(readResumeTarget({ home, cwd: '/repo/.claude/worktrees/a' })).toBe('sess-a')
    expect(readResumeTarget({ home, cwd: '/repo/.claude/worktrees/b' })).toBe('sess-b')
  })

  it('returns undefined after clear and for a missing file', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-'))
    const cwd = '/repo/.claude/worktrees/feat'
    expect(readResumeTarget({ home, cwd })).toBeUndefined()
    writeResumeTarget('sess-abc', { home, cwd })
    clearResumeTarget({ home, cwd })
    expect(readResumeTarget({ home, cwd })).toBeUndefined()
  })

  it('trims whitespace and ignores a blank marker', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-'))
    const cwd = '/repo/.claude/worktrees/feat'
    const file = resumeMarkerFile({ home, cwd })
    writeFileSync(file, '  sess-xyz  \n')
    expect(readResumeTarget({ home, cwd })).toBe('sess-xyz')
    writeFileSync(file, '   \n')
    expect(readResumeTarget({ home, cwd })).toBeUndefined()
  })
})
