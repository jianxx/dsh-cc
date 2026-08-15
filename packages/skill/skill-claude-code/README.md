# @jianxx/dsh-cc-skill-loader

English | [中文](README.zh.md)

Claude Code skill-format compatible provider for the `ctx.skills` registry.

This package discovers `SKILL.md` skills in Claude Code's directory layout (managed, project, user, and additional roots), parses the full Claude Code frontmatter spec, and serves them through `@deepseek-ai/dsh-skill`. It is a compatibility provider: the harness can consume skills written for Claude Code without copying the runtime that executes them. The registry remains in `@deepseek-ai/dsh-skill`; the session catalogs and loader remain in `@deepseek-ai/dsh-tool-skill`.

## Plugin

Requires `ctx.skills` (`inject: ['skills']`).

### Config

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `claude-code` | Unique name used to register this provider on `ctx.skills`. |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home resolved by [`@deepseek-ai/dsh-home-paths`](../../util/home-paths/README.md); scans `skills` under this directory as the user root. |
| `managedDir` | — | Optional managed policy root scanned before all defaults. |
| `additionalDirs` | `[]` | Additional skill roots appended after project and user roots. |

## Discovery

Roots are discovered in this precedence order (lower rank wins name conflicts):

| Rank | Source | Path |
|---|---|---|
| 100 | managed | `config.managedDir` |
| 200 | project | `<projectRoot>/.claude/skills` |
| 300 | user | `<dshHome>/skills` |
| 400 | additional | each `config.additionalDirs` |

The project root is the nearest ancestor containing `.git`; without one, the current cwd is used. Skills are directory bundles `<name>/SKILL.md`; legacy `.claude/commands/*.md` files are also loaded and marked `deprecated` in their metadata. Discovery deduplicates by the real path, so a symlinked or overlapping file is served once.

## Skill Format

`SKILL.md` is parsed as a YAML frontmatter document split from a Markdown body. The provider reads every known Claude Code field and tolerates unknown fields; a known field with an invalid value fails loudly at load rather than silently mis-activating.

Supported fields: `description`, `name`, `allowed-tools`, `argument-hint`, `arguments`, `when_to_use`, `version`, `model` (including `inherit`), `user-invocable`, `disable-model-invocation`, `context` (including `fork`), `agent`, `effort`, `shell`, `hooks`, and `paths`. Names must be kebab-case to register on the registry.

## Semantic translation

The provider parses and serves Claude Code fields unchanged; applying them to harness seams is the consumer's job at activation time. The package exports the translators:

- `ccRestriction(allowedTools)` — turns `allowed-tools` into an allow-only `tools.restrict()` filter (a `*` or empty list yields `undefined`, so the skill inherits the caller's surface).
- `ccPathMatcher(patterns)` / `registerPathActivator(ctx, ...)` — turns gitignore-style `paths` into conditional activation: an `fs/observed` listener fires `onActivate` when a Read/Write/Edit tool touches a matching file.
- `ccInvocation(parsed)` — resolves `disable-model-invocation` and `user-invocable` into the registry's invocation policy.
- `context: fork` — surfaced as `metadata.executionContext`; consumers route the skill to `ctx.subagents.start()` with its rendered body.

## Rendering

`renderSkillBody` substitutes `$ARGUMENTS`, `$ARGUMENTS[n]`, `$n`, named `$name` placeholders, and `${CLAUDE_SKILL_DIR}` / `${CLAUDE_SESSION_ID}`, and segments inline-shell `` !`...` `` commands for the caller to execute (guarded by `allowInlineShell`, which MCP-sourced skills must force off). `estimateFrontmatterTokens` counts only name, description, and `when_to_use` — the body is never counted during discovery.

## Known Limitations and Deferred Work

- **Semantic translation is consumer-side** — `allowed-tools`, `context: fork`, and `paths` are surfaced as metadata and helpers, not applied automatically, because a provider has no agent reference at load time.
- **Inline shell is not executed by this package** — commands are extracted and returned; execution is the caller's responsibility.
- **One-level discovery** — only `<root>/<name>/SKILL.md` and legacy top-level `.claude/commands/*.md` are recognized.
