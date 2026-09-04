/**
 * The `ccModelRoutes` host service: the single owner of the `model-aliases`
 * settings namespace registration.
 *
 * CC frontmatter names models by alias (`model: opus`); this package maps an
 * alias to a dsh `{provider, model}` route. Consumers (the cc-shell glue's
 * `AgentProvider` and the Task tool) `ctx.get('ccModelRoutes')` lazily on
 * every spawn — the resolver re-reads the live settings scope each call, so a
 * settings write applies to the next spawn without re-registration.
 *
 * When no settings provider is mounted the resolver degrades to the config
 * defaults plus the builtin fallback (an unconfigured builtin alias inherits
 * the parent route), so a settings-less host still resolves.
 *
 * @module @jianxx/dsh-cc-model-aliases/service
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
// Type-only: pull in the declaration-merged `agent/request` event so the host
// overlay listener typechecks. Does not extend AgentOptions.
import type {} from '@deepseek-ai/dsh-agent'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { ConfigAliasesSchema, SettingsAliasesSchema } from './schema.ts'
import { createModelInspector, createModelResolver, mergeAliasMaps } from './resolver.ts'
import { overlayStampedEffort, stampedEffortOf } from './effort.ts'
import type { AliasInspection, AliasTarget, ResolvedRoute } from './types.ts'

/** Plugin configuration: deployment-default alias map. */
export interface Config {
  /** Deployment defaults (alias name → model id or `{provider, model}` route). */
  modelAliases?: Record<string, Exclude<AliasTarget, null>>
}

/** Runtime config schema (config-layer aliases never hold null). */
export const Config: z<Config> = z.object({ modelAliases: ConfigAliasesSchema })

/** The settings namespace carrying the live `model-aliases` overlay. */
export const MODEL_ALIASES_NAMESPACE = settingsNamespace('model-aliases')

/** The shape consumers resolve through. */
export interface ModelRoutes {
  /** Resolve one frontmatter `model` to a dsh route, or undefined to inherit. */
  resolve(model: string | undefined): ResolvedRoute | undefined
  /** Inspect one frontmatter `model` with provenance (for `/doctor` reporting). */
  inspect(model: string | undefined): AliasInspection
}

/** Cordis plugin id. */
export const name = 'cc-model-routes'

/**
 * Register the `model-aliases` settings namespace (when a settings provider is
 * mounted) and expose the spawn-time resolver as the `ccModelRoutes` value.
 * @param ctx - the plug context.
 * @param config - deployment defaults.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = ctx.get('settings') as SettingsProvider | undefined
  const scope = settings?.register(MODEL_ALIASES_NAMESPACE, SettingsAliasesSchema, {
    // Reject a half-written object route at write time (the dict schema cannot
    // express a non-empty cross-field check).
    validate: (value: Record<string, AliasTarget | null>) => {
      for (const [alias, target] of Object.entries(value)) {
        if (target !== null && typeof target === 'object') {
          if (typeof target.model !== 'string' || target.model.trim().length === 0) {
            throw new Error(`cc-model-aliases: model alias "${alias}" must specify a non-empty model`)
          }
          if (target.provider !== undefined && target.provider.trim().length === 0) {
            throw new Error(`cc-model-aliases: model alias "${alias}" must specify a non-empty provider when present`)
          }
        }
      }
    },
  })
  const inspect = createModelInspector(
    () => mergeAliasMaps(
      config.modelAliases,
      scope?.get?.() as Record<string, AliasTarget | null> | undefined,
    ),
    { warn: message => ctx.logger.warn(message) },
  )
  const resolve = (model: string | undefined) => inspect(model).route
  ctx.provide('ccModelRoutes', { resolve, inspect })

  // Host-side effort overlay: a child spawned through an alias whose route
  // declared `reasoningEffort` carries it on its options as an undeclared
  // runtime extra key (stamped by the Task tool / plugin-loader). buildRequest
  // deep-freezes its seed config and may restore an explicit parent /effort
  // from a fork seed's request/header — the alias contract wins, so overlay
  // AFTER `next()` with a shallow copy (never in place). Root agents carry no
  // stamp on options, so this is a no-op for them.
  ctx.on('agent/request', async ({ agent }, next) => {
    const resolved = await next()
    return overlayStampedEffort(resolved, stampedEffortOf(agent.options))
  })
}

/**
 * Host-plane alias read WITHOUT owning the namespace: resolve through the
 * `ccModelRoutes` service when one is mounted, otherwise read the live
 * `model-aliases` settings overlay directly. Never re-registers the namespace
 * — the isolated `cc-model-routes` plugin row already owns that registration,
 * and `settings.register` throws on a duplicate namespace.
 * @param ctx - the host context (no plugin instance required).
 * @param alias - frontmatter model alias, or undefined to inherit.
 * @returns the resolved route, or undefined to inherit the parent route.
 */
export function resolveAlias(ctx: Context, alias: string | undefined): ResolvedRoute | undefined {
  const routes = ctx.get('ccModelRoutes') as ModelRoutes | undefined
  if (routes !== undefined) return routes.resolve(alias)
  const settings = ctx.get('settings') as SettingsProvider | undefined
  const overlay = settings?.get?.(MODEL_ALIASES_NAMESPACE) as Record<string, AliasTarget | null> | undefined
  return createModelResolver(
    () => mergeAliasMaps(undefined, overlay),
    { warn: message => ctx.logger.warn(message) },
  )(alias)
}
