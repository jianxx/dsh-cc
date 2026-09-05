import { describe, expect, it } from 'vitest'
import {
  STATUSLINE_SETTINGS_NAMESPACE,
  describeStatusLine,
  statusLineSectionSchema,
} from '../src/harness/statusline-settings.ts'

describe('statusline settings namespace', () => {
  it('is the kebab-case `statusline` namespace', () => {
    expect(STATUSLINE_SETTINGS_NAMESPACE).toBe('statusline')
  })
})

describe('section schema', () => {
  it('resolves a full CC-shaped section with unknown keys passthrough', () => {
    const section = statusLineSectionSchema({
      type: 'command',
      command: 'echo hi',
      padding: 2,
      refreshInterval: 10,
      hideVimModeIndicator: false,
      // CC-ecosystem keys dsh-cc does not interpret must survive.
      someFutureKey: { nested: true },
    } as never)
    expect(section).toMatchObject({ type: 'command', command: 'echo hi', padding: 2 })
    expect((section as Record<string, unknown>).someFutureKey).toEqual({ nested: true })
  })

  it('resolves an empty/partial section without rejecting', () => {
    expect(statusLineSectionSchema({} as never)).toEqual({})
    expect(statusLineSectionSchema(undefined as never)).toEqual({})
  })
})

describe('describeStatusLine activation matrix', () => {
  it('activates on type command + non-empty command', () => {
    expect(describeStatusLine({ type: 'command', command: 'echo hi' })).toEqual({
      active: true,
      command: 'echo hi',
      padding: 0,
    })
  })

  it('is inert for other type values', () => {
    expect(describeStatusLine({ type: 'script', command: 'echo hi' })).toEqual({ active: false })
  })

  it('is inert for a missing or empty command', () => {
    expect(describeStatusLine({ type: 'command' })).toEqual({ active: false })
    expect(describeStatusLine({ type: 'command', command: '' })).toEqual({ active: false })
    expect(describeStatusLine({ type: 'command', command: '   ' })).toEqual({ active: false })
  })

  it('is inert for a missing or non-string command', () => {
    expect(describeStatusLine({ type: 'command', command: 42 })).toEqual({ active: false })
    expect(describeStatusLine({})).toEqual({ active: false })
  })

  it('clamps negative padding to 0 and defaults padding to 0', () => {
    expect(describeStatusLine({ type: 'command', command: 'c', padding: -3 })).toMatchObject({ padding: 0 })
    expect(describeStatusLine({ type: 'command', command: 'c', padding: 1.5 })).toMatchObject({ padding: 1.5 })
    expect(describeStatusLine({ type: 'command', command: 'c' })).toMatchObject({ padding: 0 })
  })

  it('keeps refreshInterval in SECONDS and clamps below 1 to 1', () => {
    expect(describeStatusLine({ type: 'command', command: 'c', refreshInterval: 10 }))
      .toMatchObject({ refreshIntervalSec: 10 })
    expect(describeStatusLine({ type: 'command', command: 'c', refreshInterval: 0.2 }))
      .toMatchObject({ refreshIntervalSec: 1 })
    expect(describeStatusLine({ type: 'command', command: 'c', refreshInterval: -5 }))
      .toMatchObject({ refreshIntervalSec: 1 })
    // Absent → no timer.
    const absent = describeStatusLine({ type: 'command', command: 'c' })
    expect('refreshIntervalSec' in absent).toBe(false)
  })

  it('carries hideVimModeIndicator when set', () => {
    expect(describeStatusLine({ type: 'command', command: 'c', hideVimModeIndicator: true }))
      .toMatchObject({ hideVimModeIndicator: true })
    const without = describeStatusLine({ type: 'command', command: 'c' })
    expect('hideVimModeIndicator' in without).toBe(false)
  })
})
