# @jianxx/dsh-cc-settings-cascade

English | [中文](README.zh.md)

Claude Code-style five-level settings cascade provider for `ctx.settings`. Five sources merge low-to-high — user settings, project settings, local settings, flag settings, policy settings — under a plugin-default base. The merged raw document feeds the user-settings seam, whose namespace resolution layers schema defaults, the registrant `base`, and this user layer in turn.

## Config

| Field | Meaning | Default |
|---|---|---|
| `userSettingsPath` | User settings file | `settings.json` under the harness home |
| `projectSettingsPath` | Project settings file | `<project>/.claude/settings.json` |
| `localSettingsPath` | Local (gitignored) settings file | `<project>/.claude/settings.local.json` |
| `flagSettingsPath` | Command-line `--settings` file | none |
| `flagSettingsInline` | Inline `--settings` content, merged over the flag file | none |
| `projectDir` | Project root for the default project/local paths | current working directory |
| `dshHome` | Harness home for the default user settings path | `$DSH_HOME` or `~/.dsh` |
| `policy.remoteSettings` | Hosted policy settings; highest policy priority | none |
| `policy.systemPath` | System-level managed settings file | none |
| `policy.userPath` | User-writable managed settings file | none |

Defaulting is one explicit `resolveSpec(config)` step.

## Behavior

- **Priority order from low to high.** user < project < local < flag < policy. Sources deep-merge recursively; a higher source fills keys a lower one omitted and replaces the values it does carry.
- **Plugin defaults sit at the bottom.** Registration `base` and schema defaults resolve below every file source, so a missing document resolves exactly as a leaf provider would.
- **Permission arrays union, `deny` wins.** `allow`, `deny`, and `ask` rule arrays concatenate and deduplicate across layers, and the unioned `deny` set is removed from `allow` — a higher-layer deny always beats a lower-layer allow. Empty permission arrays are omitted. Other arrays (for example `additionalDirectories`) let the higher layer override wholesale.
- **Policy is first-source-wins.** The policy layer takes the first non-empty of its sub-sources in priority order: remote > system file > user file. An empty or absent higher source falls through to the next.
- **Flag settings merge file-then-inline.** If both a `--settings` file and inline content are present, the inline content merges over the file within the flag layer.
- **Misconfiguration fails loud.** A present-but-invalid settings document (unparsable JSON, or a non-object root) fails plugin load; an absent source file contributes nothing and is not an error.
- **The provider is read-only composition.** `writable` is `false`, so the seam's in-process `update()`/`replace()`/`mutate()` paths reject; namespaces write through their leaf provider.
- **`env` applies in two stages.** A top-level `env` section is split out of the merged document and exposed through `getEnv()` with every value coerced to a string. `applyEnv()` assigns ordinary variables; `applyTrustedEnv()` additionally assigns environment-altering variables (`LD_PRELOAD`, `PATH`, `DYLD_INSERT_LIBRARIES`, and the other `DANGEROUS_ENV_VARS`) and runs only after the user grants trust.

## Permissions schema

The `permissions` field schema (`allow`, `deny`, `ask`, `defaultMode`, `disableBypassPermissionsMode`, `additionalDirectories`, `protectedFiles`, `dangerousPatterns`), matching Claude Code's settings.json, is exported as `PermissionsSchema` (with `PermissionRuleSchema` and `PERMISSION_MODES`) for the permission-rule engine.

## Model Experience

Indirectly, through consumers of `ctx.settings`: this provider only composes and publishes namespace sections, and each consumer's own surface documents any model effect.

#### KV Cache effect

No direct invalidation; the consuming plugin owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Read-only, JSON-only sources.** The cascade composes existing documents; leaf writes are out of scope. Sources must be `.json` (the settings.json convention); YAML and write-through to user/project files are deferred.
- **No per-source provenance.** The merged result does not record which source supplied each resolved value, and `describe()` cannot mark a field's origin across the five layers the way a single user layer does.
- **Dangerous env is a static allowlist.** `DANGEROUS_ENV_VARS` names a fixed set; deployment-specific variables need an explicit extension point before first use.
