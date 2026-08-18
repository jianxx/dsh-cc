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
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { AgentProvider } from '@jianxx/dsh-cc-plugin-loader'
import { createModelResolver, mergeAliasMaps, ConfigAliasesSchema, SettingsAliasesSchema } from '@jianxx/dsh-cc-model-aliases'
import type { AliasTarget, ResolvedRoute } from '@jianxx/dsh-cc-model-aliases'
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
  /**
   * Deployment-default model aliases (alias name → model id or
   * `{provider, model}` route). These sit below the live `model-aliases`
   * settings overlay; see the cc-model-aliases README for merge semantics.
   */
  modelAliases?: Record<string, AliasTarget>
}

/** Runtime config schema (all fields optional; discovery prefers explicit lists). */
export const Config: z<Config> = z.object({
  pluginDirs: z.array(z.string()),
  mcpConfigFiles: z.array(z.string()),
  registerBaseAgents: z.boolean(),
  modelAliases: ConfigAliasesSchema,
})

/** Cordis plugin id. */
export const name = 'cc-shell-glue'

/** The settings namespace carrying the live `model-aliases` overlay. */
const MODEL_ALIASES_NAMESPACE = settingsNamespace('model-aliases')

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

  // 0. Model-aliases: register the live `model-aliases` settings overlay and
  //    build the spawn-time resolver. The resolver reads `scope.get()` fresh on
  //    every invocation and merges it against the deployment `modelAliases`
  //    defaults at that moment (liveness — in-process settings edits apply to
  //    the next spawn without re-registering).
  const resolveModel = buildModelResolver(ctx, config)

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

  // 3. Base agent dirs (~/.claude/agents + <cwd>/.claude/agents) → subagent providers.
  if (config.registerBaseAgents !== false) {
    const subagents = ctx.get('subagents') as SubagentsSeamHandle | undefined
    if (subagents === undefined) {
      ctx.logger.warn('cc-shell-glue: subagent seam absent; skipping base agent registration')
    } else {
      try {
        const definitions = await loadClaudeCodeAgents(process.cwd())
        for (const definition of definitions) {
          subagents.registerProvider(new AgentProvider(definition, (name: string) => subagents.getProvider(name) as never, resolveModel))
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

/**
 * Register the `model-aliases` settings overlay and build the spawn-time model
 * resolver threaded into every AgentProvider construction.
 *
 * The resolver reads the live settings scope fresh on every invocation — it is
 * NOT a merged snapshot captured at apply time — and merges it entry-shallow
 * against the deployment `modelAliases` defaults at that moment. If no settings
 * provider is mounted, the resolver degrades to the config defaults alone (and
 * the builtin fallback), so a settings-less host still gets alias resolution.
 * @param ctx - the plug context, whose optional settings provider owns the
 *   `model-aliases` namespace.
 * @param config - the plugin config carrying the deployment `modelAliases`.
 * @returns the resolver closure compatible with an AgentProvider `resolveModel`.
 */
function buildModelResolver(ctx: Context, config: Config): (model: string | undefined) => ResolvedRoute | undefined {
  const configAliases = config.modelAliases
  const scope = ctx.settings?.register?.(MODEL_ALIASES_NAMESPACE, SettingsAliasesSchema, {
    // schemastery dicts are lenient about stored values, so reject a half-written
    // route (a non-empty check the schema cannot express) at write time.
    validate: (value: Record<string, AliasTarget | null>) => {
      for (const [name, target] of Object.entries(value)) {
        if (target !== null && typeof target === 'object') {
          if (target.provider.trim().length === 0 || target.model.trim().length === 0) {
            throw new Error(`cc-shell-glue: model alias "${name}" must specify a non-empty provider and model`)
          }
        }
      }
    },
  })
  return createModelResolver(
    () => mergeAliasMaps(configAliases, scope?.get?.() as Record<string, AliasTarget | null> | undefined),
    { warn: message => ctx.logger.warn(message) },
  )
}
