import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { collect } from '../src/collect.ts'
import { CLOCK, fakeInvocation } from './helpers.ts'

describe('hooks checks', () => {
  it('skips the bridge when hookBridgeStatus is not mounted', async () => {
    const report = await collect(new Context(), fakeInvocation(), CLOCK)
    expect(report.checks.find(check => check.id === 'hooks.bridge')).toMatchObject({
      status: 'skip',
      summary: 'hookBridgeStatus seam not mounted',
    })
    // The discovery note is always present.
    expect(report.checks.find(check => check.id === 'hooks.discovery')).toMatchObject({ status: 'info' })
  })

  it('maps a healthy status object', async () => {
    const ctx = new Context()
    ctx.provide('hookBridgeStatus', {
      sourcePath: '/repo/.claude/hooks.json',
      events: [{ name: 'PreToolUse', groups: 1, hooks: 2 }],
      skipped: [],
      enablePromptHooks: false,
      enableAgentHooks: false,
    })
    const report = await collect(ctx, fakeInvocation(), CLOCK)
    const byId = new Map(report.checks.map(check => [check.id, check]))
    expect(byId.get('hooks.source')).toMatchObject({ status: 'ok', summary: '/repo/.claude/hooks.json' })
    expect(byId.get('hooks.events')?.summary).toContain('PreToolUse: 1/2')
    expect(byId.get('hooks.skipped')).toMatchObject({ status: 'ok', summary: 'none' })
    expect(byId.get('hooks.prompt-agent')).toMatchObject({ status: 'info' })
    // Not referenced by default, so no PATH scan at all.
    expect(byId.get('hooks.serena-hooks')).toMatchObject({ status: 'skip', summary: 'not referenced' })
  })

  it('fails hooks.source and records skipped entries on a broken config', async () => {
    const ctx = new Context()
    ctx.provide('hookBridgeStatus', {
      sourcePath: '/repo/.claude/hooks.json',
      events: [],
      skipped: [{ event: 'PostToolUse', type: 'http', reason: 'malformed url' }],
      error: 'SyntaxError: unexpected token',
      enablePromptHooks: false,
      enableAgentHooks: false,
    })
    const report = await collect(ctx, fakeInvocation(), CLOCK)
    const byId = new Map(report.checks.map(check => [check.id, check]))
    expect(byId.get('hooks.source')).toMatchObject({ status: 'fail', summary: 'SyntaxError: unexpected token' })
    expect(byId.get('hooks.skipped')).toMatchObject({ status: 'warn' })
    expect(byId.get('hooks.skipped')?.detail).toContain('malformed url')
  })

  it('reports "not probed" when a loaded hook references serena-hooks (default)', async () => {
    const ctx = new Context()
    ctx.provide('hookBridgeStatus', {
      sourcePath: '/repo/.claude/hooks.json',
      events: [{ name: 'PreToolUse', groups: 1, hooks: 1 }],
      skipped: [],
      commands: ['serena-hooks remind --client claude-code'],
      enablePromptHooks: false,
      enableAgentHooks: false,
    })
    const report = await collect(ctx, fakeInvocation(), CLOCK)
    expect(report.checks.find(check => check.id === 'hooks.serena-hooks')).toMatchObject({
      status: 'info',
      summary: 'not probed (use --verbose)',
    })
  })

  it('does not treat a skipped-row mention as a loaded serena-hooks command', async () => {
    const ctx = new Context()
    ctx.provide('hookBridgeStatus', {
      sourcePath: '/repo/.claude/hooks.json',
      events: [],
      skipped: [{ event: 'PreToolUse', type: 'command', reason: 'command serena-hooks not allowed' }],
      commands: [],
      enablePromptHooks: false,
      enableAgentHooks: false,
    })
    const report = await collect(ctx, fakeInvocation(), CLOCK)
    expect(report.checks.find(check => check.id === 'hooks.serena-hooks')).toMatchObject({
      status: 'skip',
      summary: 'not referenced',
    })
  })
})
