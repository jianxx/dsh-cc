import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as commandMcp from '@jianxx/dsh-cc-command-mcp'
import {
  formatConnections,
  parseMcpInput,
  type McpConnectionEntry,
} from '@jianxx/dsh-cc-command-mcp/mcp'

const SAMPLE: readonly McpConnectionEntry[] = [
  { name: 'files', state: 'ready', toolCount: 12 },
  { name: 'search', state: 'error', error: 'ECONNREFUSED' },
  { name: 'git', state: 'connecting', authRequired: true },
]

describe('parseMcpInput', () => {
  it('parses the empty/whitespace form as a listing', () => {
    expect(parseMcpInput('')).toEqual({ kind: 'list' })
    expect(parseMcpInput('   ')).toEqual({ kind: 'list' })
  })
  it('parses reconnect and disconnect with a single name', () => {
    expect(parseMcpInput(' reconnect files ')).toEqual({ kind: 'reconnect', name: 'files' })
    expect(parseMcpInput('disconnect git')).toEqual({ kind: 'disconnect', name: 'git' })
  })
  it('rejects missing args and unknown subcommands as usage', () => {
    expect(parseMcpInput('reconnect')).toEqual({ kind: 'usage' })
    expect(parseMcpInput('reconnect a b')).toEqual({ kind: 'usage' })
    expect(parseMcpInput('disconnect')).toEqual({ kind: 'usage' })
    expect(parseMcpInput('foo')).toEqual({ kind: 'usage' })
    expect(parseMcpInput('stop files')).toEqual({ kind: 'usage' })
  })
})

describe('formatConnections (pure)', () => {
  it('renders name, state, tool count, and auth markers', () => {
    const text = formatConnections(SAMPLE)
    expect(text).toContain('- files (ready) tools: 12')
    expect(text).toContain('- search (error) error: ECONNREFUSED')
    expect(text).toContain('- git (connecting) auth required')
  })
  it('reports an empty registry gracefully', () => {
    expect(formatConnections([])).toContain('No MCP servers are registered.')
  })
})

describe('/mcp human command', () => {
  async function harness(seam?: { entries(): McpConnectionEntry[]; disconnect(name: string): Promise<void>; reconnect(name: string): Promise<void> }) {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(commandMcp)
    if (seam) ctx.provide('mcpConnections', seam)
    const session = ctx.sessions.create(SessionId(`command-mcp-human-${Math.random()}`))
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
    return { ctx, agent }
  }

  it('registers one global command with Loader-safe exports', async () => {
    expect(commandMcp.name).toBe('command-mcp')
    expect(commandMcp.inject).toEqual(['commands'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandMcp)).toBe(commandMcp)
    const { ctx, agent } = await harness()
    expect(ctx.commands.find(agent, 'mcp')).toBeDefined()
  })

  it('degrades gracefully when the mcpConnections seam is absent', async () => {
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/mcp', new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    expect((execution?.result as { text: string }).text).toContain('mcp-client absent')
  })

  it('lists connections through the seam', async () => {
    const entries = vi.fn(() => [...SAMPLE])
    const { ctx, agent } = await harness({ entries, disconnect: async () => {}, reconnect: async () => {} })
    const execution = await ctx.commands.execute(agent, '/mcp', new AbortController().signal)
    expect(entries).toHaveBeenCalled()
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('- files (ready) tools: 12')
  })

  it('reconnects a server by name', async () => {
    const reconnect = vi.fn(async () => {})
    const { ctx, agent } = await harness({ entries: () => [], disconnect: async () => {}, reconnect })
    const execution = await ctx.commands.execute(agent, '/mcp reconnect files', new AbortController().signal)
    expect(reconnect).toHaveBeenCalledWith('files')
    expect((execution?.result as { text: string }).text).toContain('Reconnecting MCP server "files"')
  })

  it('disconnects a server by name', async () => {
    const disconnect = vi.fn(async () => {})
    const { ctx, agent } = await harness({ entries: () => [], disconnect, reconnect: async () => {} })
    const execution = await ctx.commands.execute(agent, '/mcp disconnect git', new AbortController().signal)
    expect(disconnect).toHaveBeenCalledWith('git')
    expect((execution?.result as { text: string }).text).toContain('Disconnected MCP server "git"')
  })

  it('reports unknown subcommands as usage', async () => {
    const { ctx, agent } = await harness({ entries: () => [], disconnect: async () => {}, reconnect: async () => {} })
    const execution = await ctx.commands.execute(agent, '/mcp frobnicate files', new AbortController().signal)
    expect((execution?.result as { text: string }).text).toContain('Usage:')
  })

  it('reports a failed drive action gracefully', async () => {
    const reconnect = vi.fn(async () => { throw new Error('no such server') })
    const { ctx, agent } = await harness({ entries: () => [], disconnect: async () => {}, reconnect })
    const execution = await ctx.commands.execute(agent, '/mcp reconnect nope', new AbortController().signal)
    expect((execution?.result as { text: string }).text).toContain('Failed to reconnect MCP server "nope"')
  })
})
