# @jianxx/dsh-cc-model-aliases

Claude Code-compatible model alias resolution for the DeepSeek Harness. This is a
**pure library** — no cordis plugin, nothing to mount. It maps Claude Code
frontmatter model aliases (`model: opus`, `model: sonnet`) onto dsh
`{provider, model}` routes. The cc-shell bundle composes it into a
`resolveModel` closure and injects it into every `AgentProvider` construction,
with a `model-aliases` settings namespace supplying the live overlay.

## Why

Claude Code agent/CLAUDE.md frontmatter names models by alias. Without an alias
layer, `model: opus` was passed through verbatim as a provider model id, so an
adapter that does not know the id (e.g. `llm-pi-ai`) threw `UNKNOWN_MODEL`, and
`model: inherit` — a valid CC sentinel meaning "use my parent's model" — was
also handed to `prepareCall` as a literal id and errored.

This package adds that layer: an alias resolves to a `{provider, model}` route,
the unresolvable cases fall back to *inheriting the parent route* (no override),
and literal ids like `deepseek-chat` keep passing through untouched.

## How the cc-shell bundle wires it

- `Config.modelAliases` provides **deployment defaults** (alias name → model id
  or `{provider, model}`).
- A `model-aliases` **settings namespace** provides the live overlay, layered
  exactly like every other settings section (user/project/local/flags).
- cc-shell builds one resolver (via `createModelResolver`) that, **on every
  spawn**, reads `scope.get()` fresh and entry-shallow-merges it against the
  config defaults — no snapshot captured at apply time. So an in-process
  settings edit applies to the next spawn with no re-registration.
- The resolver is threaded into **both** AgentProvider construction sites: the
  base `~/.claude/agents` providers and every plugin-shipped agent (via
  `mountCcPlugin` → `mountAgents`).

## Configuration

```yaml
# cc-shell deployment config
modelAliases:
  sonnet: deepseek-v4-flash                      # string form: model only, provider inherits
  opus:   { provider: deepseek-official, model: deepseek-v4-pro }  # explicit route
```

```jsonc
// settings namespace "model-aliases"
{
  "fable":  { "provider": "anthropic", "model": "claude-fable-5" },
  "sonnet": null     // null = delete the same-named config-default alias
}
```

## Resolution semantics

Lookup order for an alias: **settings overlay → config defaults → builtin
fallback**. Alias key matching is **case-insensitive** (keys are folded to
lowercase at merge and at lookup).

| `model` frontmatter | Result |
|---|---|
| `undefined` / blank | no override — child inherits the parent route |
| `inherit` (any case) | no override — child inherits the parent route (**fixes the old pass-through bug**) |
| configured alias (string form) | `{ model: <target> }` |
| configured alias (object form) | `{ provider: <p>, model: <m> }` |
| builtin alias unconfigured (`fable`/`opus`/`sonnet`/`haiku`) | no override — child inherits the parent route ("current model") |
| anything else | passed through **verbatim** as a literal model id; a bare-lowercase-word form (e.g. `turbo`) logs a warning that it looks like an unconfigured alias |

### Null deletion

Only the **settings** layer may set an entry to `null`; that deletes a
same-named **config-default** entry (entry-shallow). Deleting a *builtin* alias
still falls through to the builtin fallback — `null` cannot turn `sonnet` into an
error, because the builtin fallback is **inherit the parent route**. Config may
never hold `null` (rejected by the config schema).

### Merge rules

- **Config vs settings is entry-shallow**: a settings entry replaces the config
  entry wholesale. It never field-merges `{provider, model}` objects — so
  `config { provider: A, model: X }` + `settings { model: Y }` yields
  `{ model: Y }`, never a blended `{ provider: A, model: Y }` that no single
  layer declared.
- **Within the settings 5-cascade the merge is recursively deep** (existing
  cascade behavior). Consequently an object-form alias must be written **whole
  or not at all** across settings layers, or the cascade will field-blend
  `{provider, model}` just as described above — this is a cascade-level
  behavior this package does not change. Prefer string-form aliases, or repeat
  the full route on every layer that mentions the alias.

### Builtin fallback

Fresh installs with **zero configuration** still work: `model: sonnet` /
`model: opus` agents resolve to *inherit the parent's current model* instead of
erroring. Only the four builtin names get this fallback; a custom alias
(`turbo`, `gpt`, …) that is unconfigured has **no** fallback and is passed
through verbatim (with the warning above).

## `inherit` fix note

Prior to this package, `model: inherit` was forwarded as the literal model id
all the way to `prepareCall`, where it failed. When cc-shell injects the
resolver, `inherit` resolves to "no override" and the child inherits the parent
route, matching CC semantics. When the resolver is **not** injected (non-cc
consumers of `@jianxx/dsh-cc-plugin-loader` that do not set `resolveModel`),
behavior stays byte-identical to before — including the old `inherit`
pass-through — because the no-resolver fallback is preserved exactly. The CC
preset unconditionally mounts cc-shell, so in CC mode the fix is always active.

## API

- `mergeAliasMaps(config, settings)` — entry-shallow merge with `null` deletion
  and case-insensitive key folding; returns an effective `ReadonlyMap` of only
  the configured aliases.
- `createModelResolver(getAliases, { warn })` — build a `resolveModel` closure.
  `getAliases` is a thunk evaluated **per invocation** (liveness). Optional
  `warn` replaces the default `console.warn` used for the unconfigured-custom-alias
  warning.
- `BUILTIN_ALIASES` — `['fable', 'opus', 'sonnet', 'haiku']`.
- `ConfigAliasesSchema` / `SettingsAliasesSchema` (and their record forms) —
  schemastery schemas for the config layer (no `null`) and settings layer
  (`null` allowed), plus `AliasTarget` / `ResolvedRoute` types.

## Non-goals (tracked in the parity matrix)

`/model` interactive command, `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL`
env vars, and aliasing the main session's default model remain follow-ups.
