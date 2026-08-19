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
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { ConfigAliasesSchema, SettingsAliasesSchema } from './schema.ts'
import { createModelResolver, mergeAliasMaps } from './resolver.ts'
import type { AliasTarget, ResolvedRoute } from './types.ts'

/** Plugin configuration: deployment-default alias map. */
export interface Config {
  /** Deployment defaults (alias name → model id or `{provider, model}` route). */
  modelAliases?: Record<string, Exclude<AliasTarget, null>>
}

/** Runtime config schema (config-layer aliases never hold null). */
export const Config: z<Config> = z.object({ modelAliases: ConfigAliasesSchema })

/** The settings namespace carrying the live `model-aliases` overlay. */
const MODEL_ALIASES_NAMESPACE = settingsNamespace('model-aliases')

/** The shape consumers resolve through. */
export interface ModelRoutes {
  /** Resolve one frontmatter `model` to a dsh route, or undefined to inherit. */
  resolve(model: string | undefined): ResolvedRoute | undefined
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
          if (target.provider.trim().length === 0 || target.model.trim().length === 0) {
            throw new Error(`cc-model-aliases: model alias "${alias}" must specify a non-empty provider and model`)
          }
        }
      }
    },
  })
  const resolve = createModelResolver(
    () => mergeAliasMaps(
      config.modelAliases,
      scope?.get?.() as Record<string, AliasTarget | null> | undefined,
    ),
    { warn: message => ctx.logger.warn(message) },
  )
  ctx.provide('ccModelRoutes', { resolve })
}
