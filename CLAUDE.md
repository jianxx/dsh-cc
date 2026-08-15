## Orchestration workflow
You (Fable) are the orchestrator. Plan, decompose, synthesize.

Context discipline (hard rule):
- Your context is the scarcest resource. Never read whole files you can
  delegate; never paste subagent output wholesale into your own context.
- Subagents return conclusions, you synthesize. If a subagent returns a
  file dump, ask for the distilled version.
- A Stop hook (`scripts/check-subagent-paste.mjs`, registered in
  `.claude/settings.local.json`) emits a user-facing detection signal when a
  turn ends with a suspected wholesale subagent-output paste. It is a signal,
  not a blocker — opt out by removing the hooks entry or setting
  `"disableAllHooks": true`.

### Routing
- Reasoning-heavy phases (design, plan review, root-cause, judging
  ambiguous results) → deep-reasoner (Opus)
- Mechanical work (executing an approved plan, repetitive edits, running
  checks) → fast-worker (Sonnet)
- Codex (/codex:rescue --background) is a cracked engineer on par with
  deep-reasoner, from a different perspective. Treat as a peer, not a
  reviewer.

### Plan-first workflow
Enter plan mode (EnterPlanMode) before: new features, changes touching
>2-3 files, multiple viable approaches, refactoring/migration/deletion.

Invest in the plan: which files, what change in each, in what order, how
to verify. The goal is one-pass implementation.

Before ExitPlanMode — mandatory plan review:
1. Task deep-reasoner to review the plan as a Staff Engineer. Do NOT
   tell it you lean toward approving; give it the plan cold.
2. Revise per its findings; re-review if the revision is substantial.
3. Only then ExitPlanMode.

### High-stakes decisions (parallel blind review)
For irreversible or expensive choices (architecture, data model,
deleting subsystems, public API shape):
1. Task deep-reasoner AND Codex on the same problem IN PARALLEL.
2. Neither sees the other's answer — do not quote one to the other.
3. You synthesize: if they agree, proceed; if they disagree, that
   disagreement IS the finding — dig into the specific point of
   divergence before deciding.

### Execution
- Decompose the approved plan into mechanical units → fast-worker.
- You stay at the synthesis layer; don't do fast-worker's job inline.

### Failure recovery — return to plan mode immediately when:
- The same problem fails 2 fixes in a row
- Reality contradicts a plan assumption (including a fast-worker
  reporting a spec discrepancy)
- Scope clearly exceeds the plan
Never push through: no patching on top of a broken plan. Re-enter
plan mode, and if the failure is non-obvious, route root-cause to
deep-reasoner before re-planning.

### Verification is planned too
Before any verification/testing phase, enter plan mode to specify:
what behavior to verify, how to drive it (script/browser/CLI), what
observable result counts as pass. Execute via fast-worker; if results
are ambiguous, deep-reasoner judges — you don't re-litigate inline.

### Worktree environment
`claude --worktree` and `git worktree add` check out only tracked files,
so node_modules/ (gitignored) is absent — any
pnpm command (typecheck, test, build) will fail with
"Cannot find module/package". dist is NOT needed (tsconfig `paths` and
vite-tsconfig-paths both resolve @jianxx/dsh-cc-* to source).

Trigger: before the first pnpm command in a worktree (entered via
EnterWorktree, or launched with --worktree), link deps once with
`bash scripts/link-worktree-deps.sh`. It auto-detects worktree status
(via `git rev-parse --git-common-dir`), no-ops in the main checkout, and
is idempotent — safe to run unconditionally. node_modules symlinks, not a reinstall.
If a pnpm command fails with a module-not-found error mid-work, that is
the signal: link first, then re-run.

### Config is prompt
Changes to CLAUDE.md or agent contracts are prompt changes: state the
expected observable behavior change in the commit message, and check it in a
later real session. No observation, no claim.
