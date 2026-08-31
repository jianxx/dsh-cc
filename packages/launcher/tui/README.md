# @jianxx/dsh-cc

Optional `dsh-cc` bin. Canonical command is still `dsh --profile tui`.

First run bootstraps `$DSH_HOME/profiles/tui` with the three CC bundles.
`--resume <id>` is lifted into `DSH_CC_RESUME_SESSION` and not forwarded to
the launcher.

`--worktree [name]` starts the session inside a fresh git worktree at
`<repoRoot>/.claude/worktrees/<slug>` on branch `worktree-<slug>` (random
slug when no name is given). The launcher creates the worktree, marks the
session via `DSH_CC_WORKTREE`, and the TUI offers to keep or remove the
worktree at `/quit`. Requires a git repository with at least one commit.

This package does **not** ship a `dsh-tui` binary.
