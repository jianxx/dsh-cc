/**
 * Shared vocabulary for Claude Code-compatible model alias resolution.
 *
 * Claude Code frontmatter (`model: opus`, `model: sonnet`) names aliases rather
 * than literal provider model IDs. This package layers those aliases onto the
 * harness: it maps an alias to a dsh `{provider, model}` route, or leaves the
 * frontmatter untouched so the child inherits its parent's route. The types
 * here are the pure record shapes the resolution functions consume and emit;
 * the merge and lookup semantics live in `resolver.ts` and the configuration
 * schemas in `schema.ts`.
 *
 * @module @jianxx/dsh-cc-model-aliases/types
 */

/**
 * A resolved dsh model route for one spawn.
 *
 * When `start()` passes this on as `agentOptions`, only the fields that are
 * present (`provider` and/or `model`) override the delegation; a route omitting
 * `provider` inherits the parent's provider, and one omitting `model` inherits
 * the parent's model. `undefined` means "no override" — the child inherits the
 * parent route wholesale (the `inherit` sentinel and the builtin fallback both
 * resolve to this).
 */
export interface ResolvedRoute {
  /** The provider to route to; omit to inherit the parent's provider. */
  readonly provider?: string | undefined
  /** The model id (or resolved alias model) to use; omit to inherit. */
  readonly model?: string | undefined
}

/**
 * One alias target as authored in config or settings.
 *
 * A string form names only a model id (`sonnet: deepseek-chat`); the provider
 * inherits the parent route. An object form additionally pins a provider
 * (`opus: { provider: ..., model: ... }`), breaking the current frontmatter
 * limitation of never being able to override the provider. In the settings
 * layer a configured entry may instead be `null`, which deletes a same-named
 * config-default entry (see {@link mergeAliasMaps}).
 */
export type AliasTarget = string | { readonly provider: string; readonly model: string } | null
