# dsh-memory

English | [中文](README.zh.md)

Claude Code-style file-based memory for the DeepSeek Harness: a durable memdir
format, a `memory` system-prompt section, and dynamic recall by a forked
side-query. All file access goes through the optional `ctx.fs` seam, so a
remote or sandboxed backend works unchanged (a providerless host mounts memory
as a no-op).

## What this package provides

- **Memdir format** — a memory directory (default the harness home's `memory/`,
  plus an optional per-project `.claude/memory` overlay) with an always-loaded
  `MEMORY.md` entrypoint (capped at 200 lines / 25 KB) that is a one-line index
  of `.md` topic files. Each topic file carries `name`, `description`, and
  `type` (`user` / `feedback` / `project` / `reference`) frontmatter plus a
  Markdown body. The parser is independently exported.
- **`memory` system-prompt section** — the entrypoint content (truncated), an
  index of topic files by frontmatter, and grep search guidance. When
  `MEMORY.md` is absent the section renders empty (no error). The section text
  is assembled synchronously, so a background scan through `ctx.fs` caches the
  rendered text and emits `system-prompt/change` to re-assemble after a change.
- **Dynamic recall** — an `agent/pre-step` listener asks a small-model side
  query (a forked subagent via `ctx.subagents`) which topic files are relevant
  to the turn, then injects their bodies through `agent.inject()`. Recall
  deduplicates: topic files already shown this session are never re-injected.
  Tools used earlier in the session are tracked (`tools/post-execute`) and
  passed to the selector so reference-doc memories for an actively-used tool
  are suppressed (warnings/gotchas about it are still surfaced). Absence of the
  subagent service or provider skips recall without error.
- **Team memory (opt-in)** — when `teamEnabled` is `true`, a shared
  per-project team directory (`memoryHome/team`) is layered on the private
  memdir and the `memory` section renders a combined private + team prompt.
  Every team-memory access runs a seam-native validation chain (pure-string key
  sanitization first, then `lstat` final-segment symlink rejection, then
  `resolve` + `contains` prefix containment).

## Usage

Load the plugin with `@jianxx/dsh-cc-memory`. Configuration knobs:

| Key | Default | Meaning |
|---|---|---|
| `memoryHome` | harness home `memory/` | memory directory root |
| `sectionEnabled` | `true` | register the `memory` system-prompt section |
| `recallEnabled` | `true` | run dynamic recall on pre-step |
| `recallProviderName` | `fork` | one-shot subagent provider for the recall query |
| `teamEnabled` | `false` | enable the shared team memory directory + combined section |

> **`teamEnabled` is off by default.** Enabling it changes the persisted
> memory layout (creates and reads `memoryHome/team/`), changes what the model
> writes (`private` vs `team` scope), and points team-memory reads at a shared
> directory. It is intended for single-tenant, trusted-writer projects: the
> per-access validation closes traversal, but the *intermediate*-component
> TOCTOU window is not fully closed (only the final segment is `lstat`-checked,
> and the resolve/containment check and the read are not atomic). Do not enable
> `teamEnabled` in multi-tenant or untrusted-writer deployments.

```ts
import memory from '@jianxx/dsh-cc-memory'
await ctx.plugin(memory, { memoryHome: '/tmp/mem' })
```

## Model Experience

Baseline cost: one synchronous render of the cached section text per step (no
I/O). The cheapest path additionally scans the memory directory — when it
contains topics, recall may spend one small-model subagent call per turn until
all topics have been shown, then stops. Token growth is bounded by the
entrypoint truncation caps and the five-file recall ceiling.

## API

- `parseMemoryFile(raw)` — split a topic file into frontmatter + body.
- `scanMemoryDirectory(fs, dir, signal?)` — read the entrypoint and topic index.
- `renderMemorySection(dir, state)` — the private section text from a scanned state.
- `renderTeamMemorySection(privateDir, teamDir, privateState, teamState)` — the combined private + team section text.
- `MemorySection` — background-refresh cache holder for the section.
- `MemoryRecall` — the pre-step recall coordinator.
- `truncateEntrypointContent(raw)` — apply the line/byte caps.
- `resolveMemoryHome`, `resolveProjectMemoryRoot` — memdir root helpers.
- `sanitizePathKey(key)`, `validateTeamMemKey(fs, teamDir, relativeKey)`,
  `resolveTeamMemoryRoot(home)` — the team-memory security chain and path helpers.

## Known Limitations and Deferred Work

- The `ctx.fs` seam exposes no mtime, so recall deduplication tracks shown
  paths per session rather than mtime+path; content is re-read fresh each
  injection, which still reflects on-disk changes. CC's `memoryAge` freshness
  weighting is therefore deferred until the seam carries mtime (see
  `docs/cc-parity-matrix.md`).
- The recall side-query relies on a registered one-shot subagent provider; no
  provider ships with this package (compose `fork` or `spawn`).
- Write-side enforcement (who may write topic files) lives in
  `dsh-memory-consolidation`; this package only reads.
- Team memory (`teamEnabled`) reversibility and safety: enabling it is a
  persisted-format change, and the intermediate-component TOCTOU window (only
  the final segment is `lstat`-checked; resolve/containment and the read are
  not atomic) means it must not be enabled in multi-tenant or untrusted-writer
  deployments.
