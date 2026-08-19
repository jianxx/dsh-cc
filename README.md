# dsh-cc-plugins

Claude Code feature-parity plugins for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh), shipped as an out-of-repo plugin set that any dsh installation loads through its profile system.

## Layout

```text
packages/
  settings/settings-cascade        5-level settings file precedence (~ enterprise/user/project/local/flags)
  settings/settings-migrations     version-gated settings.json migrations on mount (mechanism ready; registry empty until the first format change)
  interaction/permission-rules     allow/deny/ask rule engine + mode state (CC /permissions semantics)
  interaction/command-status       /status
  interaction/command-doctor       /doctor
  interaction/command-memory       /memory — list/read CLAUDE-code-style memories
  interaction/command-skills       /skills — list installed skills
  interaction/command-help         /help — usage help
  interaction/command-config       /config — inspect/set settings
  interaction/command-permissions  /permissions — allow/deny/ask rules + mode
  interaction/command-version      /version — show product/version info
  interaction/command-release-notes  /release-notes — view release notes
  interaction/command-diff         /diff — diff CLAUDE.md / settings
  interaction/command-init         /init — scan project and scaffold CLAUDE.md
  interaction/command-plugin       /plugin — manage plugins
  interaction/command-mcp          /mcp — manage MCP server connections
  interaction/command-tasks        /tasks — show open tasks / todo
  interaction/command-resume        /resume — resume an interrupted session
  interaction/command-branch       /branch — worktree branch management
  mcp/mcp-client                   MCP client with OAuth 2.1 + resources + prompts (vendored superset)
  mcp/mcp-config                   `.mcp.json` parser → mcp-client registrations (library)
  hooks/hook-protocol              hook wire protocol incl. http executor (vendored superset)
  hooks/hooks-claude-code          CC hook bridge — 18 of 30 events (command + http executors)
  core/tools                       vendored tool registry + reserve()/isAdmitted() (deferred names)
  core/tool-search                 ToolSearch tool + DeferredToolRegistry
  core/tool-sleep                  Sleep tool (cooperative interrupt; CC SleepTool parity)
  core/tool-structured-output      StructuredOutput tool factory (CC SyntheticOutputTool parity)
  core/tool-notebook-edit          NotebookEdit tool (fs-seam .ipynb edits + read-before-write gate)
  skill/skill-claude-code          SKILL.md provider reading CC dirs; CC paths conditional activation + bundled subset (debug/simplify/batch)
  preset/claude-code-agents        `.claude/agents` → subagent providers (library)
  preset/cc                        CC Mode agent preset (composition-only: agent.cordis.yml + preset.yml)
  compat/cc-plugin-loader          mount a CC plugin directory (plugin.json) onto dsh seams (library)
  compat/cc-model-aliases          CC frontmatter model aliases → {provider, model} routes (library; wired by cc-shell)
  compat/cc-output-styles          CLAUDE.md output styles → system prompt
  memory/memory                    CLAUDE.md memories + memory_save write channel + recall (recentTools suppression) + opt-in team memory
  memory/memory-consolidation      background memory consolidation (structured fork output, host-side write-back)
  workspace/tool-git-worktree      EnterWorktree / ExitWorktree tools
  subagent/coordinator             coordinator mode (delegation-only agent surface)
  compaction/compaction-micro      model-free stale-result microcompaction
  session/command-cost|export|stats  /cost /export /stats
  bundle/cc-permissions            profile bundle: settings-cascade + permission-rules
  bundle/cc-shell                  profile bundle: everything else, plus the on-disk glue plugin (also mounts `dsh-tool-ask-user` AskUserQuestion over the base-owned `dsh-user-questions` seam and `dsh-schedule`)
  test-support/agent-loop-mock     vendored test fixture (not a plugin)
```

## Install (half a minute)

Prereq: a dsh CLI installation (`dsh` on PATH, version ≥ 0.1.0-rc.5).

```sh
# pick a profile name (created on first use); rc.6 add syntax:
dsh plugin --profile cc add <this-repo>   # or the published npm names / file: links

# compose: bundles are hoisted into the profile and listed in dsh.profile.bundles *ahead* of
# your own patch file, their roofs sorted before your cordis.patch.yml.
dsh --profile cc "your task"
```

`dsh plugin` forwards to pnpm in `$DSH_HOME/profiles/cc` and auto-registers every
installed package that declares `dsh.bundle` into `dsh.profile.bundles` (append on add,
drop on remove). Hoisted pnpm linking puts the whole plugin tree flat, while every
in-box dsh package (peer deps like `@deepseek-ai/cordis`) resolves through the
installer-maintained `$DSH_HOME/profiles/node_modules` symlink fallback — external
plugins always share the installation's single cordis instance.

