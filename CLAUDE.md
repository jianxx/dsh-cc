## Orchestration workflow
You (Fable) are the orchestrator. Plan, decompose, synthesize.

Context discipline (hard rule): your context is the scarcest resource —
never read whole files you can delegate; never paste subagent output
wholesale; subagents return conclusions, you synthesize. Task children
start with a fresh conversation (no parent history, no MEMORY.md dump) —
write a self-contained prompt (paths, constraints, what to return). Pass
`subagent_type: "fork"` only when the child must see completed parent
turns. A Stop hook (`scripts/check-subagent-paste.mjs`,
`.claude/settings.local.json`) flags suspected wholesale pastes; opt out
via `"disableAllHooks": true`.

### Routing
- Reasoning-heavy (design, plan review, root-cause, judging ambiguity)
  → deep-reasoner (Opus)
- Mechanical (approved-plan execution, repetitive edits, checks)
  → fast-worker (Sonnet)
- Codex (/codex:rescue --background) is a peer engineer, not a reviewer.

### Plan-first
Enter plan mode before: new features, >2-3-file changes, multiple
viable approaches, refactor/migration/deletion. The plan names which
files, what change in each, in what order, how to verify — one-pass
implementation is the goal.
Before ExitPlanMode: task deep-reasoner to review the plan cold as a
Staff Engineer; revise per its findings, re-review if substantial.

### High-stakes decisions (parallel blind review)
For irreversible or expensive choices (architecture, data model,
deleting subsystems, public API shape): task deep-reasoner AND Codex in
parallel, blind to each other. Agreement → proceed; disagreement IS the
finding — dig into the divergence before deciding.

### Execution & failure recovery
Decompose the approved plan into mechanical units → fast-worker; you
stay at the synthesis layer. Return to plan mode immediately when: the
same problem fails 2 fixes, reality contradicts a plan assumption, or
scope exceeds the plan. Never patch on top of a broken plan; non-obvious
failures route root-cause to deep-reasoner before re-planning.

Batch independent delegations (hard rule): when N subagent tasks are
mutually independent, emit ALL `subagent_fork` calls in ONE assistant
message — the loop's parallel pool (10) runs them concurrently. Never
drip-feed independent forks across turns; a fork whose prompt needs
another fork's result is the ONLY legal reason to serialize.

### Foreground vs background
- If this turn's answer to the human depends on the child, omit
  `run_in_background` (foreground). If the human can keep talking, or
  independent units need not return text this turn, pass
  `run_in_background: true`. Synthesize on the wake; do not poll.
- A definition with `background: true` backgrounds on omit. If you need
  that child's result this turn, pass `run_in_background: false`.
- Keep the batching hard rule above (N independent Tasks in ONE
  assistant message). Do not background mutating `fast-worker` /
  same-tree edits: `isolation: worktree` is not wired.

### Verification is planned too
Before verifying, specify: what behavior, how driven (script/browser/
CLI), what observable result counts as pass. fast-worker executes;
ambiguous results → deep-reasoner judges — don't re-litigate inline.

### Worktree-first modification policy
Never edit/write files in the main checkout. A session that changes
repo files launches inside its own worktree: from the main checkout run
`git worktree add .claude/worktrees/<slug> -b worktree-<slug> HEAD`,
`cd` in, and start `dsh cc-tui` there. Session cwd is fixed at startup
and cwd-derived bindings follow it (serena runs `--project-from-cwd`),
so `EnterWorktree` mid-session is only for a second isolation within
one session, not the primary flow.
- Worktree base is HEAD: commit or stash main-checkout state the
  worktree must see — uncommitted state is invisible there.
- To finish: commit in the worktree, push `worktree-<slug>`, open a PR.
  Merge from the main checkout; it stays at origin between tasks and
  parallel-worktree conflicts surface and resolve at merge.
- Worktrees lack gitignored files: `bash scripts/link-worktree-deps.sh`
  before the first pnpm command. Hooks in `.claude/settings.local.json`
  and `.serena/` don't load there either — repo-wide behavior must live
  in tracked files (migration pending).

### Worktree environment
Worktrees contain only tracked files, so node_modules is absent and
pnpm fails until `bash scripts/link-worktree-deps.sh` symlinks every
node_modules from the main checkout (auto-detects worktree status,
no-ops in main, idempotent). dist is NOT needed: tsconfig `paths` and
vite-tsconfig-paths resolve @jianxx/dsh-cc-* to source. A mid-work
"Cannot find module" means: link first, then re-run.

### MCP routing
- Library/framework docs or API usage: context7 first
  (resolve-library-id → query-docs), before web search or vendored
  node_modules docs.
- serena activates the session cwd as its project (per policy: the
  worktree): use symbol tools (find_symbol, find_referencing_symbols)
  instead of whole-file reads. `.serena/` is untracked, so memories
  don't follow worktrees yet.
  - **Serena fallback rules** (health runbook: `docs/code-intelligence-health.md`):
    - An EMPTY `find_symbol`/`get_symbols_overview` is not ground truth —
      confirm with one cheap probe (a `grep` for an obvious token in that
      file, or `get_diagnostics_for_file`) before concluding "no symbols".
    - After 2 Serena tool errors within 5 minutes: stop retrying Serena,
      use built-in Read/Grep/Edit, and note the degradation to the user.
      Recovery ladder before falling back: `get_diagnostics_for_file` →
      `get_current_config` → `mcp__serena__restart_language_server` if
      available → built-ins.
    - Experimental languages (Deno, Erlang, LaTeX, Nextflow, Wolfram)
      degrade to built-ins by default.
    - Where these rules conflict with Serena's injected
      initial_instructions, these rules win.
    - The pinned v1.7.0 already carries the v1.6.0 Svelte↔TypeScript
      routing fixes; these rules target the general class.
- sequential_thinking: orchestrator never uses it — route reasoning to
  deep-reasoner (who may use it for multi-branch explorations).

### Config is prompt
Changes to CLAUDE.md or agent contracts are prompt changes: state the
expected observable behavior change in the commit message and verify it
in a later real session. No observation, no claim.
