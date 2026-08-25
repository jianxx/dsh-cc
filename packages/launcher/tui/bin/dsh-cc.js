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
import { bootstrapCommand, interceptResume, PROFILE } from '../bootstrap.mjs'

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

const { env, args } = interceptResume(undefined, process.argv.slice(2), { ...process.env })
env.NODE_ENV ??= 'production'

const child = spawn('dsh', ['--profile', PROFILE, ...args], { env, stdio: 'inherit' })
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
