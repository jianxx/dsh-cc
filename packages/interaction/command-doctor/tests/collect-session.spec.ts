import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { collect } from '../src/collect.ts'
import { CLOCK, fakeInvocation } from './helpers.ts'

describe('session checks', () => {
  it('reports session id and cwd, and skips absent presets and dshProfile', async () => {
    const ctx = new Context()
    const report = await collect(ctx, fakeInvocation({ sessionId: 'sess-42', cwd: '/repo/x' }), CLOCK)
    const byId = new Map(report.checks.map(check => [check.id, check]))
    expect(byId.get('session.id')).toMatchObject({ status: 'ok', summary: 'sess-42' })
    expect(byId.get('session.cwd')).toMatchObject({ status: 'ok', summary: '/repo/x' })
    expect(byId.get('session.permission-preset')?.status).toBe('skip')
    expect(byId.get('session.agent-preset')?.status).toBe('skip')
    expect(byId.get('session.dsh-profile')).toMatchObject({
      status: 'skip',
      summary: 'dshProfile seam not mounted',
    })
    expect(report.env.dshCc.length).toBeGreaterThan(0)
    expect(report.generatedAt).toBe('2026-09-03T00:00:00.000Z')
    expect(report.durationMs).toBe(0)
  })

  it('reports a provided dshProfile', async () => {
    const ctx = new Context()
    ctx.provide('dshProfile', 'tui')
    const report = await collect(ctx, fakeInvocation(), CLOCK)
    const check = report.checks.find(entry => entry.id === 'session.dsh-profile')
    expect(check).toMatchObject({ status: 'ok', summary: 'tui' })
  })

  it('falls back to process.cwd when the session header has none', async () => {
    const ctx = new Context()
    const invocation = fakeInvocation()
    ;(invocation as unknown as { agent: { session: { header: Record<string, unknown> } } }).agent.session.header = {}
    const report = await collect(ctx, invocation, CLOCK)
    expect(report.checks.find(entry => entry.id === 'session.cwd')?.summary).toBe(process.cwd())
  })

  it('skips the permission preset when current() throws', async () => {
    const ctx = new Context()
    ctx.provide('permissionPresets', {
      current: () => { throw new Error('no approval plane') },
    })
    const report = await collect(ctx, fakeInvocation(), CLOCK)
    const check = report.checks.find(entry => entry.id === 'session.permission-preset')
    expect(check?.status).toBe('skip')
    expect(check?.summary).toContain('no approval plane')
  })

  it('reports the permission preset and agent preset when mounted', async () => {
    const ctx = new Context()
    ctx.provide('permissionPresets', { current: () => 'cc' })
    ctx.provide('agentPresets', { defaultId: 'cc' })
    const report = await collect(ctx, fakeInvocation(), CLOCK)
    expect(report.checks.find(entry => entry.id === 'session.permission-preset')).toMatchObject({ status: 'ok', summary: 'cc' })
    expect(report.checks.find(entry => entry.id === 'session.agent-preset')).toMatchObject({ status: 'ok', summary: 'cc' })
  })
})
