# @jianxx/dsh-cc-plugin-loader

English | [中文](README.zh.md)

Load a Claude Code plugin's `plugin.json` manifest and mount each component as an in-memory dsh plugin.

This compatibility loader reads a CC plugin manifest subset, translates each component with the pure helpers from [`@jianxx/dsh-cc-skill-loader`](../../skill/skill-claude-code/README.md) and [`@jianxx/dsh-cc-claude-code-agents`](../../preset/claude-code-agents/README.md), and consults the host seam for that component through `ctx.get(...)`. It is not a runtime: it produces typed mounts and a structural report, leaving execution to the seams it registers onto.

## Loader

`mountCcPlugin(ctx, { root, seams? })` reads `${root}/plugin.json`, validates the manifest subset, and mounts every present component as a Cordis effect. It returns `{ report, dispose }` — `report` is the per-component outcome, and `dispose` recalls every mounted component (a context teardown calls it automatically).

### Manifest subset

The loader validates `name` (mandatory, kebab-case), `version`, `description`, `author`, and the component fields `commands`, `agents`, `skills`, `hooks`, `mcpServers`, and `settings`. A malformed manifest throws at load with the plugin name. Unknown top-level fields are ignored, matching Claude Code's tolerant handling.

### Components and their seams

Each component is peer-style: the loader probes the host seam via `ctx.get(...)` and reports the component `skipped` (never failing the whole load) when the seam is absent.

| Component | Source | Seam (probed) | Translation |
|---|---|---|---|
| `commands` | manifest inline or source | `commands` | registers each slash command via `register`; the handler returns the command content |
| `agents` | `agents/` dir or manifest paths | `subagents` | loads `AgentDefinition`s via `loadAgentsDir` and registers each as a named provider via `registerProvider` |
| `skills` | `skills/` dir or manifest paths | `skills` | discovers `SKILL.md` via `discoverCcSkills`, parses frontmatter, and registers each as a runtime skill via `register` |
| `hooks` | `hooks/hooks.json` or inline | `hooks` (guest) | injects the per-event hook map via `mergePluginHooks` |
| `mcpServers` | inline record or `.mcp.json` | `mcp` (guest) | registers each server via `registerServer` (tool naming is the seam's responsibility) |
| `settings` | manifest record | `settings` (guest) | filters to the allowlist (currently `agent`) and writes via `set` |

The `hooks` and `mcp` seams have no harness-owned service today; a deployment that wants those components provides a guest seam or they are reported skipped.

## Skill semantic wiring

On top of the skill mount, this package is the consumer that turns `skill-claude-code`'s metadata into actionable registrations:

- **`allowed-tools`** — `skillToolRestriction(metadata)` builds the allow-only `tools.restrict()` filter; `applySkillRestriction(metadata, agent)` applies it to a scoped agent and returns the disposer.
- **`context: fork`** — `resolveSkillExecution(metadata, subagentsPresent)` routes the skill to subagent execution; when the subagent seam is absent it downgrades to inline and is reported.
- **`paths`** — `registerSkillPathActivator(ctx, skill, projectRoot)` wires the `fs/observed` path activator for conditional activation.
- **Inline shell** — `activationFor(metadata, subagentsPresent)` reports `forbidInlineShell` (a `shell: false` skill must not open an inline shell).

## Known Limitations and Deferred Work

- **Guest seams are absent in the harness** — `hooks`, `mcp`, and `settings` report `skipped` unless a deployment supplies the guest seam. There is no harness-owned `ctx.mcp` or `ctx.hooks` service today.
- **Agent providers forward execution** — the agents provider names its backend (default `fork`) and delegates `start`; executing a CC agent requires a `fork` backend on the subagent seam at run time.
- **Skill activation is host-driven** — the loader registers the wiring and activation descriptors; applying them at the model-facing moment is the host's responsibility.
