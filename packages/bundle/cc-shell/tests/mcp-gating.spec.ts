/**
 * Tests for the cc-shell glue's gated MCP discovery: when a dsh-native config
 * (`<cwd>/.mcp.json` or `$DSH_HOME/.mcp.json`) declares at least one server,
 * Claude Code config files are skipped with a warn + one-shot session-start
 * notice pointing at `/mcp migrate`; `mcpLoadClaudeFiles: true` restores the
 * old all-merge behavior and an explicit `mcpConfigFiles` list bypasses
 * gating entirely.
 *
 * The repo root has no `.mcp.json`, so `process.cwd()` contributes no dsh
 * project file — the tests only seed `$DSH_HOME`, `$CLAUDE_CONFIG_DIR`, and
 * `$HOME` tmp trees.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@jianxx/dsh-cc-tools'
import { apply } from '../src/index.ts'

/** A ZERO-dependency MCP stdio server: newline-delimited JSON-RPC on stdio. */
const FIXTURE_SERVER = `
import { createInterface } from 'node:readline'

const respond = (id, result) => {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  // Notifications carry no id; ignore them (e.g. notifications/initialized).
  if (message.id === undefined || message.id === null) return
  switch (message.method) {
    case 'initialize':
      respond(message.id, {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'fixture', version: '1.0.0' },
      })
      break
    case 'tools/list':
      respond(message.id, {
        tools: [{ name: 'ping', description: 'pong', inputSchema: { type: 'object', properties: {} } }],
      })
      break
    default:
      break
  }
})
`

let tmp: string
let dshHome: string
let claudeDir: string
let home: string
let fixturePath: string
let previous: Record<'DSH_HOME' | 'CLAUDE_CONFIG_DIR' | 'HOME', string | undefined>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cc-shell-mcp-gating-'))
  dshHome = join(tmp, 'dsh')
  claudeDir = join(tmp, 'claude')
  home = join(tmp, 'home')
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(claudeDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  fixturePath = join(tmp, 'fixture-server.mjs')
  writeFileSync(fixturePath, FIXTURE_SERVER, 'utf8')
  previous = {
    DSH_HOME: process.env.DSH_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    HOME: process.env.HOME,
  }
  process.env.DSH_HOME = dshHome
  process.env.CLAUDE_CONFIG_DIR = claudeDir
  // `os.homedir()` follows $HOME on POSIX, so this relocates ~/.claude.json.
  process.env.HOME = home
})

afterEach(() => {
  for (const key of ['DSH_HOME', 'CLAUDE_CONFIG_DIR', 'HOME'] as const) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
  rmSync(tmp, { recursive: true, force: true })
})

/** Write a dsh-native config declaring the given server names. */
function writeDshConfig(names: string[]): string {
  const file = join(dshHome, '.mcp.json')
  const servers: Record<string, unknown> = {}
  for (const name of names) servers[name] = { type: 'stdio', command: process.execPath, args: [fixturePath] }
  writeFileSync(file, JSON.stringify({ mcpServers: servers }), 'utf8')
  return file
}

/** Write a Claude Code config (`.mcp.json` under $CLAUDE_CONFIG_DIR and `~/.claude.json`). */
function writeClaudeConfigs(names: string[]): { claudeMcpJson: string; claudeDotJson: string } {
  const claudeMcpJson = join(claudeDir, '.mcp.json')
  const claudeDotJson = join(home, '.claude.json')
  const servers: Record<string, unknown> = {}
  for (const name of names) servers[name] = { type: 'stdio', command: process.execPath, args: [fixturePath] }
  writeFileSync(claudeMcpJson, JSON.stringify({ mcpServers: servers }), 'utf8')
  writeFileSync(claudeDotJson, JSON.stringify({ mcpServers: servers }), 'utf8')
  return { claudeMcpJson, claudeDotJson }
}

