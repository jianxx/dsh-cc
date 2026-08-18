/**
 * Claude Code-compatible model alias resolution for the DeepSeek Harness.
 *
 * Pure library — no cordis plugin form, nothing to mount. It maps Claude Code
 * frontmatter model aliases (`model: opus`, `model: sonnet`) to dsh
 * `{provider, model}` routes. The cc-shell bundle composes this package's
 * helpers into a `resolveModel` closure and injects it into every AgentProvider
 * construction, with a `model-aliases` settings namespace supplying the live
 * overlay. See the README for configuration, merge, and fallback semantics.
 *
 * @module @jianxx/dsh-cc-model-aliases
 */

export { BUILTIN_ALIASES, mergeAliasMaps, createModelResolver } from './resolver.ts'
export {
  ConfigAliasSchema,
  ConfigAliasesSchema,
  SettingsAliasSchema,
  SettingsAliasesSchema,
  type ConfigAliasEntry,
  type SettingsAliasEntry,
} from './schema.ts'
export type { AliasTarget, ResolvedRoute } from './types.ts'
