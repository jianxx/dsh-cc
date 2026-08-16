# dsh-cc-plugins

Claude Code feature-parity plugins for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh), shipped as an out-of-repo plugin set that any dsh installation loads through its profile system.

This repository holds the CC-parity work that used to live inside a `jianxx/deepseek-harness` fork: the harness is back on upstream, and every addition lives here as independently installable packages.

## Layout

```
packages/
  settings/settings-cascade        5-level settings file precedence (~ enterprise/user/project/local/flags)
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
  hooks/hooks-claude-code          27-event CC hook bridge (command + http executors)
  core/tools                       vendored tool registry + reserve()/isAdmitted() (deferred names)
  core/tool-search                 ToolSearch tool + DeferredToolRegistry
  skill/skill-claude-code          SKILL.md provider reading CC directories
  preset/claude-code-agents        `.claude/agents` → subagent providers (library)
  compat/cc-plugin-loader          mount a CC plugin directory (plugin.json) onto dsh seams (library)
  compat/cc-output-styles          CLAUDE.md output styles → system prompt
  memory/memory                    CLAUDE.md memories + recall
  memory/memory-consolidation      background memory consolidation
  workspace/tool-git-worktree      EnterWorktree / ExitWorktree tools
  subagent/coordinator             coordinator mode (delegation-only agent surface)
  compaction/compaction-micro      model-free stale-result microcompaction
  session/command-cost|export|stats  /cost /export /stats
  bundle/cc-permissions            profile bundle: settings-cascade + permission-rules
  bundle/cc-shell                  profile bundle: everything else, plus the on-disk glue plugin
  test-support/agent-loop-mock     vendored test fixture (not a plugin)
```

## Install (half a minute)

Prereq: a dsh CLI installation (`dsh` on PATH, version ≥ 0.1.0-rc.5).

```sh
# pick a profile name (created on first use)
dsh plugin cc add <this-repo>            # or the published npm names / file: links

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
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@jianxx/dsh-cc-bundle-permissions", "@jianxx/dsh-cc-bundle-shell"] } }
}
```

Your own tweaks land in `~/.dsh/profiles/cc/cordis.patch.yml` (applied after every bundle).

## How the loading works (the mechanism our names rely on)

1. Bundles list "rows" in `cordis.patch.yml`; each row is an entry `{id, name, config?, insert?…}` the Loader interprets.
2. The dsh launcher resolves each bundle's `name` two-anchor: the dsh installation first, then the profile directory. This is why our packages use the `@jianxx` scope: a `@deepseek-ai/dsh-*` name would be shadowed by the in-box copy.
3. Inside a patch, each `name:` is resolved from the profile directory as base URL; hoisted node_modules carries the whole bundle dependency tree, so one profile dependency on a bundle pulls every plugin with it.
4. Plugins' peers (`@deepseek-ai/cordis`, service-definition packages like `@deepseek-ai/dsh-invariants`) are NOT bundled: they resolve via the installation-wide symlink fallback, keeping one cordis instance per process. Never ship them as our `dependencies`.

## Vendored packages (upstream + delta)

Four packages vendor upstream dsh packages plus our changes, because the deltas are invasive (not wrappable):

| package | delta | why vendored |
|---|---|---|
| `core/tools` | +reserve/isAdmitted + reserved-name table | extension-point methods on the Service Provider; free functions cannot see the private layer tables |
| `mcp/mcp-client` | +OAuth 2.1 flows, +resources/prompts surfaces | same-module internal plumbing throughout the client |
| `hooks/hook-protocol` | +http executor + dispatch options | wire-protocol module shape |
| `hooks/hooks-claude-code` | full CC event/executor bridge | only exists at all through the fork's expansion |

At runtime each sits beside its upstream peer under a different npm name. Where service identity matters, the bundle patch disables the in-box row and mounts ours under the same cordis `id`:

```yaml
- id: tools
  disabled: true
- insert:
    - id: tools
      name: '@jianxx/dsh-cc-tools'
```

Subscribers type against upstream service types — the vendored runtime is a structural superset; the two nominal `ToolExecutionToken` brands are bridged by explicit casts at the 6 mixed call sites (see coordinator / hooks-claude-code sources; documented in code) — never routed at runtime because only one `tools` registration exists per scope.

## Known limits (upstream vocabulary boundary)

- dsh session event vocabulary is closed in-repo today (`KNOWN_SESSION_EVENT_TYPES`, and `Session.append` only accepts envelope options for surface events). Out-of-repo plugins cannot log new event types safely: readers that meet an unknown non-ignorable type refuse to replay. Consequences we chose:
  - `permission-rules` keeps per-session mode overrides **in memory** (a WeakMap keyed by the live Session); a resumed session starts back at the deployment default mode. (The fork wrote a durable `permission/mode` event.)
  - `compaction-micro` no longer appends its log-only decision record; the replacement nodes already carry the deterministic marker, so decisions still reconstruct from replay + code.
- Track: ask upstream for either ignorable-aware `Session.append` or an event-registration surface; restore the durable records then.
- `hooks-codex` and `tool-cordis` fork deltas were NOT moved: they were generated-catalog/type-hygiene noise with no behavioral need on top of upstream.
- `web-fetch-http` ships NO host allowlist. Enabling fetch means model-directed requests can reach any URL the dsh process can reach — enable it only on egress-restricted deployments. An upstream allowlist is a planned follow-up.
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

> Local release-age verification: after edits that touch `pnpm-lock.yaml`, re-run the
> cached-record refresh (see `docs/dev.md`) so pnpm's supply-chain verification keeps
> its fast path on network-restricted hosts.
