import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as commandDoctor from '@jianxx/dsh-cc-command-doctor'
import { formatDoctorReport, type DoctorReport } from '@jianxx/dsh-cc-command-doctor/doctor'

function baseReport(): DoctorReport {
  return {
    version: '0.1.0-rc.5',
    settings: false,
    seams: [
      { name: 'shell', mounted: false },
      { name: 'subprocess', mounted: false },
      { name: 'fs', mounted: false },
      { name: 'skills', mounted: false },
      { name: 'web', mounted: false },
      { name: 'lsp', mounted: false },
      { name: 'llm', mounted: false },
    ],
  }
}

describe('@jianxx/dsh-cc-command-doctor registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    expect(commandDoctor.name).toBe('command-doctor')
    expect(commandDoctor.inject).toEqual(['commands'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandDoctor)).toBe(commandDoctor)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    const plugin = await ctx.plugin(commandDoctor)
    const session = ctx.sessions.create(SessionId(`command-doctor-${Math.random()}`))
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
    expect(ctx.commands.find(agent, 'doctor')).toBeDefined()
    const execution = await ctx.commands.execute(agent, '/doctor', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    expect(execution?.result.text).toContain('Seams:')
    await plugin.dispose()
    expect(ctx.commands.find(agent, 'doctor')).toBeUndefined()
  })
})

describe('/doctor version', () => {
  it('reads a version from the package manifest', () => {
    // The manifest lives beside the package; a version is always returned.
    expect(commandDoctor.readVersion().length).toBeGreaterThan(0)
  })
})

describe('/doctor formatting snapshot', () => {
  it('renders version, settings, and every seam line', () => {
    const report: DoctorReport = {
      ...baseReport(),
      version: '0.1.0-rc.5',
      settings: true,
    }
    const text = formatDoctorReport(report)
    expect(text).toContain('Version: 0.1.0-rc.5')
    expect(text).toContain('Settings: reachable')
    expect(text).toContain('Seams:')
    expect(text).toContain('  fs: not mounted')
    expect(text).toContain('  llm: not mounted')
  })
  it('renders mounted seams with their provider detail', () => {
    const report: DoctorReport = {
      ...baseReport(),
      seams: [
        { name: 'shell', mounted: true },
        { name: 'llm', mounted: true, detail: 'deepseek, openai' },
      ],
    }
    const text = formatDoctorReport(report)
    expect(text).toContain('  shell: mounted')
    expect(text).toContain('  llm: mounted (deepseek, openai)')
  })
  it('renders an explicit placeholder when no seams are reported', () => {
    const text = formatDoctorReport({ version: 'v', settings: false, seams: [] })
    expect(text).toContain('  (none)')
  })
})

describe('/doctor gather', () => {
  it('runs through the registry against a bare composition', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(commandDoctor)
    const session = ctx.sessions.create(SessionId('session-doctor'))
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
    const execution = await ctx.commands.execute(agent, '/doctor', [], new AbortController().signal)
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('Settings: not mounted')
    expect(text).toContain('  fs: not mounted')
    expect(text).toContain('  llm: not mounted')
  })
})
