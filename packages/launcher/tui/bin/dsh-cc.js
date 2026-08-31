#!/usr/bin/env node
/**
 * Optional shortcut for `dsh --profile tui`. Canonical command remains
 * `dsh --profile tui`. Do not ship a `dsh-tui` bin — that name belongs to
 * the unrelated published dsh-TUI product.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapCommand, continueHint, interceptResume, parseWorktreeFlag, planWorktree, PROFILE, slugRetryDecision, worktreeAddArgv, worktreeEnv } from '../bootstrap.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ownVersion = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version

if (process.argv.includes('--version') || process.argv.includes('-V')) {
  console.log(ownVersion)
  process.exit(0)
}

const probe = spawnSync('dsh', ['--version'], { encoding: 'utf8' })
if (probe.error || probe.status !== 0) {
  console.error('dsh-cc: the `dsh` CLI is not on PATH.')
  console.error('Install deepseek-harness first, e.g.:  npm install -g @deepseek-ai/dsh')
  process.exit(1)
}

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', PROFILE)
const add = bootstrapCommand(existsSync(join(profileDir, 'package.json')), ownVersion)
if (add !== undefined) {
  console.error(`dsh-cc: initializing profile "${PROFILE}"…`)
  const installed = spawnSync('dsh', add, { encoding: 'utf8', stdio: 'inherit' })
  if (installed.status !== 0) {
    console.error(`dsh-cc: plugin install failed. Retry:\n  dsh ${add.join(' ')}`)
    process.exit(installed.status ?? 1)
  }
}

const env0 = { ...process.env }

// `--worktree [name]` is intercepted here (never forwarded to dsh): the
// launcher creates `<repoRoot>/.claude/worktrees/<slug>` itself and starts
// the session inside it, marking it via DSH_CC_WORKTREE so the TUI offers
// cleanup at /quit time.
const worktree = parseWorktreeFlag(process.argv.slice(2))
let spawnCwd
if (worktree.name !== undefined) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  if (top.error || top.status !== 0) {
    console.error('dsh-cc: --worktree requires a git repository (run from inside a git working tree).')
    process.exit(1)
  }
  const repoRoot = top.stdout.trim()
  // Drop stale registrations left by crashed sessions before planning paths.
  spawnSync('git', ['-C', repoRoot, 'worktree', 'prune'], { encoding: 'utf8' })
  const head = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  if (head.error || head.status !== 0) {
    console.error('dsh-cc: could not resolve HEAD; is this a repository without commits?')
    process.exit(1)
  }
  const named = worktree.name !== null
  let plan = null
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    let candidate
    try {
      candidate = planWorktree(repoRoot, worktree.name)
    } catch (error) {
      console.error(`dsh-cc: ${error.message}`)
      process.exit(1)
    }
    const collision = existsSync(candidate.worktreePath)
      ? `path already exists: ${candidate.worktreePath}`
      : null
    let failure = collision
    if (failure === null) {
      const add = spawnSync('git', ['-C', repoRoot, ...worktreeAddArgv(candidate)], { encoding: 'utf8' })
      if (add.error || add.status !== 0) {
        failure = (add.stderr ?? (add.error ? String(add.error) : '')).trim() || 'git worktree add failed'
      }
    }
    if (failure === null) {
      plan = candidate
      break
    }
    if (slugRetryDecision({ named, attempt }) === 'fail') {
      console.error(`dsh-cc: could not create worktree "${candidate.slug}": ${failure}`)
      if (named) {
        console.error('dsh-cc: pick another name, or remove the stale one: '
          + `git -C ${repoRoot} worktree remove --force ${candidate.worktreePath}`)
      }
      process.exit(1)
    }
  }
  if (plan === null) {
    console.error('dsh-cc: could not allocate a worktree name after several attempts; try --worktree <name>.')
    process.exit(1)
  }
  Object.assign(env0, worktreeEnv(plan, repoRoot, head.stdout.trim()))
  spawnCwd = plan.worktreePath
  console.error(`dsh-cc: worktree "${plan.slug}" at ${plan.worktreePath} (branch ${plan.branch})`)
}

const { env, args, continueRequested } = interceptResume(undefined, worktree.args, env0)
let marker = null
if (env.DSH_CC_RESUME_SESSION === undefined) {
  try {
    marker = readFileSync(join(home, 'tui', 'resume.txt'), 'utf8').trim()
  } catch {
    // No marker is the common first-run case.
  }
  if (marker !== null && marker.length > 0) env.DSH_CC_RESUME_SESSION = marker
}
const hint = continueHint(continueRequested, env.DSH_CC_RESUME_SESSION, marker)
if (hint !== null) console.error(hint)
env.NODE_ENV ??= 'production'

const child = spawn('dsh', ['--profile', PROFILE, ...args], {
  env,
  stdio: 'inherit',
  ...(spawnCwd === undefined ? {} : { cwd: spawnCwd }),
})
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
