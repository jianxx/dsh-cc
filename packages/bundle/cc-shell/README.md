# dsh-cc-bundle-shell

English | [中文](README.zh.md)

The CC shell **host-plane infra** bundle. This package carries the pieces that are genuinely host-level — the tools-registry swap with deferred-name support, and the settings-migrations mechanism — plus the `cc-shell-glue` plugin *code* (the glue code still lives here, but its mount action is performed by the CC preset, not this bundle's patch). All agent-facing composition — tool-search, skill loader, memory, coordinator, worktree/sleep/notebook/structured-output tools, the 19 slash commands, the hook bridge, output-style rendering — moved to the [`@jianxx/dsh-cc-preset-cc`](../../preset/cc/README.md) composition package, so it can be isolated per preset instead of leaking into every mode.

## What it does

- **Tools registry swap.** Disables the in-box `tools` row and remounts `@jianxx/dsh-cc-tools`. `reserve()`/`isAdmitted()` join the restrictable-name universe, so permission gates can name deferred tools before they load; the shipped behavior otherwise matches upstream. The base row's `DSH_TOOLS_MODE` toggle is carried forward ($DSH_HOME / process.cwd() semantics unchanged).
- **Settings migrations.** Mounts `@jianxx/dsh-cc-settings-migrations` to apply version-gated `settings.json` migrations at startup (equivalent to CC's `runMigrations`). Empty registry — mechanism only — for now.
- **Glue plugin code (mounted by the CC preset).** `cc-shell-glue` mounts what a cordis patch row cannot express statically: on-disk Claude Code plugin directories (each holding `plugin.json`, providing agents/skills/commands/hooks/mcp servers), `.mcp.json` server wiring, and the base CC agent preset dirs (`~/.claude/agents` + `<cwd>/.claude/agents`). Discovery is best-effort — every absent path mounts nothing. It also exposes the `ccPlugins` service for live enumeration/rescan of mounted plugins.

## Known limits / notes

- This bundle no longer globally mounts any agent-facing surface. Only the host-plane infra rows (tools registry swap + settings-migrations) are mounted by this bundle's `cordis.patch.yml`; the glue plugin and all agent surfaces are mounted by `@jianxx/dsh-cc-preset-cc` so they stay scoped to that preset.
- Because the tool-web executor row is unshipped by the CLI dependency tree through rc.6, fetch-based web tooling is mounted by the preset, not here; see the preset's "Known limits" for the current fetch status.
