# dsh-cc

**A Claude Code-style coding experience for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

`dsh-cc` adds the interactive coding-agent features developers expect — a terminal UI, slash commands, subagents, skills, MCP, hooks, permissions, memory, worktrees, resumable sessions, model aliases, and more — as composable plugins for DeepSeek Harness.

**No permanent DeepSeek Harness fork required.**

> This project is not Claude Code and is not a wrapper around Claude Code. It re-creates familiar Claude Code-style workflows on top of the DeepSeek Harness runtime, where you control the models, tools, plugins, and agent composition.

## Why dsh-cc?

DeepSeek Harness provides a flexible agent runtime and plugin system. `dsh-cc` builds a more complete interactive coding environment on top of it.

With the CC profile installed, you get:

- a full-screen terminal UI designed for coding-agent workflows;
- familiar slash commands such as `/doctor`, `/memory`, `/skills`, `/permissions`, `/tasks`, `/resume`, and `/branch`;
- `.claude/agents` subagents and `SKILL.md` skills;
- `CLAUDE.md`-style project memory and background memory consolidation;
- MCP tools, resources, prompts, and OAuth 2.1 support;
- Claude Code-style hooks and permission rules;
- worktree-aware workflows and resumable sessions;
- deferred tool discovery with `ToolSearch`;
- tools such as `NotebookEdit`, `StructuredOutput`, and `Sleep`;
- configurable model aliases such as `opus`, `sonnet`, `haiku`, and `inherit`;
- the same CC-oriented backend available from both terminal and web profiles.

All of this is loaded through the native dsh profile/plugin system rather than maintained as a long-lived product fork.

## Quick start

Prerequisite: `dsh` on `PATH`, version **>= 0.1.0-rc.5**.

Install the CC-oriented terminal profile:

```sh
dsh plugin --profile tui add \
  @jianxx/dsh-cc-bundle-permissions \
  @jianxx/dsh-cc-bundle-shell \
  @jianxx/dsh-cc-bundle-tui
dsh --profile tui
```

Or install the optional launcher:

```sh
npm install -g @jianxx/dsh-cc
dsh-cc
```

For the web UI, install the same backend without the TUI bundle:

```sh
dsh plugin --profile web add \
  @jianxx/dsh-cc-bundle-permissions \
  @jianxx/dsh-cc-bundle-shell
dsh web
```

The `tui` profile boots directly into the CC preset.

## What you get

<!-- parity:matrix:start -->
| Category | Full | Partial | Missing | Non-goal |
| --- | --- | --- | --- | --- |
| Engine subsystems | 11 | 6 | 5 | 2 |
| Hook events | 12 | 4 | 4 | 0 |
| Command surface | 19 | 5 | 1 | 2 |
| Sessions and context | 1 | 0 | 1 | 0 |
| Memory and CLAUDE.md | 0 | 1 | 1 | 0 |
| Skills | 0 | 1 | 0 | 0 |
| Subagents | 0 | 1 | 0 | 0 |
| MCP | 1 | 0 | 0 | 0 |
| Plugins and marketplaces | 1 | 0 | 0 | 0 |
| Settings | 1 | 1 | 0 | 0 |
| Permissions | 0 | 1 | 0 | 0 |
| Models | 0 | 1 | 0 | 0 |
| Workspace | 1 | 0 | 0 | 0 |
| Interactive UX | 1 | 0 | 1 | 0 |

Statuses were verified against upstream documentation retrieved as of 2026-09-04 (freshness threshold: 120 days).

For the exact feature-by-feature status and known gaps, see the **[Claude Code parity matrix](docs/cc-parity-matrix.md)**.
<!-- parity:matrix:end -->

## Familiar coding-agent workflows

### Subagents

Project-local Claude Code-style agent definitions under `.claude/agents` can be discovered and dispatched by the CC preset.

```text
.claude/
  agents/
    reviewer.md
    debugger.md
```

Agent frontmatter can continue using familiar model aliases while dsh decides which provider/model actually serves the request.

