# @jianxx/dsh-cc-model-aliases

English | [中文](README.zh.md)

Claude Code-compatible model alias resolution for the DeepSeek Harness. It maps Claude Code
frontmatter model aliases (`model: opus`, `model: sonnet`) onto dsh `{provider, model}`
routes. The package now ships in two shapes:

- a **`ccModelRoutes` host service** (the cordis plugin entry) that owns the `model-aliases`
  settings namespace registration and exposes a spawn-time resolver, and
- the **pure helpers** (`mergeAliasMaps` / `createModelResolver`) for embedding the same
  resolution semantics without mounting the service.

## Why

Claude Code agent/CLAUDE.md frontmatter names models by alias. Without an alias
layer, `model: opus` was passed through verbatim as a provider model id, so an
adapter that does not know the id (e.g. `llm-pi-ai`) threw `UNKNOWN_MODEL`, and
`model: inherit` — a valid CC sentinel meaning "use my parent's model" — was
also handed to `prepareCall` as a literal id and errored.

This package adds that layer: an alias resolves to a `{provider, model}` route,
the unresolvable cases fall back to *inheriting the parent route* (no override),
and literal ids like `deepseek-chat` keep passing through untouched.

## The `ccModelRoutes` service

The plugin entry (`name: 'cc-model-routes'`, `apply`) is what the CC preset mounts via the
`cc-model-routes` row. It:

- registers the `model-aliases` **settings namespace** — but **only when** a settings
  provider (`ctx.get('settings')`) is mounted, so a settings-less host degrades to the config
  defaults plus the builtin fallback (this namespace registration is the single owner of that
  name; the harness throws on a duplicate registration, see `dsh-settings`);
- registers the namespace with a **write-time `validate`** that rejects a half-written
  `{provider, model}` route (a non-empty cross-field check the dict schema itself cannot
  express);
- and provides the spawn-time resolver as the **`ccModelRoutes`** value (`ctx.provide`) whose
  `resolve(model)` reads the **live** settings scope on every invocation — a settings write
  applies to the next spawn with no re-registration.

Consumers `ctx.get('ccModelRoutes')` **lazily** on every spawn. Lazily means mount order does
not matter: before the provider's fiber is active, `ctx.get` returns `undefined`, which
resolves to "inherit the parent route" (the same no-override behavior as before).

## How the cc-shell bundle wires it

- `Config.modelAliases` provides **deployment defaults** (alias name → model id
  or `{provider, model}`).
- The `model-aliases` **settings namespace** registration now lives in the `ccModelRoutes`
  service, layered exactly like every other settings section (user/project/local/flags).
- cc-shell's `AgentProvider` gains its `resolveModel` as a **trampoline** over the service:
  `(model) => ctx.get('ccModelRoutes')?.resolve(model)` — queried **lazily on every spawn**,
  read fresh (no snapshot captured at apply time), and degrading to inherit when the service
  is not mounted (`undefined` resolution = inherit the parent route, byte-compatible with the
  old no-resolver fallback). cc-shell no longer registers the namespace itself.
- The Task tool (`@jianxx/dsh-cc-subagent-task`) is the other consumer: it resolves a
  subagent definition's frontmatter `model` through the same `ccModelRoutes` resolver at
  spawn time.

## Configuration

```yaml
# ccModelRoutes service config (the preset's cc-model-routes row)
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
all the way to `prepareCall`, where it failed. In CC mode the spawn-time resolver
(from the `ccModelRoutes` service, consumed via the cc-shell trampoline and the
Task tool) maps `inherit` to "no override", so the child inherits the parent
route, matching CC semantics. When no resolver is mounted (non-cc consumers of
`@jianxx/dsh-cc-plugin-loader` that do not set `resolveModel`), behavior stays
byte-identical to before — including the old `inherit` pass-through — because the
no-resolver fallback is preserved exactly. The CC preset unconditionally mounts
cc-shell (and the routes service), so in CC mode the fix is always active.

## API

- `apply(ctx, config?)` / `name` — **cordis plugin entry** (plugin id `cc-model-routes`,
  also re-exported as `applyRoutes` / `routesPluginName`). Mounts the service; config shape is
  `{ modelAliases?: Record<string, AliasTarget> }` (deployment defaults).
- `ModelRoutes` — the value type of `ctx.get('ccModelRoutes')` (`resolve(model):
  { provider?, model? } | undefined`).
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
