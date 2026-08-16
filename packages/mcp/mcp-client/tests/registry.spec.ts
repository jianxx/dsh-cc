/**
 * Tests for the mcp-client MCP connection registry (`mcpConnections` service):
 * every instance registers and appears in `entries()`, state transitions
 * connecting→ready, `disconnect(name)` marks an entry disconnected (and
 * unregisters its tools), and `reconnect(name)` re-establishes a fresh
 * connection. The MCP SDK is mocked as in reconnect.spec.ts; two instances are
 * driven through the real `apply` on a shared Context.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@jianxx/dsh-cc-tools'
import type { Config } from '@jianxx/dsh-cc-mcp-client'
import { McpConnectionsService } from '@jianxx/dsh-cc-mcp-client'

// ---- Mock MCP SDK (isolated to this file, as in reconnect.spec.ts) ----
const { mockConnect, mockClose, mockListTools, mockSetNotificationHandler, MockClient, instances } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_p?: Record<string, unknown>) => Promise<unknown>>()
  const mockSetNotificationHandler = vi.fn()
  const mockRequest = vi.fn(async (request: { method: string }): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools()
    if (request.method === 'tools/call') return { content: [{ type: 'text', text: 'ok' }] }
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockClient {
    onclose: (() => void) | undefined
    connect = mockConnect
    close = mockClose
    request = mockRequest
    setNotificationHandler = mockSetNotificationHandler
    constructor() { instances.push(this) }
  }
  const instances: MockClient[] = []
  return { mockConnect, mockClose, mockListTools, mockSetNotificationHandler, MockClient, instances }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: MockClient }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn() }))

import { apply } from '@jianxx/dsh-cc-mcp-client/src/index.ts'

function listing(name: string): { tools: { name: string; inputSchema: { type: string } }[]; nextCursor: undefined } {
  return { tools: [{ name, inputSchema: { type: 'object' } }], nextCursor: undefined }
}

function stdioConfig(serverName: string): Config {
  return {
    transport: 'stdio',
    serverName,
    command: 'echo',
    args: [],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
  }
}

let ctx: Context

beforeEach(async () => {
  vi.clearAllMocks()
  instances.length = 0
  mockConnect.mockResolvedValue(undefined)
  mockClose.mockImplementation(function (this: { onclose?: () => void }) {
    this.onclose?.()
    return Promise.resolve()
  })
  mockListTools.mockResolvedValue(listing('remote'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
})

describe('McpConnectionsService / mcpConnections registry', () => {
  it('provides the service and two instances both appear ready in entries()', async () => {
    expect(ctx.get('mcpConnections')).toBeUndefined()

    await apply(ctx, stdioConfig('srv1'))
    await apply(ctx, stdioConfig('srv2'))

    const service = ctx.mcpConnections
    expect(service).toBeInstanceOf(McpConnectionsService)
    const entries = service.entries().map(entry => ({ name: entry.name, state: entry.state, toolCount: entry.toolCount }))
    expect(entries).toHaveLength(2)
    expect(entries).toContainEqual({ name: 'srv1', state: 'ready', toolCount: 1 })
    expect(entries).toContainEqual({ name: 'srv2', state: 'ready', toolCount: 1 })
  })

  it('records state transitions connecting → ready for an instance', async () => {
    // Gate the initial connection so we can observe the interim state.
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(() => gate.promise)
    const applying = apply(ctx, stdioConfig('srv1'))
    await vi.waitFor(() => { expect(ctx.get('mcpConnections')).toBeDefined() })
    expect(ctx.mcpConnections.entries()[0]!.state).toBe('connecting')

    gate.resolve()
    await applying
    expect(ctx.mcpConnections.entries()[0]!.state).toBe('ready')
  })

  it('disconnect(name) marks the entry disconnected and unregisters its tools', async () => {
    await apply(ctx, stdioConfig('srv1'))
    expect(ctx.tools.get('mcp__srv1__remote')).toBeDefined()

    await ctx.mcpConnections.disconnect('srv1')

    const entry = ctx.mcpConnections.entries().find(e => e.name === 'srv1')!
    expect(entry.state).toBe('disconnected')
    expect(ctx.tools.get('mcp__srv1__remote')).toBeUndefined()
  })

  it('reconnect(name) tears down and re-establishes a fresh connection', async () => {
    await apply(ctx, stdioConfig('srv1'))
    expect(instances).toHaveLength(1)
    const firstClient = instances[0]!

    await ctx.mcpConnections.reconnect('srv1')

    expect(instances.length).toBeGreaterThanOrEqual(2)
    expect(instances[0]).toBe(firstClient) // old client retained in the list
    const entry = ctx.mcpConnections.entries().find(e => e.name === 'srv1')!
    expect(entry.state).toBe('ready')
    expect(entry.toolCount).toBe(1)
    // The fresh generation re-exposed the tool.
    expect(ctx.tools.get('mcp__srv1__remote')).toBeDefined()
  })

  it('throws for an unregistered server on disconnect/reconnect', async () => {
    await apply(ctx, stdioConfig('srv1'))
    await expect(ctx.mcpConnections.disconnect('nope')).rejects.toThrow(/no server "nope"/)
    await expect(ctx.mcpConnections.reconnect('nope')).rejects.toThrow(/no server "nope"/)
  })

  it('unregisters the entry on plugin teardown', async () => {
    const fiber = await ctx.plugin(
      { name: 'mcp-client', inject: ['tools'], apply },
      stdioConfig('srv1'),
    )
    expect(ctx.mcpConnections.entries()).toHaveLength(1)

    await fiber.dispose()
    // The registry service is effect-scoped to the fiber that provided it, so
    // teardown removes the service (and its entries) entirely.
    expect(ctx.get('mcpConnections')).toBeUndefined()
  })
})
