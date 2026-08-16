import { describe, expect, it } from 'vitest'
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
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  if (withService) {
    ctx.reflect.provide('permissionRules', { ruleSet: RULESET() })
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
  return { ctx, agent, plugin }
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
})
