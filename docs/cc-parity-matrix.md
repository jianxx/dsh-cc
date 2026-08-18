# Claude Code parity matrix

Single source of truth for how the dsh-cc-plugins stack (`@deepseek-ai/dsh-base` +
`cc-bundle-permissions` + `cc-bundle-shell`) covers Claude Code's user-facing
features. Status legend:

- ✅ implemented and mounted
- 🔶 partial (call out what's missing)
- ❌ missing (no design asset yet)
- 🚫 won't port (vendor-bound or out of scope, with reason)

## Mode placement (host plane vs preset plane)

How the stack is split across dsh's planes when CC Mode is the active preset.

**Host plane — globally retained, no visible change for the four built-in modes:**

- `@jianxx/dsh-cc-tools` (tools-registry fork + deferred capability)
- `@jianxx/dsh-cc-settings-cascade` and `@jianxx/dsh-cc-permission-rules`
  (the `cc-permissions` bundle)
- `@jianxx/dsh-cc-settings-migrations`

**Preset plane — CC mode only:** `tool-search`, `skill-claude-code`,
`cc-shell-glue`, `memory`, `memory-consolidation`, `cc-output-styles`,
`compaction-micro`, `coordinator`, `schedule` (upstream package),
`tool-git-worktree`, `tool-sleep`, `tool-notebook-edit`,
`tool-structured-output`, `hooks-claude-code`, and the 19 `command-*` packages.
Among those, `command-plugin` and `command-mcp` sit in the same `cc-services`
isolate group as `tool-search`, `compaction-micro`, and `cc-shell-glue`:
`mcpConnections` must be isolated, and the two command packages consume those
same services, so they share the group.

**Not reassigned — the untouched upstream host face:** the `system-prompt`
service, the `subagents` registry, and `tokenMeter` (kept per the existing
dsh-web-app surgery criteria).

## Engine subsystems

| CC subsystem                            | Status    | Where / notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent loop + tool pipeline              | ✅        | `@deepseek-ai/dsh-agent-loop`, `dsh-tools` (this repo's `core/tools` swap adds `reserve()`/`isAdmitted()` for deferred tools). CC↔harness tool-name translation lives in `core/tools/src/cc-names.ts` (`translateToolNames` strict/lenient for `restrict()`-bound lists, `ccToolAliases` for rule/matcher matching, `ccCanonicalToolName` for CC-facing payloads) — agent/skill frontmatter, permission rules, and hook matchers all consume it                                                                            |
| File tools (Read/Edit/Write), Glob/Grep | ✅        | `dsh-tool-fs`, `dsh-tool-fs-search`, `dsh-tool-str-replace-editor`                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Bash / PowerShell + background jobs     | ✅        | `dsh-tool-bash`/`dsh-tool-pwsh` + `dsh-jobs` + `dsh-tool-jobs`; CC's `TaskCreate/Output/Stop` naming not aliased                                                                                                                                                                                                                                                                                                                                                                                                           |
| WebSearch                               | ✅        | `dsh-tool-web` + `dsh-web-search-deepseek`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| WebFetch                                | 🔶        | mounted (`web-fetch-http`) but the provider has **no host allowlist** — model-directed requests reach any URL the process can reach; enable only on egress-restricted deployments. Upstream SSRF allowlist is a planned follow-up                                                                                                                                                                                                                                                                                          |
| Subagents / Agent tool / teams          | ✅        | `dsh-subagent*` providers + `tool-subagent-control` (`send_message`/`interrupt`/`list_agents`); CC `.claude/agents` loaded via `preset/claude-code-agents`                                                                                                                                                                                                                                                                                                                                                                 |
| Coordinator mode                        | ✅        | `subagent/coordinator` (`DSH_COORDINATOR_MODE=1`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Workflow / Ralph loop                   | ✅        | `dsh-tool-workflow`, `dsh-tool-ralph` (base)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Plan mode                               | ✅        | `dsh-plan-mode` (base), incl. `/plan`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Todo list                               | 🔶        | `dsh-tool-todo` (base) is model-facing; human-facing `/tasks` lists jobs only — todo seam pending                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Auto-compaction                         | ✅        | `dsh-compaction-basic` + `command-compact` (`/compact`) + tool-result pruner; this repo adds model-free `compaction-micro`                                                                                                                                                                                                                                                                                                                                                                                                 |
| Session persistence / resume / fork     | ✅ engine | jsonl/sqlite + projection + checkpoint policy; see command-surface row for `/resume` `/branch` limits                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Skills system                           | ✅        | `skill-claude-code` loader + base `tool-skill`; CC `paths` conditional activation ✅; bundled skills subset (debug/simplify/batch) ✅ — CC's `verify`/`stuck` not ported (ant-only, `verify` companion files absent)                                                                                                                                                                                                                                                                                                       |
| Plugin system                           | ✅        | `cc-plugin-loader` (agents/commands/hooks/mcp servers/skill/settings from `plugin.json`) + cc-shell-glue auto-discovery                                                                                                                                                                                                                                                                                                                                                                                                    |
| Model aliases                           | ✅        | `compat/cc-model-aliases` (`@jianxx/dsh-cc-model-aliases`) — `model:` frontmatter aliases (`sonnet`/`opus`/`haiku`/`fable` + open set) resolve to `{provider, model}` routes; `inherit` and unconfigured-builtin aliases inherit the parent route (fixes the old `inherit` pass-through bug); settings `model-aliases` overlay + config `modelAliases` defaults, null-delete, builtin fallback. Follow-ups: `/model` command, `ANTHROPIC_*` env vars (no Anthropic semantics), and aliasing the main-session default model |

| Output styles | ✅ | `compat/cc-output-styles` + `/output-style` |
| Settings precedence | ✅ | `settings-cascade` (user/project/local/flags) |
| Settings migrations | ✅ | `settings/settings-migrations` (`@jianxx/dsh-cc-settings-migrations`) — version-gated `runMigrations` over an atomically-written settings.json, auto-run on mount; mechanism only (no real migrations yet) |
| Permission rules | ✅ + 🔶 | rule engine + dangerous-command/path risk classifier. Per-session mode overrides are **in-memory** (resume reverts to deployment default) — durable `permission/mode` appends are staged separately, gated on the harness pin carrying the event type. Missing vs CC: ML/bash risk classifier service, managed/enterprise remote settings |
| Hooks | 🔶 | 18 of 30 events bridged (see table below); `command`+`http` executors always on, `prompt`/`agent` executors behind `enablePromptHooks`/`enableAgentHooks` (default off) |
| MCP client | ✅ | tools + resources + prompts + OAuth 2.1 |
| Memory / CLAUDE.md | ✅ | `memory` + `memory-consolidation` (AutoDream analog); `memory_save` tool is the save channel (the memdir sits outside the session sandbox, so direct Write is fenced; forks report structured output and the plugins write host-side under a memdir-confined per-call policy); recall suppresses reference-doc memories for recently used tools; opt-in `teamEnabled` shared team memory (`memoryHome/team`) with a seam-native symlink/containment validation chain |
| Cost / token tracking | ✅ | `token-meter` (base) + `/cost`; CC quota/limit surfaces are Anthropic-billing-bound 🚫 |
| Schedule / reminders | 🔶 | `@deepseek-ai/dsh-schedule` mounted: `after_seconds` / `at` / `every_seconds` (≥300s). CC's cron-expression selectors unsupported — upstream extension planned |
| Worktree tools | ✅ | `EnterWorktree`/`ExitWorktree` |
| Sleep tool | ✅ | `tool-sleep` (`@jianxx/dsh-cc-tool-sleep`) — `Sleep` with cooperative interrupt-cancel and concurrency-safe semantics aligned to CC's SleepTool |
| StructuredOutput (synthetic output tool) | ✅ | `core/tool-structured-output` (`@jianxx/dsh-cc-tool-structured-output`) — `StructuredOutput` validates the model's final output against a caller-supplied JSON schema and echoes it back, aligned to CC's SyntheticOutputTool; registered only when a schema is declared |
| NotebookEdit | ✅ | `core/tool-notebook-edit` (`@jianxx/dsh-cc-tool-notebook-edit`) — `NotebookEdit` edits Jupyter notebook (.ipynb) cells over the `ctx.fs` seam with CC's replace/insert/delete, real-id + `cell-<n>` addressing, and a read-before-write gate on `fs/observed` |
| AskUserQuestion | ✅ | mounted via `dsh-user-questions` + `dsh-tool-ask-user` (harness 包，工具名 `ask_user_question`；UI provider 归宿主 app，无 provider 时优雅报错) |
| ToolSearch (deferred tools) | ✅ | `core/tool-search` |
| Sandbox | ✅ | `dsh-sandbox-local` + policy (base) |
| Credentials | ✅ | `dsh-credentials-local` (base) |
| Notifications (bell/OS/iterm) | ❌ | no notification seam in deepseek-harness; needs a new design |
| Vim mode / keybindings / statusline / ghost text | ❌ | interactive-terminal features; the harness is headless/web-first — a terminal-REPL shell would be a separate design domain |
| IDE integration / LSP | ✅ | mounted via `dsh-lsp`/`dsh-lsp-stdio`/`dsh-tool-lsp` 三包（`ctx.lsp` provider registry + stdio provider + 模型工具 `lsp`，goToDefinition/findReferences/goToImplementation/hover）；`/ide` 与 editor pods 属交互壳范畴，headless 仍不适用 |
| Remote / web sessions | 🔶 different | CC `bridge/` is claude.ai-bound 🚫; dsh has its own web/host/sdk/acp stack outside this repo |
| Voice | 🚫 | vendor feature, no design asset |
| Buddy / KAIROS / undercover / ultraplan / computer-use | 🚫 | Anthropic-internal or vendor-bound |
| Onboarding / tips | ❌ | no package or design doc |

## Hook events (18 of 30 bridged)

Supported now: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `Stop`, `SubagentStart`, `SubagentStop`,
`PermissionRequest`, `PermissionDenied`, `Notification` (`permission_prompt`
subtype only), `PostCompact`, `SessionEnd`, `StopFailure`, `TaskCreated`,
`TeammateIdle`, `Setup` (first-run approximation), `SessionResume` (`resume`
source only).

Not bridged (with reason):

- `PreCompact` — needs an upstream compaction waterfall seam (planned).
- `Notification` subtypes `idle_prompt` / `auth_success` / `elicitation*` — no
  equivalent seam in a headless harness (cannot map).
- `UserPromptCancel` — no dsh cancel seam; the bridge does not do a lossy
  approximation (not bridged by design).
- `SessionResume` `clear`/`compact` sources — no dsh emit point (pending; only
  `resume` is bridged).
- The remaining CC event×source payload variants — tracked as hook-bridge
  follow-ups in the package README.

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
6. Memory freshness — CC threads `mtimeMs` through recall and ages memories
   (`memoryAge`). Both depend on the harness `FsInfo` carrying mtime; the
   current `dsh-fs` seam does not expose it, so mtime tracking and `memoryAge`
   are deferred until the seam grows an mtime field (see the Memory row above
   and the `memory` package README Known Limitations).
