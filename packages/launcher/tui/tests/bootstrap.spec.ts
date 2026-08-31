import { describe, expect, it } from 'vitest'
import { bootstrapCommand, continueHint, interceptResume, PROFILE } from '../bootstrap.mjs'

describe('dsh-cc launcher bootstrap', () => {
  it('targets the tui profile, not cc', () => {
    expect(PROFILE).toBe('tui')
    const command = bootstrapCommand(false, '0.1.0')
    expect(command).toEqual([
      'plugin',
      '--profile',
      'tui',
      'add',
      '@jianxx/dsh-cc-bundle-permissions@0.1.0',
      '@jianxx/dsh-cc-bundle-shell@0.1.0',
      '@jianxx/dsh-cc-bundle-tui@0.1.0',
    ])
  })

  it('skips install when the profile already exists', () => {
    expect(bootstrapCommand(true, '0.1.0')).toBeUndefined()
  })

  it('lifts --resume into DSH_CC_RESUME_SESSION and does not forward the flag', () => {
    const { env, args } = interceptResume(undefined, ['--resume', 'abc', '--verbose'], { KEEP: '1' })
    expect(env.DSH_CC_RESUME_SESSION).toBe('abc')
    expect(env.KEEP).toBe('1')
    expect(args).toEqual(['--verbose'])
  })

  it('strips -c and leaves the resume env untouched', () => {
    const { env, args } = interceptResume(undefined, ['-c', '--verbose'], { KEEP: '1' })
    expect(env.DSH_CC_RESUME_SESSION).toBeUndefined()
    expect(env.KEEP).toBe('1')
    expect(args).toEqual(['--verbose'])
  })

  it('strips --continue the same way', () => {
    const { env, args } = interceptResume(undefined, ['--continue'], {})
    expect(env.DSH_CC_RESUME_SESSION).toBeUndefined()
    expect(args).toEqual([])
  })

  it('maps --new to the empty-string fresh-session sentinel and strips it', () => {
    const { env, args } = interceptResume(undefined, ['--new'], { KEEP: '1' })
    expect(env.DSH_CC_RESUME_SESSION).toBe('')
    expect(args).toEqual([])
  })

  it('maps -n the same way', () => {
    const { env, args } = interceptResume(undefined, ['-n'], {})
    expect(env.DSH_CC_RESUME_SESSION).toBe('')
    expect(args).toEqual([])
  })

  it('lets --resume win over --new regardless of order', () => {
    for (const rest of [['--resume', 'abc', '--new'], ['--new', '--resume', 'abc']]) {
      const { env, args } = interceptResume(undefined, rest, {})
      expect(env.DSH_CC_RESUME_SESSION).toBe('abc')
      expect(args).toEqual([])
    }
  })

  it('lets --new win over -c regardless of order', () => {
    for (const rest of [['-c', '--new'], ['--new', '-c']]) {
      const { env, args } = interceptResume(undefined, rest, {})
      expect(env.DSH_CC_RESUME_SESSION).toBe('')
      expect(args).toEqual([])
    }
  })

  it('strips every resume-mode flag while passing the rest through', () => {
    const { env, args } = interceptResume(
      undefined,
      ['--continue', '--patch', 'demo', '-n', '-c', '--resume=x'],
      {},
    )
    expect(args).toEqual(['--patch', 'demo'])
    expect(env.DSH_CC_RESUME_SESSION).toBe('x')
  })

  it('reports whether -c/--continue was requested', () => {
    expect(interceptResume(undefined, ['-c'], {}).continueRequested).toBe(true)
    expect(interceptResume(undefined, ['--continue', 'x'], {}).continueRequested).toBe(true)
    expect(interceptResume(undefined, ['--new', '-n'], {}).continueRequested).toBe(false)
  })
})

describe('continue hint decision', () => {
  it('stays silent when a resume target exists', () => {
    expect(continueHint(true, 'abc', 'def')).toBeNull()
    expect(continueHint(true, 'abc', null)).toBeNull()
    expect(continueHint(true, undefined, 'def')).toBeNull()
  })

  it('stays silent when continue was not requested', () => {
    expect(continueHint(false, undefined, null)).toBeNull()
  })

  it('hints when -c is requested but neither env nor marker has a session', () => {
    expect(continueHint(true, undefined, null)).toMatch(/no previous session to continue/i)
    expect(continueHint(true, undefined, '')).toMatch(/no previous session to continue/i)
  })

  it('stays silent when --new already chose a fresh start', () => {
    expect(continueHint(true, '', null)).toBeNull()
    expect(continueHint(true, '', 'def')).toBeNull()
  })
})
