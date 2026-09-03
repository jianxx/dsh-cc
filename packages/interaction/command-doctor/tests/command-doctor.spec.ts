import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { HookIssue } from '@jianxx/dsh-cc-hook-protocol'
import * as commandDoctor from '@jianxx/dsh-cc-command-doctor'
import { formatDoctorReport, type DoctorReport } from '@jianxx/dsh-cc-command-doctor/doctor'

function baseReport(): DoctorReport {
  return {
    version: '0.1.0-rc.5',
    settings: false,
    hooks: { issues: [], total: 0 },
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
    const text = formatDoctorReport({ version: 'v', settings: false, seams: [], hooks: { issues: [], total: 0 } })
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
    expect(text).toContain('Hooks: diagnostics unavailable (no dsh home)')
  })
})

describe('/doctor hook diagnostics section', () => {
  const issue = (n: number): HookIssue => ({
    ts: `2026-09-03T10:00:0${n}Z`,
    dialect: 'claude-code',
    point: 'PreToolUse',
    kind: 'timeout',
    detail: `timed out (${n})`,
  })

  it('renders the recorded-issues header plus one line per issue (last 10)', () => {
    const issues = Array.from({ length: 12 }, (_, i) => issue(i))
    const text = formatDoctorReport({ ...baseReport(), hooks: { issues, total: 12, path: '~/.dsh/hooks/diagnostics.jsonl' } })
    expect(text).toContain('Hooks: 12 issue(s) recorded (~/.dsh/hooks/diagnostics.jsonl)')
    expect(text).toContain('  [2026-09-03T10:00:02Z] PreToolUse timeout — timed out (2) (claude-code)')
    // Last 10 shown: the oldest visible issue is #2; #0/#1 are dropped.
    expect(text).not.toContain('10:00:00Z')
    expect(text).not.toContain('10:00:01Z')
    expect(text).toContain('timed out (11)')
  })

  it('renders "no issues recorded" when the count is zero', () => {
    const text = formatDoctorReport({ ...baseReport(), hooks: { issues: [], total: 0, path: '/dsh/hooks/diagnostics.jsonl' } })
    expect(text).toContain('Hooks: no issues recorded')
  })

  it('renders "diagnostics unavailable" when no dsh home is resolvable', () => {
    const text = formatDoctorReport({ ...baseReport(), hooks: { issues: [], total: 0 } })
    expect(text).toContain('Hooks: diagnostics unavailable (no dsh home)')
    expect(text).not.toContain('no issues recorded')
  })
})

describe('/doctor hook diagnostics gather', () => {
  async function doctorText(dshHome: string | undefined): Promise<string> {
    const ctx = new Context()
    if (dshHome !== undefined) ctx.dshHomePath = (...segs: string[]) => join(dshHome, ...segs)
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(commandDoctor)
    const session = ctx.sessions.create(SessionId(`doctor-hooks-${Math.random()}`))
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
    return (execution?.result as { text: string }).text
  }

  const issueLine = (ts: string, point: string, kind: string, detail: string): string =>
    JSON.stringify({ ts, dialect: 'claude-code', point, kind, detail }) + '\n'

  it('counts all valid lines and shows the last 10 from the dsh-home diagnostics file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'doctor-hooks-'))
    const file = join(home, 'hooks', 'diagnostics.jsonl')
    mkdirSync(join(home, 'hooks'), { recursive: true })
    // 12 valid lines + 1 malformed line the protocol reader must skip.
    const lines = Array.from({ length: 12 }, (_, i) =>
      issueLine(`2026-09-03T10:00:${String(i).padStart(2, '0')}Z`, 'PreToolUse', 'timeout', `timed out (${i})`))
    writeFileSync(file, lines.join('') + 'this is not json\n')
    const text = await doctorText(home)
    expect(text).toContain(`Hooks: 12 issue(s) recorded (${file})`)
    expect(text).toContain('  [2026-09-03T10:00:11Z] PreToolUse timeout — timed out (11) (claude-code)')
    expect(text).toContain('timed out (2)')
    expect(text).not.toContain('10:00:00Z')
  })

  it('renders "no issues recorded" for a dsh home without a diagnostics file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'doctor-hooks-'))
    const text = await doctorText(home)
    expect(text).toContain('Hooks: no issues recorded')
  })
})
