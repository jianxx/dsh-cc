# @jianxx/dsh-cc-command-doctor

English | [中文](README.zh.md)

Human-facing `/doctor` command: an environment self-check that reports the package version, settings reachability, and the mounted capability seams (enumerating LLM providers where the seam exposes a list). The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md), so every composed command adapter discovers and executes it without a model turn.

## Command contract

| Input | Result |
|---|---|
| `/doctor` | Show the harness version (from this package's manifest), whether the settings service is reachable, and each capability seam's mount status — `shell`, `subprocess`, `fs`, `skills`, `web`, `lsp`, and `llm`. The `llm` seam, when mounted, also lists its registered provider ids. |

Every line is a pure read of mounted services and version metadata; no model call and no token is consumed. A seam whose service is absent reports `not mounted`.

## Composition

The producer injects `commands`. A custom app mounts its owner plus this plugin:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-doctor
  name: '@jianxx/dsh-cc-command-doctor'
```

The seam lines reflect the actual composition, so a headless or bare-bones app reports exactly what it mounts.

## Model Experience

The slash input and the direct diagnostic output are absent from model requests and consume no model tokens. Presentation text is never logged.

## Known Limitations and Deferred Work

- **Presence-only for most seams** — only `llm` exposes a public provider enumeration; the other seams report mounted/absent without provider lists.
- **Version is the package manifest** — the command reports the shared harness version read from its own `package.json`, not a `ctx`-injectable version.