/** Fresh cordis context with the runtime surfaces the glue needs. */
async function newCtx(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

/** Emit `agent/session-start` twice with a stub agent capturing injected messages. */
function emitSessionStartTwice(ctx: Context): unknown[] {
  const captured: unknown[] = []
  const agent = { inject: (message: unknown) => captured.push(message) }
  for (let i = 0; i < 2; i++) ctx.emit(ctx, 'agent/session-start', { agent, source: 'startup' })
  return captured
}

describe('cc-shell glue gated MCP discovery', () => {
  it('gates claude files behind a non-empty dsh config and notices once', async () => {
    writeDshConfig(['server-a'])
    const { claudeMcpJson } = writeClaudeConfigs(['server-b'])
    const warns: string[] = []
    const ctx = await newCtx()
    const realWarn = ctx.logger.warn.bind(ctx.logger)
    ctx.logger.warn = (message: string, ...rest: unknown[]) => {
      warns.push(String(message))
      realWarn(message, ...rest)
    }

    await apply(ctx, { pluginDirs: [] })

    const registry = ctx.get('mcpConnections')
    const entries = registry!.entries()
    expect(entries.find(e => e.name === 'server-a')).toMatchObject({ name: 'server-a', state: 'ready' })
    expect(entries.some(e => e.name === 'server-b')).toBe(false)
    expect(warns.some(w => w.includes('/mcp migrate'))).toBe(true)

    const captured = emitSessionStartTwice(ctx)
    expect(captured).toHaveLength(1)
    const text = JSON.stringify(captured[0])
    expect(text).toContain('/mcp migrate')
    expect(text).toContain(claudeMcpJson)
  }, 30_000)

  it('mounts claude files ungated when no dsh config exists (no notice)', async () => {
    const { claudeMcpJson } = writeClaudeConfigs(['server-b-ungated'])

    const ctx = await newCtx()
    await apply(ctx, { pluginDirs: [] })

    const registry = ctx.get('mcpConnections')
    const entries = registry!.entries()
    expect(entries.find(e => e.name === 'server-b-ungated')).toMatchObject({ name: 'server-b-ungated', state: 'ready' })

    const captured = emitSessionStartTwice(ctx)
    expect(captured).toHaveLength(0)
    expect(claudeMcpJson).toBeDefined()
  }, 30_000)

  it('mounts claude files when the dsh config is empty (gate requires >=1 declared server)', async () => {
    writeFileSync(join(dshHome, '.mcp.json'), JSON.stringify({ mcpServers: {} }), 'utf8')
    writeClaudeConfigs(['server-b-empty-dsh'])

    const ctx = await newCtx()
    await apply(ctx, { pluginDirs: [] })

    const registry = ctx.get('mcpConnections')
    const entries = registry!.entries()
    expect(entries.find(e => e.name === 'server-b-empty-dsh')).toMatchObject({ name: 'server-b-empty-dsh', state: 'ready' })
    expect(emitSessionStartTwice(ctx)).toHaveLength(0)
  }, 30_000)

  it('mcpLoadClaudeFiles: true restores the all-merge behavior with no notice', async () => {
    writeDshConfig(['server-a-escape'])
    writeClaudeConfigs(['server-b-escape'])

    const ctx = await newCtx()
    await apply(ctx, { mcpLoadClaudeFiles: true, pluginDirs: [] })

    const registry = ctx.get('mcpConnections')
    const entries = registry!.entries()
    expect(entries.find(e => e.name === 'server-a-escape')).toMatchObject({ name: 'server-a-escape', state: 'ready' })
    expect(entries.find(e => e.name === 'server-b-escape')).toMatchObject({ name: 'server-b-escape', state: 'ready' })
    expect(emitSessionStartTwice(ctx)).toHaveLength(0)
  }, 30_000)

  it('an explicit mcpConfigFiles list bypasses gating entirely', async () => {
    writeDshConfig(['server-a-explicit'])
    const { claudeDotJson } = writeClaudeConfigs(['server-b-explicit'])

    const ctx = await newCtx()
    await apply(ctx, { mcpConfigFiles: [claudeDotJson], pluginDirs: [] })

    const registry = ctx.get('mcpConnections')
    const entries = registry!.entries()
    expect(entries.find(e => e.name === 'server-b-explicit')).toMatchObject({ name: 'server-b-explicit', state: 'ready' })
    expect(entries.some(e => e.name === 'server-a-explicit')).toBe(false)
    expect(emitSessionStartTwice(ctx)).toHaveLength(0)
  }, 30_000)
})
