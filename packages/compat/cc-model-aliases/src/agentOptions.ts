/**
 * Convert a resolved alias route into the `agentOptions` record stamped onto a
 * subagent spawn. Fields that are `undefined` are dropped so per-field
 * inheritance survives (a route omitting `provider` must not override it with
 * `undefined`); a route with no defined fields at all means "no override" and
 * collapses to `undefined`.
 *
 * @module @jianxx/dsh-cc-model-aliases/agentOptions
 */

import type { ResolvedRoute } from './types.ts'

/**
 * Drop `undefined` fields from a resolved route so per-field inheritance
 * survives (never set a field to `undefined` on the child request).
 * `undefined` in → `undefined` out; an all-`undefined` route → `undefined`.
 * @param route - the resolved route (or `undefined` for no override).
 * @returns the `agentOptions` record, or `undefined` for no override.
 */
export function toAgentOptions(route: ResolvedRoute | undefined): Record<string, string> | undefined {
  if (route === undefined) return undefined
  const out: Record<string, string> = {}
  if (route.provider !== undefined) out['provider'] = route.provider
  if (route.model !== undefined) out['model'] = route.model
  if (route.reasoningEffort !== undefined) out['reasoningEffort'] = route.reasoningEffort
  if (Object.keys(out).length === 0) return undefined
  return out
}
