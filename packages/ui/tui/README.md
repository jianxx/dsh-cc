# @jianxx/dsh-cc-tui

Claude Code-style terminal surface for DeepSeek Harness. Mounted by
`@jianxx/dsh-cc-bundle-tui` on the **`tui`** profile; new sessions compose the
**`cc`** agent preset.

This package is a protocol driver: it observes `session/event` and drives
`Agent.followup()` / `cancel()`. It does not ship CC tools or slash commands —
those stay on `packages/preset/cc`.

## Boot

```sh
dsh plugin --profile tui add @jianxx/dsh-cc-bundle-permissions \
  @jianxx/dsh-cc-bundle-shell @jianxx/dsh-cc-bundle-tui
dsh --profile tui
```

Do not add this bundle to the `web` profile. Web coexistence is two profiles,
one backend.

## Keys

- Shift+Tab — cycle CC permission modes (`default` → `acceptEdits` → `plan` → `auto` → `bypassPermissions`)
- Esc — interrupt the current turn
- Ctrl+C — interrupt while a turn is running; when idle, the first press opens a 2s exit window with a hint and a second press inside it exits, so a stray Ctrl+C never kills the session
- Ctrl+S — inject every queued message into the running turn immediately
- Ctrl+T — toggle the todo panel overlay (arrow keys move the highlight; Esc or a second Ctrl+T closes it)
- Ctrl+O — toggle global collapse: thinking blocks and tool output fold to one-line summaries, and pressing it again restores them
- ↑ (empty composer) — recall the most recent queued message into the composer for editing; with a non-empty composer, ↑ walks composer history
- Tab — complete slash-command arguments after the command name (supported for `/model` and `/resume`)
- `/quit` — exit
- `/model` — list or switch the live LLM route
- `/resume [id]` — list persisted sessions, or pin the next launch id
- other `/commands` — harness catalog (CC preset), including `/permissions`

## Rendering

- File-edit cards render diffs as hunks with gutter line numbers; long
  unchanged runs between hunks collapse to a dim `… N unchanged lines …`
  marker, and oversized diffs clip on hunk boundaries instead of mid-hunk.
- Consecutive completed file reads fold into one `⏺ Read N files` summary
  line; a running, errored, or lone read keeps its own row.
- The footer reports exact context occupancy — `ctx 43% (86k/200k)` — when the
  model's context window is known, dropping the parenthetical when the line
  is too narrow to fit it.
- Notices under the composer are transient: they clear themselves after a few
  seconds instead of lingering.

## Queueing

Messages submitted while a turn is running are parked in an outbox (shown as
`⏵ queued:` chips) instead of being injected into the running turn. The outbox
flushes automatically into a new turn when the current one ends — including
after a failed turn — or immediately via Ctrl+S. Idle submits send directly and
never enter the outbox, so only unsent messages can be recalled with ↑.
Interrupting (Esc or Ctrl+C while busy) clears the outbox instead of flushing
it.
