/**
 * Glue plugin for the cc-shell bundle: mounts the things cordis patch rows
 * cannot express statically — Claude Code plugin directories on disk, MCP
 * server configs from `.mcp.json`, and the base CC agent preset layers.
 * Discovery is best-effort: every absent path simply mounts nothing.
 *
 * @module @jianxx/dsh-cc-bundle-shell
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AgentProvider } from '@jianxx/dsh-cc-plugin-loader'
import { loadClaudeCodeAgents } from '@jianxx/dsh-cc-claude-code-agents'
import { buildRegistrations, type McpConfigFile } from '@jianxx/dsh-cc-mcp-config'
import * as CcMcpClient from '@jianxx/dsh-cc-mcp-client'
import { CcPluginsService } from './ccPlugins.ts'

/** Plugin config: which on-disk CC surfaces to mount. */
export interface Config {
  /** Directories that each carry a plugin.json (Claude Code plugins). */
  pluginDirs?: string[]
  /** `.mcp.json` documents whose accepted servers become mcp-client instances. */
  mcpConfigFiles?: string[]
  /** Register `~/.claude/agents` + `<cwd>/.claude/agents` as subagent providers. Defaults to true. */
  registerBaseAgents?: boolean
}

/** Runtime config schema (all fields optional; discovery prefers explicit lists). */
export const Config: z<Config> = z.object({
  pluginDirs: z.array(z.string()),
  mcpConfigFiles: z.array(z.string()),
  registerBaseAgents: z.boolean(),
})

/** Cordis plugin id. */
export const name = 'cc-shell-glue'

/** Default `.mcp.json` locations: project, then user-home Claude space. */
function defaultMcpFiles(): string[] {
  return [
    join(process.cwd(), '.mcp.json'),
    join(homedir(), '.claude', '.mcp.json'),
    join(homedir(), '.claude.json'),
  ]
}

/** Default Claude Code plugin roots: the user's enabled-plugins dir. */
function defaultPluginDirs(): string[] {
  return [join(homedir(), '.claude', 'plugins')]
}

interface SubagentsSeamHandle {
  registerProvider(provider: unknown): () => void
  getProvider(name: string): unknown
}

/**
 * Mount the discovered CC surfaces. Each piece is effect-scoped where the
 * underlying loader supports it; the subagent provider registrations return
 * disposers that the surrounding context discards on teardown.
 * @param ctx - the plug context.
 * @param config - discovery configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const results: string[] = []

  // 1. Claude Code plugins (each dir = one plugin root holding plugin.json).
  //    The CcPluginsService tracks every mount so host plugins can enumerate
  //    and rescan; mountAll performs the same best-effort discovery the glue
  //    always performed, tolerating any number of absent/invalid roots.
  const pluginDirs = config.pluginDirs ?? defaultPluginDirs()
  const plugins = new CcPluginsService(ctx, pluginDirs)
  const pluginErrors = await plugins.mountAll()
  for (const { root, error } of pluginErrors) {
    ctx.logger.warn(`cc-shell-glue: failed to mount CC plugin at ${root}: ${error}`)
  }
  for (const summary of plugins.list()) {
    const tallies = summary.components
    const loaded = tallies.reduce((n, c) => n + c.loaded, 0)
    const skipped = tallies.reduce((n, c) => n + c.skipped, 0)
    results.push(`cc-plugin ${summary.name}: ${loaded} loaded/${skipped} skipped`)
  }

  // 2. `.mcp.json` documents → per-server @jianxx/dsh-cc-mcp-client instances.
  for (const file of config.mcpConfigFiles ?? defaultMcpFiles()) {
    if (!existsSync(file)) continue
    try {
      const body = JSON.parse(readFileSync(file, 'utf8')) as McpConfigFile
      const registrations = buildRegistrations(body, { env: process.env })
      for (const server of registrations) {
        await ctx.plugin(CcMcpClient, server)
        results.push(`mcp server ${server.serverName} mounted from ${file}`)
      }
    } catch (error) {
      ctx.logger.warn(`cc-shell-glue: failed to mount MCP config ${file}: ${String(error)}`)
    }
  }

  // 3. Base agent dirs (~/.claude/agents + <cwd>/.claude/agents) → subagent providers.
  if (config.registerBaseAgents !== false) {
    const subagents = ctx.get('subagents') as SubagentsSeamHandle | undefined
    if (subagents === undefined) {
      ctx.logger.warn('cc-shell-glue: subagent seam absent; skipping base agent registration')
    } else {
      try {
        const definitions = await loadClaudeCodeAgents(process.cwd())
        for (const definition of definitions) {
          subagents.registerProvider(new AgentProvider(definition, (name: string) => subagents.getProvider(name) as never))
        }
        if (definitions.length > 0) {
          results.push(`agents: ${definitions.map(d => d.agentType).join(', ')}`)
        }
      } catch (error) {
        ctx.logger.warn(`cc-shell-glue: failed to load CC agents: ${String(error)}`)
      }
    }
  }

  if (results.length > 0) ctx.logger.info(`cc-shell-glue: mounted — ${results.join('; ')}`)
}
