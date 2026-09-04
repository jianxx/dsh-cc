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
 * the parent's model. `reasoningEffort`, when present, is stamped onto the
 * child's options (a runtime extra key) and applied to every child request by
 * the host `agent/request` listener in the routes service. `undefined` means
 * "no override" — the child inherits the parent route wholesale (the `inherit`
 * sentinel and the builtin fallback both resolve to this).
 */
export interface ResolvedRoute {
  /** The provider to route to; omit to inherit the parent's provider. */
  readonly provider?: string | undefined
  /** The model id (or resolved alias model) to use; omit to inherit. */
  readonly model?: string | undefined
  /**
   * Reasoning effort stamped from the alias target (object form only); an
   * opaque non-empty string whose legal spellings belong to the target model's
   * adapter (`max`, `xhigh`, `high`, …). Absent → no effort stamp.
   */
  readonly reasoningEffort?: string | undefined
}

/**
 * One atomic resolution result: the effective route PLUS its provenance,
 * captured from a single settings snapshot (never re-derived later). `via`
 * records how `selector` was classified:
 * - `inherit`: no override (`undefined`, blank, the `inherit` sentinel, an
 *   unconfigured builtin, or an unresolvable lane peer) — the parent route
 *   stands and `route` is undefined.
 * - `alias`: a configured alias (or a lane peer sharing a configured peer's
 *   route) — `route` is the alias's resolved route.
 * - `literal`: passed through verbatim as a model id — `route` is
 *   `{ model: selector }` with `provider` absent.
 */
export interface DetailedRoute {
  /** The trimmed selector that was resolved (undefined for blank/undefined input). */
  readonly selector: string | undefined
  /** How the selector was classified, from the same snapshot as `route`. */
  readonly via: 'alias' | 'literal' | 'inherit'
  /** The resolved route (undefined exactly when `via` is `inherit`). */
  readonly route: ResolvedRoute | undefined
}

/**
 * One alias target as authored in config or settings.
 *
 * A string form names only a model id (`sonnet: deepseek-chat`); the provider
 * inherits the parent route. An object form additionally pins a provider
 * (`opus: { provider: ..., model: ... }`) — `provider` is optional so an alias
 * can inherit the parent provider while still pinning a model and effort — and
 * may carry a `reasoningEffort` stamped onto spawns of this alias. In the
 * settings layer a configured entry may instead be `null`, which deletes a
 * same-named config-default entry (see {@link mergeAliasMaps}).
 */
export type AliasTarget
  = | string
    | { readonly provider?: string; readonly model: string; readonly reasoningEffort?: string }
    | null
