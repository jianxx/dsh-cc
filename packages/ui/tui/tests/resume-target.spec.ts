import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  clearResumeTarget,
  readResumeTarget,
  writeResumeTarget,
} from '@jianxx/dsh-cc-tui/resume-target.ts'

describe('resume target file', () => {
  it('round-trips a session id under a given home', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-'))
    writeResumeTarget('sess-abc', { home })
    expect(readResumeTarget({ home })).toBe('sess-abc')
    expect(readFileSync(join(home, 'resume.txt'), 'utf8').trim()).toBe('sess-abc')
  })

  it('returns undefined after clear and for a missing file', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-'))
    expect(readResumeTarget({ home })).toBeUndefined()
    writeResumeTarget('sess-abc', { home })
    clearResumeTarget({ home })
    expect(readResumeTarget({ home })).toBeUndefined()
  })

  it('trims whitespace and ignores a blank marker', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-'))
    writeFileSync(join(home, 'resume.txt'), '  sess-xyz  \n')
    expect(readResumeTarget({ home })).toBe('sess-xyz')
    writeFileSync(join(home, 'resume.txt'), '   \n')
    expect(readResumeTarget({ home })).toBeUndefined()
  })
})
