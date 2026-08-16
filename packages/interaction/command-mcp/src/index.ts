/**
 * Human-facing `/mcp` command: list the registered MCP servers, or
 * reconnect/disconnect one by name. It reads and drives the optional
 * `mcpConnections` service mounted by mcp-client; when that service is absent
 * it reports the seam gracefully rather than failing.
 * @module @jianxx/dsh-cc-command-mcp
 */

import { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import {
  formatConnections,
  formatUsage,
  parseMcpInput,
  type McpConnectionEntry,
} from './mcp.ts'

export const name = 'command-mcp'
export const inject = ['commands']

/**
 * The minimal structural face of the optional `mcpConnections` service that an
 * mcp-client instance provides. Kept local and structural so this package need
 * not depend on the mcp-client package's full dependency graph.
 */
export interface McpConnectionsSeam {
  /** A snapshot of every registered server today. */
  entries(): McpConnectionEntry[]
  /** Disconnect a registered server by name. */
  disconnect(name: string): Promise<void>
  /** Reconnect a registered server by name. */
  reconnect(name: string): Promise<void>
}

/** Resolve the optional mcpConnections seam, or undefined when not composed. */
function seam(ctx: Context): McpConnectionsSeam | undefined {
  return ctx.get('mcpConnections') as McpConnectionsSeam | undefined
}

/** Execute `/mcp [sub]` against the optional mcpConnections seam. */
async function executeMcp(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const connections = seam(ctx)
  if (connections === undefined) {
    return { kind: 'success', text: 'No MCP connection registry is mounted in this composition (mcp-client absent).' }
  }
  const input = parseMcpInput(invocation.rawInput)
  switch (input.kind) {
    case 'list':
      return { kind: 'success', text: formatConnections(connections.entries()) }
    case 'reconnect': {
      try {
        await connections.reconnect(input.name)
        return { kind: 'success', text: `Reconnecting MCP server "${input.name}".` }
      } catch (error) {
        return { kind: 'success', text: `Failed to reconnect MCP server "${input.name}": ${String(error)}` }
      }
    }
    case 'disconnect': {
      try {
        await connections.disconnect(input.name)
        return { kind: 'success', text: `Disconnected MCP server "${input.name}".` }
      } catch (error) {
        return { kind: 'success', text: `Failed to disconnect MCP server "${input.name}": ${String(error)}` }
      }
    }
    case 'usage':
      return { kind: 'success', text: formatUsage() }
  }
}

/**
 * Register the `/mcp` command for every composed command adapter.
 * @param ctx - context carrying the command registry.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'mcp',
    description: 'list MCP connections, or reconnect/disconnect one by name',
    input: { hint: '[reconnect|disconnect <name>]' },
    handler: (invocation: CommandInvocation) => executeMcp(ctx, invocation),
  })
}
