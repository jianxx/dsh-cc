import { describe, expect, it } from 'vitest'
import { bootstrapCommand, interceptResume, PROFILE } from '../bootstrap.mjs'

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
})
