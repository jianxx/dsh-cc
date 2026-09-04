import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { collect } from '../src/collect.ts'
import { CLOCK, fakeInvocation } from './helpers.ts'

type Entry = Record<string, unknown>

function mcpCtx(entries: Entry[]): Context {
  const ctx = new Context()
  ctx.provide('mcpConnections', { entries: () => entries })
  return ctx
}

function group(report: { checks: { id: string; status: string; summary: string }[] }) {
  return report.checks.filter(check => check.id.startsWith('mcp.'))
}

describe('mcp checks', () => {
  it('skips when mcpConnections is not mounted', async () => {
    const report = await collect(new Context(), fakeInvocation(), CLOCK)
    expect(group(report)[0]).toMatchObject({ id: 'mcp.registry', status: 'skip' })
  })

  it('maps the status table', async () => {
    const report = await collect(mcpCtx([
      { name: 'alpha', state: 'ready', toolCount: 3, eagerCount: 2, deferredCount: 1 },
      { name: 'beta', state: 'connecting' },
      { name: 'gamma', state: 'ready', toolCount: 0 },
      { name: 'delta', state: 'error', error: 'spawn ENOENT' },
      { name: 'echo', state: 'ready', toolCount: 2, authRequired: true },
    ]), fakeInvocation(), CLOCK)
    const byId = new Map(group(report).map(check => [check.id, check]))
    expect(byId.get('mcp.overview')).toMatchObject({ status: 'ok', summary: '5 servers' })
    expect(byId.get('mcp.server.alpha')).toMatchObject({ status: 'ok' })
    expect(byId.get('mcp.server.alpha')?.summary).toContain('3 tools')
    expect(byId.get('mcp.server.alpha')?.detail).toContain('eager 2, deferred 1')
    expect(byId.get('mcp.server.beta')).toMatchObject({ status: 'info' })
    expect(byId.get('mcp.server.gamma')).toMatchObject({ status: 'warn' })
    expect(byId.get('mcp.server.delta')).toMatchObject({ status: 'fail' })
    expect(byId.get('mcp.server.echo')).toMatchObject({ status: 'warn', summary: 'echo: authentication required' })
  })

  it('fails mcp.serena when a serena server is present but not ready', async () => {
    const report = await collect(mcpCtx([
      { name: 'Serena MCP', state: 'disconnected', error: 'timeout' },
    ]), fakeInvocation(), CLOCK)
    expect(report.checks.find(check => check.id === 'mcp.serena')).toMatchObject({
      status: 'fail',
      summary: 'Serena MCP: disconnected',
    })
  })

  it('skips mcp.serena when no serena server exists', async () => {
    const report = await collect(mcpCtx([
      { name: 'alpha', state: 'ready', toolCount: 1 },
    ]), fakeInvocation(), CLOCK)
    expect(report.checks.find(check => check.id === 'mcp.serena')).toMatchObject({
      status: 'skip',
      summary: 'no serena server',
    })
  })

  it('adds the worktree cross-note on mcp.serena detail in verbose mode', async () => {
    const ctx = mcpCtx([{ name: 'serena', state: 'ready', toolCount: 4 }])
    // Fake a worktree cwd via the gitInfo level: run git checks through the
    // same collect with a fake cwd is fs-bound; instead assert the mcp check
    // function directly with a fabricated GitInfo.
    const { mcpChecks } = await import('../src/checks/mcp.ts')
    const checks = mcpChecks(ctx, {
      verbose: true,
      git: { worktree: true, isRepo: true, hasNodeModules: true, hasSerena: false },
    })
    const serena = checks.find(check => check.id === 'mcp.serena')
    expect(serena?.detail).toContain('.serena')
    expect(checks.filter(check => check.id === 'mcp.serena')).toHaveLength(1)
  })
})
