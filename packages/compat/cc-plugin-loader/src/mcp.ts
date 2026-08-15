/**
 * Mount a Claude Code plugin's MCP servers.
 *
 * Collects server definitions from the manifest inline `mcpServers` record or
 * an `.mcp.json` file, then registers each through the optional `mcp` guest
 * seam. Tool naming (`mcp__<server>__<tool>`) is the seam's responsibility.
 * When the seam is absent the component is reported skipped, never failed.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CcPluginManifest } from './types.ts'
import { ComponentTally } from './seams.ts'

/** The MCP seam: registers a named server for tool discovery. */
export interface McpSeam {
  /**
   * Register one MCP server.
   * @param name - unique server name.
   * @param config - server transport configuration.
   * @returns the exact disposer that unregisters the server.
   */
  registerServer(name: string, config: Record<string, unknown>): () => void
}

/** Options for mounting one plugin's MCP servers. */
export interface MountMcpServersOptions {
  /** The plugin root directory; an `.mcp.json` path resolves against it. */
  readonly pluginRoot: string
  /** The parsed manifest; `mcpServers` and `mcpServersPath` drive the mount. */
  readonly manifest: CcPluginManifest
  /** The mcp seam (probed; `undefined` to skip mcpServers). */
  readonly mcp: McpSeam | undefined
}

/**
 * Collect and register a plugin's MCP servers through the optional seam.
 * @param options - plugin root, manifest, and the mcp seam.
 * @returns mounted disposers and per-component counts.
 */
export function mountMcpServers(options: MountMcpServersOptions): { disposers: (() => void)[]; tally: ComponentTally } {
  const tally = new ComponentTally('mcpServers')
  const disposers: (() => void)[] = []
  if (options.mcp === undefined) {
    tally.addSkipped('mcp seam "mcp" is not mounted')
    return { disposers, tally }
  }
  const servers = collectServers(options.pluginRoot, options.manifest)
  const entries = Object.entries(servers)
  if (entries.length === 0) {
    tally.addSkipped('plugin declares no MCP servers')
    return { disposers, tally }
  }
  for (const [name, config] of entries) {
    disposers.push(options.mcp.registerServer(name, config))
    tally.addLoaded()
  }
  return { disposers, tally }
}

/** Combine inline and file-backed MCP server definitions. */
function collectServers(pluginRoot: string, manifest: CcPluginManifest): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {}
  if (manifest.mcpServersPath !== undefined) {
    const path = resolve(pluginRoot, manifest.mcpServersPath)
    Object.assign(servers, readMcpJson(path))
  }
  for (const [name, config] of Object.entries(manifest.mcpServers)) {
    servers[name] = config as Record<string, unknown>
  }
  return servers
}

/** Read an `.mcp.json` file's `mcpServers` key (absent/invalid yields none). */
function readMcpJson(path: string): Record<string, Record<string, unknown>> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const servers = parsed['mcpServers']
    if (typeof servers === 'object' && servers !== null && !Array.isArray(servers)) {
      return servers as Record<string, Record<string, unknown>>
    }
    return {}
  } catch {
    return {}
  }
}
