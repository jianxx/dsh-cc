import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { PermissionRuleSet } from '@jianxx/dsh-cc-permission-rules/types'
import * as commandPermissions from '@jianxx/dsh-cc-command-permissions'
import { renderPermissions } from '@jianxx/dsh-cc-command-permissions/permissions'

function rule(tool: string, behavior: 'allow' | 'deny' | 'ask', source: string): { toolName: string; behavior: string; source: string } {
  return { toolName: tool, behavior, source }
}

const RULESET = (): PermissionRuleSet => ({
  allow: [
    rule('read', 'allow', 'config') as never,
    rule('grep', 'allow', 'userSettings') as never,
    rule('Bash', 'allow', 'config') as never,
  ],
  deny: [rule('edit', 'deny', 'config') as never],
  ask: [rule('Bash', 'ask', 'userSettings') as never],
  bypassImmune: [rule('edit', 'deny', 'config') as never],
})

async function harness(withService: boolean): Promise<{
  ctx: Context
  agent: Agent
  plugin: Awaited<ReturnType<Context['plugin']>>
  setMode: ReturnType<typeof vi.fn>
  planSet: ReturnType<typeof vi.fn>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  const setMode = vi.fn()
  const planSet = vi.fn()
  if (withService) {
    ctx.reflect.provide('permissionRules', { ruleSet: RULESET(), setMode })
    ctx.reflect.provide('planMode', { set: planSet })
  }
  const plugin = await ctx.plugin(commandPermissions)
  const session = ctx.sessions.create(SessionId(`command-permissions-${Math.random()}`))
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: null as never,
    ctx: new Context(),
    get status(): 'idle' { return 'idle' },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(agent)
  return { ctx, agent, plugin, setMode, planSet }
}

describe('@jianxx/dsh-cc-command-permissions registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    expect(commandPermissions.name).toBe('command-permissions')
    expect(commandPermissions.inject).toEqual(['commands'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandPermissions)).toBe(commandPermissions)
    const { ctx, agent, plugin } = await harness(true)
    expect(ctx.commands.find(agent, 'permissions')).toBeDefined()
    await plugin.dispose()
    expect(ctx.commands.find(agent, 'permissions')).toBeUndefined()
  })
})

describe('/permissions rendering', () => {
  it('aggregates rule counts per source and in total', () => {
    const text = renderPermissions(RULESET(), 1)
    expect(text).toContain('config: allow=2 deny=1 ask=0')
    expect(text).toContain('userSettings: allow=1 deny=0 ask=1')
    expect(text).toContain('Total: allow=3 deny=1 ask=1 (bypassImmune=1)')
  })
  it('handles an empty rule set', () => {
    const text = renderPermissions({ allow: [], deny: [], ask: [], bypassImmune: [] }, 0)
    expect(text).toContain('(no rules configured)')
  })
})

describe('/permissions human command', () => {
  it('renders the rule state when the engine is mounted', async () => {
    const { ctx, agent } = await harness(true)
    const execution = await ctx.commands.execute(agent, '/permissions', new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('Permission rules (read-only)')
    expect(text).toContain('Total: allow=3 deny=1 ask=1')
  })
  it('reports a friendly message when the engine is not mounted', async () => {
    const { ctx, agent } = await harness(false)
    const execution = await ctx.commands.execute(agent, '/permissions', new AbortController().signal)
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('not mounted')
  })

  it('/permissions <mode> switches the permission mode through setMode', async () => {
    const { ctx, agent, setMode } = await harness(true)
    const execution = await ctx.commands.execute(agent, '/permissions acceptEdits', new AbortController().signal)
    expect(setMode).toHaveBeenCalledWith(agent, 'acceptEdits')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('acceptEdits')
  })

  it('/permissions plan routes to planMode.set and does not call setMode', async () => {
    const { ctx, agent, setMode, planSet } = await harness(true)
    const execution = await ctx.commands.execute(agent, '/permissions plan', new AbortController().signal)
    expect(planSet).toHaveBeenCalledWith(agent, true)
    expect(setMode).not.toHaveBeenCalled()
    expect((execution?.result as { text: string }).text).toContain('plan')
  })

  it('/permissions bogus errors and lists the available modes', async () => {
    const { ctx, agent, setMode } = await harness(true)
    const execution = await ctx.commands.execute(agent, '/permissions bogus', new AbortController().signal)
    expect(setMode).not.toHaveBeenCalled()
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('default')
    expect(text).toContain('acceptEdits')
    expect(text).toContain('plan')
    expect(text).toContain('auto')
    expect(text).toContain('bypassPermissions')
  })

  it('errors when the engine is not mounted', async () => {
    const { ctx, agent } = await harness(false)
    const execution = await ctx.commands.execute(agent, '/permissions auto', new AbortController().signal)
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('not mounted')
  })

  it('/permissions default leaves an active plan before switching', async () => {
    const { ctx, agent, setMode, planSet } = await harness(true)
    agent.session.append('plan/mode', { active: true })
    const execution = await ctx.commands.execute(agent, '/permissions default', new AbortController().signal)
    expect(planSet).toHaveBeenCalledWith(agent, false)
    expect(setMode).toHaveBeenCalledWith(agent, 'default')
    expect((execution?.result as { text: string }).text).toContain('default')
  })
})

describe('CC catalog hides /permission', () => {
  it('drops /permission from list when /permissions is registered, but execute still reaches the host handler', async () => {
    const { ctx, agent, plugin } = await harness(true)
    const host = vi.fn(() => ({ kind: 'success' as const, text: 'preset workspace-write' }))
    ctx.commands.register({
      name: 'permission',
      description: 'Switch the permission preset (sandbox mode + approval policy)',
      input: { hint: '<preset>' },
      handler: host,
    })
    expect(ctx.commands.list(agent).map(entry => entry.name)).toEqual(['permissions'])
    expect(ctx.commands.find(agent, 'permission')).toBeDefined()
    const execution = await ctx.commands.execute(agent, '/permission workspace-write', new AbortController().signal)
    expect(host).toHaveBeenCalled()
    expect((execution?.result as { text: string }).text).toBe('preset workspace-write')
    await plugin.dispose()
    expect(ctx.commands.list(agent).map(entry => entry.name)).toEqual(['permission'])
  })
})
