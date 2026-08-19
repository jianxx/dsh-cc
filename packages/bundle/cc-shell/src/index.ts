/**
 * Glue plugin for the cc-shell bundle: mounts the things cordis patch rows
 * cannot express statically — Claude Code plugin directories on disk and MCP
 * server configs from `.mcp.json`. Base CC-agent discovery moved to the
 * subagent/task package (per-workspace), and the `model-aliases` namespace is
 * owned by the `@jianxx/dsh-cc-model-aliases` routes service. Discovery is
 * best-effort: every absent path simply mounts nothing.
 *
 * @module @jianxx/dsh-cc-bundle-shell
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelRoutes } from '@jianxx/dsh-cc-model-aliases'
import { buildRegistrations, type McpConfigFile } from '@jianxx/dsh-cc-mcp-config'
import * as CcMcpClient from '@jianxx/dsh-cc-mcp-client'
import { CcPluginsService } from './ccPlugins.ts'

/** Plugin config: which on-disk CC surfaces to mount. */
export interface Config {
  /** Directories that each carry a plugin.json (Claude Code plugins). */
  pluginDirs?: string[]
  /** `.mcp.json` documents whose accepted servers become mcp-client instances. */
  mcpConfigFiles?: string[]
}

/** Runtime config schema (all fields optional; discovery prefers explicit lists). */
export const Config: z<Config> = z.object({
  pluginDirs: z.array(z.string()),
  mcpConfigFiles: z.array(z.string()),
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

/**
 * Mount the discovered CC surfaces. Each piece is effect-scoped where the
 * underlying loader supports it.
 * @param ctx - the plug context.
 * @param config - discovery configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const results: string[] = []

  // The spawn-time model resolver is provided by the `@jianxx/dsh-cc-model-aliases`
  // routes service (`ccModelRoutes`). Query it lazily on every spawn so mount
  // order doesn't matter and an unmounted routes service degrades to inherit.
  const resolveModel = (model: string | undefined) =>
    (ctx.get('ccModelRoutes') as ModelRoutes | undefined)?.resolve(model)

  // 1. Claude Code plugins (each dir = one plugin root holding plugin.json).
  //    The CcPluginsService tracks every mount so host plugins can enumerate
  //    and rescan; mountAll performs the same best-effort discovery the glue
  //    always performed, tolerating any number of absent/invalid roots.
  const pluginDirs = config.pluginDirs ?? defaultPluginDirs()
  const plugins = new CcPluginsService(ctx, pluginDirs, resolveModel)
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

  if (results.length > 0) ctx.logger.info(`cc-shell-glue: mounted — ${results.join('; ')}`)
}
