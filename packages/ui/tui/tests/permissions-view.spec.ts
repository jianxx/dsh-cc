import { describe, expect, it } from 'vitest'
import { renderPermissions } from '@jianxx/dsh-cc-command-permissions/permissions'
import type { PermissionRuleSet } from '@jianxx/dsh-cc-permission-rules/types'

describe('TUI /permissions listing', () => {
  it('reuses the command renderer so the TUI and /permissions stay aligned', () => {
    const rules: PermissionRuleSet = {
      allow: [{ toolName: 'Read', behavior: 'allow', source: 'userSettings' }],
      deny: [{ toolName: 'Bash', behavior: 'deny', source: 'projectSettings' }],
      ask: [],
      bypassImmune: [],
    }
    const text = renderPermissions(rules, 0)
    expect(text).toContain('Permission rules (read-only)')
    expect(text).toContain('userSettings: allow=1 deny=0 ask=0')
    expect(text).toContain('projectSettings: allow=0 deny=1 ask=0')
    expect(text).toContain('bypassImmune=0')
  })
})
