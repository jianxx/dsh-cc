import { describe, expect, it } from 'vitest'
import { DEFAULT_DSH_PROFILE, DSH_PROFILE_ENV, resolveDshProfile } from '../src/profile.ts'

describe('resolveDshProfile', () => {
  it('returns tui when the env var is missing', () => {
    expect(resolveDshProfile({})).toBe('tui')
  })

  it('returns tui when the env var is an empty string', () => {
    expect(resolveDshProfile({ [DSH_PROFILE_ENV]: '' })).toBe('tui')
  })

  it('returns tui when the env var is tui', () => {
    expect(resolveDshProfile({ [DSH_PROFILE_ENV]: 'tui' })).toBe('tui')
  })

  it('returns the env value for other profiles', () => {
    expect(resolveDshProfile({ [DSH_PROFILE_ENV]: 'other' })).toBe('other')
  })

  it('defaults to tui', () => {
    expect(DEFAULT_DSH_PROFILE).toBe('tui')
  })
})
