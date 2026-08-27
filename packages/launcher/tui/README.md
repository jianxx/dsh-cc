# @jianxx/dsh-cc

Optional `dsh-cc` bin. Canonical command is still `dsh --profile tui`.

First run bootstraps `$DSH_HOME/profiles/tui` with the three CC bundles.
`--resume <id>` is lifted into `DSH_CC_RESUME_SESSION` and not forwarded to
the launcher.

This package does **not** ship a `dsh-tui` binary.
