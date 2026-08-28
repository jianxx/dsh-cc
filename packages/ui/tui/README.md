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
- Ctrl+S — inject every queued message into the running turn immediately
- ↑ (empty composer) — recall the most recent queued message into the composer for editing; with a non-empty composer, ↑ walks composer history
- `/quit` — exit
- `/model` — list or switch the live LLM route
- `/resume [id]` — list persisted sessions, or pin the next launch id
- other `/commands` — harness catalog (CC preset), including `/permissions`

## Queueing

Messages submitted while a turn is running are parked in an outbox (shown as
`⏵ queued:` chips) instead of being injected into the running turn. The outbox
flushes automatically into a new turn when the current one ends — including on
errors and aborts — or immediately via Ctrl+S. Idle submits send directly and
never enter the outbox, so only unsent messages can be recalled with ↑. An
interrupt clears the outbox.