Recommended order in `~/.dsh/profiles/cc/package.json`:

```json
{
  "dependencies": {
    "@jianxx/dsh-cc-bundle-permissions": "...",
    "@jianxx/dsh-cc-bundle-shell": "..."
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@jianxx/dsh-cc-bundle-permissions",
        "@jianxx/dsh-cc-bundle-shell"
      ]
    }
  }
}
```

Your own tweaks land in `~/.dsh/profiles/cc/cordis.patch.yml` (applied after every bundle).

### Local development without publishing

To test unpublished changes against a real profile instead of publishing first:

```sh
pnpm run build                       # emit lib/ per package
bash scripts/sync-local-profile.sh web   # flat-copy @jianxx/* into the profile
dsh web                             # profile bundles registration already in place, boots to a UI
```

`scripts/sync-local-profile.sh` copies (not symlinks) the built packages into the
profile so every `@deepseek-ai/*` import resolves through the installation's single
cordis instance — the same way a published bundle does. Re-run it after every build.

> On a network-restricted host, `pnpm install` stalls fetching per-package registry
> attestations even with `--offline`; see `docs/dev.md` for the offline recovery.

### CC Mode preset

CC Mode is dsh's **fifth** agent preset (the four built-in modes are unchanged —
see below). It exposes the full CC-parity surface from this repo as a single
selectable preset.

Install in two steps:

```sh
bash scripts/sync-local-profile.sh web   # install the @jianxx/* packages into the profile
bash scripts/sync-cc-preset.sh           # install the CC preset combo into ~/.dsh/.agent-presets/cc
```

The second script rsyncs `packages/preset/cc/agent.cordis.yml` and
`packages/preset/cc/preset.yml` into `~/.dsh/.agent-presets/cc` (respecting
`$DSH_HOME`). Re-run it whenever those files change, then restart dsh — the
preset list is re-scanned at the next boot.

Select the preset either through the web UI's preset selector, or by setting
`agent-presets.default="cc"` in settings. To uninstall, delete the
`~/.dsh/.agent-presets/cc` directory.

### Model aliases

CC agent frontmatter names models by alias (`model: opus`, `model: sonnet`,
`model: inherit`). The cc-shell glue resolves those aliases per spawn against
deployment defaults (`modelAliases` on the glue row) overlaid by the live
`model-aliases` settings namespace (user/project/local layering, `null`
deletes a configured entry). Unconfigured builtin aliases and `inherit` fall
back to the parent route; anything else passes through as a literal model id.
See `packages/compat/cc-model-aliases/README.md` for the full merge and
resolution semantics.

The four built-in modes are behaviorally unchanged: the host plane keeps only
the tools-registry fork, the five-level settings cascade + permission rules, and
settings migrations — none of which produces a visible change on the stock
modes.

## How the loading works (the mechanism our names rely on)

1. Bundles list "rows" in `cordis.patch.yml`; each row is an entry `{id, name, config?, insert?…}` the Loader interprets.
2. The dsh launcher resolves each bundle's `name` two-anchor: the dsh installation first, then the profile directory. This is why our packages use the `@jianxx` scope: a `@deepseek-ai/dsh-*` name would be shadowed by the in-box copy.
3. Inside a patch, each `name:` is resolved from the profile directory as base URL; hoisted node_modules carries the whole bundle dependency tree, so one profile dependency on a bundle pulls every plugin with it.
4. Plugins' peers (`@deepseek-ai/cordis`, service-definition packages like `@deepseek-ai/dsh-invariants`) are NOT bundled: they resolve via the installation-wide symlink fallback, keeping one cordis instance per process. Never ship them as our `dependencies`.

## Vendored packages (upstream + delta)

Four packages vendor upstream dsh packages plus our changes, because the deltas are invasive (not wrappable):

| package                   | delta                                         | why vendored                                                                                        |
| ------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `core/tools`              | +reserve/isAdmitted + reserved-name table     | extension-point methods on the Service Provider; free functions cannot see the private layer tables |
| `mcp/mcp-client`          | +OAuth 2.1 flows, +resources/prompts surfaces | same-module internal plumbing throughout the client                                                 |
| `hooks/hook-protocol`     | +http executor + dispatch options             | wire-protocol module shape                                                                          |
| `hooks/hooks-claude-code` | full CC event/executor bridge                 | only exists at all through the fork's expansion                                                     |

