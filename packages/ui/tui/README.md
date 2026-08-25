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
- `/quit` — exit
- other `/commands` — harness catalog (CC preset)
