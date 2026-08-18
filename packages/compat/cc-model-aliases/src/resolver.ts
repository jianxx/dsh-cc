/**
 * Claude Code model-alias merge and resolution.
 *
 * `mergeAliasMaps` folds the deployment `config` defaults and the live
 * `settings` overlay into one effective alias map — entry-shallow, so a
 * settings value replaces a same-named config value wholesale rather than
 * field-merging `{provider, model}` objects, with a settings `null` deleting
 * the config entry. `createModelResolver` turns a per-invocation alias source
 * into the `resolveModel` closure an agent provider calls at spawn time, so
 * live settings edits take effect on the next spawn without re-registering
 * anything.
 *
 * Only the four builtin alias names have a fallback when they are unconfigured
 * — they resolve to "inherit the parent route" (`undefined`), matching the
 * deployment decision that a zero-config `model: sonnet` agent silently uses
 * the parent's current model. A custom (open-set) alias that is unconfigured
 * has no fallback: it passes through verbatim as a literal model id, with a
 * warning when it looks like an intended alias.
 *
 * @module @jianxx/dsh-cc-model-aliases/resolver
 */

import type { AliasTarget, ResolvedRoute } from './types.ts'

/**
 * The builtin alias names that fall back to "inherit the parent route" when
 * unconfigured. Case-insensitive; a configured value still wins over this
 * fallback.
 */
export const BUILTIN_ALIASES: readonly string[] = ['fable', 'opus', 'sonnet', 'haiku']

/** The set of builtin names, lowercased, for O(1) membership checks. */
const BUILTIN_SET = new Set(BUILTIN_ALIASES)

/**
 * Merge the deployment `config` defaults and the settings overlay into one
 * effective alias map (aliases keyed by lowercased name). Entry-shallow:
 * a settings value replaces a config value wholesale and never field-merges a
 * `{provider, model}` object; a settings `null` deletes the config entry.
 * @param config - deployment config `modelAliases` (values never `null` at the
 *   schema level), or `undefined`.
 * @param settings - live settings `model-aliases` section (values may be `null`
 *   to delete), or `undefined`.
 * @returns a fresh map of only the configured aliases, keyed lowercased.
 */
export function mergeAliasMaps(
  config: Readonly<Record<string, AliasTarget>> | undefined,
  settings: Readonly<Record<string, AliasTarget | null>> | undefined,
): ReadonlyMap<string, AliasTarget> {
  const merged = new Map<string, AliasTarget>()
  for (const [key, value] of foldKeys(config)) {
    // Config never carries `null` at the schema level, but schemastery dicts are
    // lenient about stored values; silently treat a stray config `null` as
    // absent so it can never reach the resolver as a route.
    if (value !== null) merged.set(key, value)
  }
  for (const [key, value] of foldKeys(settings)) {
    if (value === null) merged.delete(key)
    else merged.set(key, value)
  }
  return merged
}

/**
 * Build a `resolveModel` closure for an agent provider. The alias source is a
 * thunk evaluated on every invocation, so the closure reads the live settings
 * and merges fresh each spawn (see the plan's liveness requirement).
 * @param getAliases - returns the effective alias map for this invocation (the
 *   caller composes config + live settings via {@link mergeAliasMaps}).
 * @param options - optional warning hook for unsigned custom aliases; the
 *   message is emitted (defaulting to `console.warn`) when a model that is not
 *   a configured alias and not a builtin looks like an intended alias (a bare
 *   lowercase alphabetic word) and is passed through verbatim.
 * @returns the resolution function mapping a frontmatter `model` to a route, or
 *   `undefined` for no override.
 */
export function createModelResolver(
  getAliases: () => ReadonlyMap<string, AliasTarget>,
  options?: { warn?: (message: string) => void },
): (model: string | undefined) => ResolvedRoute | undefined {
  const warn = options?.warn ?? ((message: string) => console.warn(message))
  return (model) => {
    if (model === undefined || model.trim().length === 0) return undefined
    const trimmed = model.trim()
    const folded = trimmed.toLowerCase()
    if (folded === 'inherit') return undefined

    const aliases = getAliases()
    const hit = aliases.get(folded)
    if (hit !== undefined && hit !== null) {
      return typeof hit === 'string' ? { model: hit } : { provider: hit.provider, model: hit.model }
    }

    // Unconfigured builtin alias → inherit the parent route ("current model").
    if (BUILTIN_SET.has(folded)) return undefined

    // Custom alias that is unconfigured: warn when it looks like an intended
    // alias, then pass through verbatim as a literal model id (no regression
    // for literal ids such as `deepseek-chat`).
    if (/^[a-z]+$/.test(folded)) {
      warn(`cc-model-aliases: model "${trimmed}" is not a configured alias and is not builtin; passing through verbatim as a literal model id`)
    }
    return { model: trimmed }
  }
}

/** Compact-fill a record's own string keys, folding each to lowercase. */
function foldKeys(record: Readonly<Record<string, AliasTarget | null>> | undefined): Map<string, AliasTarget | null> {
  const out = new Map<string, AliasTarget | null>()
  if (record === undefined) return out
  for (const [key, value] of Object.entries(record)) {
    out.set(key.toLowerCase(), value)
  }
  return out
}
