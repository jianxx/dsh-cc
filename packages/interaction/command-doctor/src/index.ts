/**
 * Human-facing `/doctor` command: an environment self-check that reports the
 * package version, settings reachability, and the mounted capability seams
 * (enumerating LLM providers where the seam exposes a list).
 * @module @jianxx/dsh-cc-command-doctor
 */

import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { readHookDiagnostics } from '@jianxx/dsh-cc-hook-protocol'
import { formatDoctorReport, type DoctorReport, type SeamStatus } from './doctor.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver, provided by @deepseek-ai/dsh-app-boot at boot. Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
  }
}

export const name = 'command-doctor'
export const inject = ['commands']

/**
 * Read this package's manifest version, mirroring `apps/cli`'s self-version
 * read: every harness package shares `0.1.0-rc.x`, so the command package's own
 * manifest carries the harness version.
 * @returns the version string, or `0.0.0` when the manifest is unreadable.
 */
export function readVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** The seam names `/doctor` checks for presence without documentation. */
const SEAMS = ['shell', 'subprocess', 'fs', 'skills', 'web', 'lsp'] as const

/** How many valid diagnostics lines to read back: 10 for display, and the
 * same unbounded read counts every valid line for `total`. The writer caps
 * the file at 256 KB (≈ hundreds of entries), so one large-limit read is
 * cheap and keeps the gather simple. */
const HOOK_DIAGNOSTICS_READ_LIMIT = 1_000_000

/**
 * Read a dsh-home path without throwing when the boot-provided `dshHomePath`
 * resolver is absent — cordis throws on the property access itself (not a
 * plain `undefined`), so every read must be guarded. Mirrors the
 * hooks-claude-code bridge's `dshHomeFile` helper.
 */
function dshHomeFile(ctx: Context, ...segments: string[]): string | undefined {
  try {
    return ctx.dshHomePath?.(...segments)
  } catch {
    return undefined
  }
}

/** Read the hook diagnostics JSONL under the dsh home, best-effort. */
function gatherHooks(ctx: Context): DoctorReport['hooks'] {
  const path = dshHomeFile(ctx, 'hooks', 'diagnostics.jsonl')
  if (path === undefined) return { issues: [], total: 0 }
  const all = readHookDiagnostics(path, HOOK_DIAGNOSTICS_READ_LIMIT)
  return { issues: all.slice(-10), total: all.length, path }
}

/** Whether a named capability-seam service is mounted. */
function mounted(ctx: Context, name: (typeof SEAMS)[number]): boolean {
  return ctx.get(name) !== undefined
}

/** Gather the environment report from the composed services. */
function gatherReport(ctx: Context): DoctorReport {
  const seams: SeamStatus[] = []
  for (const name of SEAMS) {
    seams.push({ name, mounted: mounted(ctx, name) })
  }
  const llm = ctx.get('llm')
  if (llm !== undefined) {
    const providers = llm.listProviders()
    const detail = providers.length === 0
      ? undefined
      : providers.map(provider => provider.id).join(', ')
    seams.push({
      name: 'llm',
      mounted: true,
      ...detail === undefined ? {} : { detail },
    })
  } else {
    seams.push({ name: 'llm', mounted: false })
  }
  return {
    version: readVersion(),
    settings: ctx.get('settings') !== undefined,
    seams,
    hooks: gatherHooks(ctx),
  }
}

/** Execute `/doctor` against the composed context. */
function executeDoctor(ctx: Context): CommandResult {
  return { kind: 'success', text: formatDoctorReport(gatherReport(ctx)) }
}

/**
 * Register the `/doctor` command for every composed command adapter.
 * @param ctx - context carrying the command registry.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'doctor',
    description: 'run an environment self-check of services, seams, and version',
    handler: (_invocation: CommandInvocation) => executeDoctor(ctx),
  })
}
