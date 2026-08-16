# Claude Code parity matrix

Single source of truth for how the dsh-cc-plugins stack (`@deepseek-ai/dsh-base` +
`cc-bundle-permissions` + `cc-bundle-shell`) covers Claude Code's user-facing
features. Status legend:

- ✅ implemented and mounted
- 🔶 partial (call out what's missing)
- ❌ missing (no design asset yet)
- 🚫 won't port (vendor-bound or out of scope, with reason)

The Claude Code reference inventory is the feature dump under
`~/workspace/github.com/claude-code` (external build surface). Event and
command counts below follow that build.

## Engine subsystems

| CC subsystem | Status | Where / notes |
|---|---|---|
| Agent loop + tool pipeline | ✅ | `@deepseek-ai/dsh-agent-loop`, `dsh-tools` (this repo's `core/tools` swap adds `reserve()`/`isAdmitted()` for deferred tools) |
| File tools (Read/Edit/Write), Glob/Grep | ✅ | `dsh-tool-fs`, `dsh-tool-fs-search`, `dsh-tool-str-replace-editor` |
| Bash / PowerShell + background jobs | ✅ | `dsh-tool-bash`/`dsh-tool-pwsh` + `dsh-jobs` + `dsh-tool-jobs`; CC's `TaskCreate/Output/Stop` naming not aliased |
| WebSearch | ✅ | `dsh-tool-web` + `dsh-web-search-deepseek` |
| WebFetch | 🔶 | mounted (`web-fetch-http`) but the provider has **no host allowlist** — model-directed requests reach any URL the process can reach; enable only on egress-restricted deployments. Upstream SSRF allowlist is a planned follow-up |
| Subagents / Agent tool / teams | ✅ | `dsh-subagent*` providers + `tool-subagent-control` (`send_message`/`interrupt`/`list_agents`); CC `.claude/agents` loaded via `preset/claude-code-agents` |
| Coordinator mode | ✅ | `subagent/coordinator` (`DSH_COORDINATOR_MODE=1`) |
| Workflow / Ralph loop | ✅ | `dsh-tool-workflow`, `dsh-tool-ralph` (base) |
| Plan mode | ✅ | `dsh-plan-mode` (base), incl. `/plan` |
| Todo list | 🔶 | `dsh-tool-todo` (base) is model-facing; human-facing `/tasks` lists jobs only — todo seam pending |
| Auto-compaction | ✅ | `dsh-compaction-basic` + `command-compact` (`/compact`) + tool-result pruner; this repo adds model-free `compaction-micro` |
| Session persistence / resume / fork | ✅ engine | jsonl/sqlite + projection + checkpoint policy; see command-surface row for `/resume` `/branch` limits |
| Skills system | ✅ | `skill-claude-code` loader + base `tool-skill`; CC's bundled skills not shipped |
| Plugin system | ✅ | `cc-plugin-loader` (agents/commands/hooks/mcp servers/skill/settings from `plugin.json`) + cc-shell-glue auto-discovery |
| Output styles | ✅ | `compat/cc-output-styles` + `/output-style` |
| Settings precedence | ✅ | `settings-cascade` (user/project/local/flags) |
| Permission rules | ✅ + 🔶 | rule engine + dangerous-command/path risk classifier. Per-session mode overrides are **in-memory** (resume reverts to deployment default) — durable `permission/mode` appends are staged separately, gated on the harness pin carrying the event type. Missing vs CC: ML/bash risk classifier service, managed/enterprise remote settings |
| Hooks | 🔶 | 16 of 30 events bridged (see table below); `command`+`http` executors always on, `prompt`/`agent` executors behind `enablePromptHooks`/`enableAgentHooks` (default off) |
| MCP client | ✅ | tools + resources + prompts + OAuth 2.1 |
| Memory / CLAUDE.md | ✅ | `memory` + `memory-consolidation` (AutoDream analog) |
| Cost / token tracking | ✅ | `token-meter` (base) + `/cost`; CC quota/limit surfaces are Anthropic-billing-bound 🚫 |
| Schedule / reminders | 🔶 | `@deepseek-ai/dsh-schedule` mounted: `after_seconds` / `at` / `every_seconds` (≥300s). CC's cron-expression selectors unsupported — upstream extension planned |
| Worktree tools | ✅ | `EnterWorktree`/`ExitWorktree` |
| ToolSearch (deferred tools) | ✅ | `core/tool-search` |
| Sandbox | ✅ | `dsh-sandbox-local` + policy (base) |
| Credentials | ✅ | `dsh-credentials-local` (base) |
| Notifications (bell/OS/iterm) | ❌ | no notification seam in deepseek-harness; needs a new design |
| Vim mode / keybindings / statusline / ghost text | ❌ | interactive-terminal features; the harness is headless/web-first — a terminal-REPL shell would be a separate design domain |
| IDE integration / LSP | 🔶 | upstream `dsh-lsp` exists but is not mounted; no `/ide`, no editor pods |
| Remote / web sessions | 🔶 different | CC `bridge/` is claude.ai-bound 🚫; dsh has its own web/host/sdk/acp stack outside this repo |
| Voice | 🚫 | vendor feature, no design asset |
| Buddy / KAIROS / undercover / ultraplan / computer-use | 🚫 | Anthropic-internal or vendor-bound |
| Onboarding / tips | ❌ | no package or design doc |

## Hook events (16 of 30 bridged)

Supported now: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`Stop`, `SubagentStart`, `SubagentStop`, `PermissionRequest`, `PermissionDenied`,
`Notification` (`permission_prompt` subtype only), `PostCompact`, `SessionEnd`,
`StopFailure`, `TaskCreated`, `TeammateIdle`, `Setup` (first-run approximation).

Not bridged (with reason):
- `PreCompact` — needs an upstream compaction waterfall seam (planned).
- `Notification` subtypes `idle_prompt` / `auth_success` / `elicitation*` — no
  equivalent seam in a headless harness (cannot map).
- `PostToolUseFailure`, `UserPromptCancel`, `SessionResume`, and the remaining
  CC event×source payload variants — tracked as hook-bridge follow-ups in the
  package README.

Executors: `command`, `http` (SSRF-allowlisted via `allowedHttpHookUrls`),
`prompt`, `agent` (forked subagent; gated by `enablePromptHooks` /
`enableAgentHooks`, default **off**).

## Command surface (/…)

Mounted CC-parity commands (20): `/cost`, `/doctor`, `/export`, `/stats`,
`/status`, `/output-style`, `/memory`, `/skills`, `/help`, `/config`,
`/permissions`, `/version`, `/release-notes`, `/diff`, `/init`, `/plugin`,
`/reload-plugins`, `/mcp`, `/tasks`, plus base `plan-mode`'s `/plan`.

Degraded by design (documented):
- `/resume` — lists sessions; switching is host-owned (`dsh --resume <id>`).
- `/branch` — forks and reports the child id; switching requires restart.
- `/config` — text-only render/patch with an allowlisted key set.
- `/init` — drives a follow-up turn that writes/refreshes `CLAUDE.md`.

Excluded: `/model`, `/clear`, `/exit` (host-owned), `/copy` (no clipboard seam),
`/rewind` (needs checkpoint/file-snapshot design — deferred), billing/login
commands (🚫 vendor-bound).

## Deferred upstream items

1. Durable permission-mode overrides — needs `permission/mode` in the pinned
   harness's session event vocabulary (the type already exists locally in
   deepseek-harness master; bump the presubmit pin once that harness build
   is the one CI builds).
2. SSRF host allowlist for `web-fetch-http` (then un-caveat WebFetch).
3. Cron-expression selector for `dsh-schedule` (then full `ScheduleCronTool`
   parity).
4. `PreCompact` interception seam in `dsh-compaction`.
5. Human-facing todo-list seam for `/tasks`.