### Skills

`SKILL.md`-based skills are discovered by the CC skill provider, including project-specific skills and bundled utility skills.

### Memory

The memory layer supports `CLAUDE.md`-style context plus a dedicated write channel for durable memories. Memory is isolated by workspace, with optional shared team memory.

### MCP

The CC profile includes an MCP client with:

- tools;
- resources;
- prompts;
- OAuth 2.1 flows.

Use `/mcp` to inspect and manage MCP connections.

### Hooks

Claude Code-style hooks can react to session, prompt, tool, permission, compaction, task, and subagent lifecycle events. Command and HTTP executors are supported, with additional prompt/agent executors available behind configuration gates.

This repository ships a tracked `hooks.json` (the CC preset loads it from the launch cwd). The PreToolUse remind hook requires `serena-hooks` on `PATH` — see [Local development](#local-development).

See the [parity matrix](docs/cc-parity-matrix.md) for the currently bridged event set.

## Slash commands

The CC preset exposes a growing command surface, including:

```text
/cost              token / cost information
/doctor            session health report (--verbose / --json)
/status            environment and session status
/memory            inspect memories
/skills            list installed skills
/config            inspect or change settings
/permissions       inspect or change permission mode/rules
/mcp               manage MCP connections
/tasks             inspect current tasks/jobs
/resume            resume an interrupted session
/branch            worktree branch management
/diff              inspect CLAUDE.md / settings differences
/init               scan a project and scaffold CLAUDE.md
/plugin             manage plugins
/release-notes      show release notes
/version            show version information
```

The TUI also provides terminal-oriented interactions such as todo inspection, approval flows, queued prompts, transcript export, usage/context display, and local shell commands.

## Use the models you want

Claude Code-style agent definitions often refer to models using aliases:

```yaml
model: sonnet
```

`dsh-cc` can route those aliases to provider/model pairs configured for your deployment.

Conceptually:

```text
sonnet / draft      -> <provider>/<general coding model>
opus / blueprint    -> <provider>/<reasoning model>
haiku / sketch      -> <provider>/<fast model>
fable / masterplan  -> <provider>/<maximum-reasoning model>
architect           -> parent agent route (planning / orchestration)
inherit             -> parent agent route
```

Aliases are configuration, not hard-coded vendor bindings. This lets you preserve familiar agent definitions while choosing the models that fit your own environment.

### Dogfooding dsh-cc

`dsh-cc` is now developed with `dsh-cc` itself. The project's current development setup uses the same model-alias routing described above, with this mapping:

| Alias | Model |
| --- | --- |
| `fable` / `masterplan` | `kimi-k3` |
| `opus` / `blueprint` | `glm-5.3` |
| `sonnet` / `draft` | `glm-5.3-flash` |
| `haiku` / `sketch` | `deepseek-v4-flash-0731` |
| `architect` | inherit (main thread) |

This is a real project configuration rather than a required default: users can map the aliases to any provider/model combination supported by their DeepSeek Harness deployment.

## How this is different

### vs. Claude Code

Claude Code is a complete coding-agent product. `dsh-cc` instead brings many familiar interaction patterns to the DeepSeek Harness runtime, where the deployment controls models, tools, plugins, permissions, and agent composition.

### vs. a DeepSeek Harness fork

This repository is designed primarily as an out-of-repo plugin stack. Most functionality is installed and composed through dsh profiles, reducing the amount of permanent fork maintenance required as upstream evolves.

A small number of upstream packages are vendored where the required extension point cannot currently be expressed as a wrapper. See [Architecture notes](#architecture) below.

### vs. model/API routers

This is not just a model-routing proxy. It extends the agent runtime and developer experience itself: UI, commands, tools, memory, subagents, hooks, MCP, permissions, sessions, and worktree workflows.

## CC Mode

CC Mode is an additional dsh agent preset. The four built-in dsh modes remain behaviorally unchanged.

On the `tui` profile, CC Mode is the default. On other profiles it can be selected through the preset selector or configured as the default agent preset.

The terminal profile launches in fullscreen mode by default. To opt out for one invocation:

```sh
DSH_CCTUI_UI_MODE=regular dsh --profile tui
```

## Configuration

Your profile remains ordinary dsh composition. Local tweaks can be placed in:

```text
~/.dsh/profiles/tui/cordis.patch.yml
```

They are applied after the installed bundles.

Model alias configuration, permissions, settings precedence, hook behavior, memory options, and TUI behavior are exposed through the corresponding plugins/settings namespaces.

For exact semantics, use the package READMEs and the [parity matrix](docs/cc-parity-matrix.md) as the source of truth.

## Compatibility and known limits

The goal is **useful Claude Code-style workflow compatibility**, not byte-for-byte emulation of Claude Code.

Some areas are intentionally partial or depend on DeepSeek Harness extension points. Examples include parts of the hook event vocabulary, background subagent workflows, notification/IDE-shell behavior, and vendor-specific features.

The project tracks those differences explicitly instead of hiding them:

**[Read the full Claude Code parity matrix →](docs/cc-parity-matrix.md)**

## Architecture

The repository is a monorepo of small plugins and bundles grouped by responsibility:

```text
packages/
  settings/       settings cascade and migrations
  interaction/    permissions and slash commands
  mcp/            MCP client and configuration
  hooks/          hook protocol and CC bridge
  core/           tools, ToolSearch, NotebookEdit, StructuredOutput, Sleep
  skill/          SKILL.md support
  preset/         CC agent preset and agent compatibility
  compat/         plugin loader, model aliases, output styles
  memory/         CLAUDE.md memory and consolidation
  workspace/      worktree tools
  subagent/       coordinator / subagent integration
  compaction/     micro-compaction
  session/        cost, export, and stats commands
  bundle/         installable profile bundles
  ui/             terminal UI
  launcher/       optional dsh-cc executable
```

Most packages are normal out-of-repo dsh plugins.

A few packages vendor upstream implementations when the required changes need private/internal extension points rather than composition. These currently include the tools registry, MCP client, hook protocol, and Claude Code hook bridge. At runtime they are mounted under distinct package names while preserving the expected service interfaces.

## Local development

This repository expects a sibling DeepSeek Harness checkout at `../deepseek-harness` for local `link:` development dependencies.

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
```

### Serena (`serena-hooks` on PATH)

Dogfooding this repo loads the tracked `hooks.json`. Its PreToolUse remind hook runs `serena-hooks remind --client claude-code` on every Read/Grep, so the binary must already be on `PATH`:

```sh
uv tool install git+https://github.com/oraios/serena@v1.7.0
```

That pin provides `serena`, `serena-agent`, and `serena-hooks`. Do **not** invoke `uvx --from git+…` from the hook: that writes `~/.cache/uv` on every call, the session sandbox denies it, and Read hangs behind PreToolUse.

Health-check and index remain one-shot `uvx` commands; see [docs/code-intelligence-health.md](docs/code-intelligence-health.md).

To test unpublished packages against a real profile:

```sh
pnpm run build
bash scripts/sync-local-profile.sh web
dsh web
```

To install/update the CC preset during local development:

```sh
bash scripts/sync-cc-preset.sh
```

See **[docs/dev.md](docs/dev.md)** for offline development details and repository-specific dependency rules.

## Packages and releases

Published plugins use the `@jianxx` npm scope. The root monorepo package is private; installable packages are released individually through the repository release tooling.

Release process details: **[docs/release.md](docs/release.md)**.

## Project status

`dsh-cc` is evolving alongside DeepSeek Harness. The compatibility surface can change as upstream adds new extension points or changes existing ones.

If you find a workflow that works differently from Claude Code, the [parity matrix](docs/cc-parity-matrix.md) is the best place to check whether it is implemented, partial, intentionally out of scope, or still missing.

Contributions, compatibility reports, and focused upstream extension proposals are welcome.
