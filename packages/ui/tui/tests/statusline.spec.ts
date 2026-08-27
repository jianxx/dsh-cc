import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatStatusLine } from '@jianxx/dsh-cc-tui/statusline.ts'

describe('formatStatusLine', () => {
  it('joins cwd, short session id, mode, and model', () => {
    const cwd = join(homedir(), 'proj')
    expect(formatStatusLine({
      cwd,
      sessionId: 'tui-56b37bee-41fd-4feb-b270-5988abcd',
      permissionMode: 'acceptEdits',
      model: 'deepseek-v4-flash',
      busy: false,
    })).toBe('~/proj · tui-56b37bee · acceptEdits · deepseek-v4-flash · shift+tab · /quit')
  })

  it('shows a working marker while the agent is busy', () => {
    const line = formatStatusLine({
      cwd: '/tmp/work',
      sessionId: 'abc',
      permissionMode: 'default',
      busy: true,
    })
    expect(line).toContain('working')
    expect(line).toContain('default')
  })

  it('omits absent optional fields', () => {
    expect(formatStatusLine({
      cwd: '/tmp',
      sessionId: 'x',
      permissionMode: 'plan',
      busy: false,
    })).toBe('/tmp · x · plan · shift+tab · /quit')
  })
})
