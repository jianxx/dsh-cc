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
  Absence of the subagent service or provider skips recall without error.

## Usage

Load the plugin with `@jianxx/dsh-cc-memory`. Configuration knobs:

| Key | Default | Meaning |
|---|---|---|
| `memoryHome` | harness home `memory/` | memory directory root |
| `sectionEnabled` | `true` | register the `memory` system-prompt section |
| `recallEnabled` | `true` | run dynamic recall on pre-step |
| `recallProviderName` | `fork` | one-shot subagent provider for the recall query |

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
- `renderMemorySection(dir, state)` — the section text from a scanned state.
- `MemorySection` — background-refresh cache holder for the section.
- `MemoryRecall` — the pre-step recall coordinator.
- `truncateEntrypointContent(raw)` — apply the line/byte caps.
- `resolveMemoryHome`, `resolveProjectMemoryRoot` — memdir root helpers.

## Known Limitations and Deferred Work

- The `ctx.fs` seam exposes no mtime, so recall deduplication tracks shown
  paths per session rather than mtime+path; content is re-read fresh each
  injection, which still reflects on-disk changes.
- The recall side-query relies on a registered one-shot subagent provider; no
  provider ships with this package (compose `fork` or `spawn`).
- Write-side enforcement (who may write topic files) lives in
  `dsh-memory-consolidation`; this package only reads.