At runtime each sits beside its upstream peer under a different npm name. Where service identity matters, the bundle patch disables the in-box row by id and remounts ours under a **unique** id:

```yaml
- id: tools
  disabled: true
- insert:
    - id: tools-cc
      name: "@jianxx/dsh-cc-tools"
```

The disable marker targets the base row by its id, and the remount registers under a distinct id, because `cordis-plugin-loader` dup-checks _every_ incoming entry (a `{id, disabled: true}` marker included) — reusing the same id for the insert would throw `duplicate loader entry id` at mount. Service injection is name-keyed, not row-id-keyed, so the remount resolves the same underlying service. NOTE (upstream TODO): the id-keyed dump/compose path renders this disable+rename pattern fine, so the loader's stricter dup check diverges from it; worth splitting out an issue upstream.

Subscribers type against upstream service types — the vendored runtime is a structural superset; the two nominal `ToolExecutionToken` brands are bridged by explicit casts at the 6 mixed call sites (see coordinator / hooks-claude-code sources; documented in code) — never routed at runtime because only one `tools` registration exists per scope.

## Known limits (upstream vocabulary boundary)

- dsh session event vocabulary is closed in-repo today (`KNOWN_SESSION_EVENT_TYPES`, and `Session.append` only accepts envelope options for surface events). Out-of-repo plugins cannot log new event types safely: readers that meet an unknown non-ignorable type refuse to replay. Consequences we chose:
  - `permission-rules` keeps per-session mode overrides **in memory** (a WeakMap keyed by the live Session); a resumed session starts back at the deployment default mode. (The fork wrote a durable `permission/mode` event.)
  - `compaction-micro` no longer appends its log-only decision record; the replacement nodes already carry the deterministic marker, so decisions still reconstruct from replay + code.
- Track: ask upstream for either ignorable-aware `Session.append` or an event-registration surface; restore the durable records then.
- `hooks-codex` and `tool-cordis` fork deltas were NOT moved: they were generated-catalog/type-hygiene noise with no behavioral need on top of upstream.
- `tool-web-cc` mounts a fetch-capable web tool at the host plane (`fetch: true`, 60s search timeout), carrying the base `tool-web` row's caps. Because `dsh-web-app` deliberately moves `tool-web` behind agent presets and disables the base row, this host-plane insert intentionally bypasses that scoping for CC parity — watch for a duplicate/missing web tool in a UI pass.
- The LSP trio (`dsh-lsp` / `dsh-lsp-stdio` / `dsh-tool-lsp`) and the `web-fetch-http` executor are NOT shipped by the CLI dependency tree through rc.6, so their rows cannot resolve from the installation and are removed from `bundle/cc-shell`. Re-add them once the installation carries them (they are cordis-peer packages; version-skew untested).
- `user-questions` is owned by `dsh-base` (it has been since before rc.5), so the bundle no longer inserts it; `tool-ask-user` consumes the base-owned seam. A missing UI provider yields a graceful `NO_PROVIDER` tool error.
- On the WEB profile the native `/export` (a browser download stub from `dsh-web-app`'s session-log-download row) holds the name; our file-writing `/export` registers only where the name is free (CLI profiles). The plugin skips registration when `/export` is already registered.
- hooks `configPath` defaults to `$DSH_HOME/hooks.json` (resolved via `ctx.dshHomePath`); per-session project-local hook discovery remains a TODO.
- `/cost` ships an empty price table by default (`modelTable: []` in the bundle row). The schema stays strict because composition decides pricing — deployments must supply pricing where needed.
- Schedule (`dsh-schedule`) is session-local only: one-shot `after_seconds` delays, absolute `at` targets, and fixed-rate `every_seconds` (≥300s). Claude Code cron-expression parity is deferred upstream.

## Develop

```sh
pnpm install --frozen-lockfile    # offline-friendly: everything pins to the local dsh checkout via link:
pnpm run typecheck                # tsc -b (emits lib/ per package)
pnpm test                         # vitest
```

Upstream types resolve through `link:` devDeps into a sibling dsh checkout at
`../deepseek-harness` (built once with `pnpm run build` there). To publish for real,
replace link: devDeps with released version ranges and publish the vendored set under the @jianxx scope.

> Working on `pnpm-lock.yaml` or dependency declarations on a
> network-restricted host: see `docs/dev.md` for what the frozen-lockfile
> check actually verifies and the test-time dependency declaration contract.
