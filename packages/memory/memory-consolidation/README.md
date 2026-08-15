# dsh-memory-consolidation

English | [中文](README.zh.md)

Background memory consolidation for the DeepSeek Harness: turn-end extraction
and the three-gate dream rewrite of the memory directory that `dsh-memory`
reads.

## What this package provides

- **extractMemories** — an `agent/turn-stopping` listener starts a background
  forked subagent (via `ctx.jobs` + `ctx.subagents`, tools restricted to the
  memory directory) that extracts durable facts from the turn and appends them
  to the matching topic files.
- **Dream consolidation** — three configurable gates that must all pass before
  a read-only forked subagent reviews past sessions and rewrites `MEMORY.md`
  and the topic files:
  1. **Time** — at least `minHours` (default 24) since the last consolidation.
  2. **Session count** — at least `minSessions` (default 5) new transcripts.
  3. **Lock** — a `.consolidation-lock` file whose stored timestamp enforces
     mutual exclusion; a stale holder (older than `lockStaleMs`, default 1 hour)
     is reclaimed, so a crash mid-consolidation recovers automatically. A
     failed or killed consolidation rolls the lock back so the time gate
     re-opens.
- **Memory writes change model-visible context** — upstream, `dsh-memory`
  re-assembles the `memory` system-prompt section via `system-prompt/change`
  after the memory directory changes. This package introduces no new session
  events for the memory files themselves.

## Usage

Load the plugin with `@jianxx/dsh-cc-memory-consolidation`. Configuration:

| Key | Default | Meaning |
|---|---|---|
| `memoryHome` | harness home `memory/` | memory directory root |
| `extractEnabled` | `true` | run turn-end extraction |
| `dreamEnabled` | `true` | run the three-gate dream |
| `minHours` | `24` | minimum hours between consolidations |
| `minSessions` | `5` | minimum new transcripts to consolidate |
| `lockStaleMs` | `3_600_000` | lock holder stale window |
| `subagentProviderName` | `fork` | one-shot provider for the forks |

```ts
import consolidation from '@jianxx/dsh-cc-memory-consolidation'
await ctx.plugin(consolidation, { minHours: 24, minSessions: 5 })
```

## Model Experience

The turn-stopping listener is nearly free when the gates are closed (one lock
read). When the time and session gates open, one forked subagent runs per
consolidation, restricted to read/search plus memory-write tools; its output is
not appended to the main transcript. Per turn, extraction may start a
short background fork.

## API

- `tryAcquireLock(fs, dir, pid, now)` / `rollbackLock(fs, dir, priorAt)` /
  `readLastConsolidatedAt(fs, dir)` — the consolidation lock.
- `gatesPass(input)` / `timeGatePasses(...)` / `sessionGatePasses(...)` — the
  gate predicates.
- `MEMORY_TOOL_FILTER` / `MEMORY_AGENT_TOOLS` — the memory-scoped tool set.
- `buildExtractionPrompt` / `buildConsolidationPrompt` — the fork prompts.

## Known Limitations and Deferred Work

- The `ctx.fs` seam exposes no mtime, so the lock stores the holder PID and
  last-consolidated epoch in the lock file's body rather than in the file
  mtime; crash recovery rests on the stale window, not process-liveness.
- The session-count gate currently counts live sessions through `ctx.sessions`
  and treats them as new; a clocked transcript query is deferred.
- Tool path-scoping of Write/Edit is enforced by prompt contract, not by a
  path-aware tool guard.
