/**
 * Memdir root resolution: the default harness-home memory directory plus an
 * optional per-project `.claude/memory` overlay. All reads go through the
 * optional `ctx.fs` seam so remote backends work unchanged.
 * @module @jianxx/dsh-cc-memory/paths
 */

import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { defaultDshHome } from '@deepseek-ai/dsh-home-paths'

/** Directory label for the project-scoped memory overlay. */
export const PROJECT_MEMORY_DIR = '.claude/memory'

/**
 * Resolve the default (harness-home) memory root. A configured root wins;
 * otherwise the shared harness home.
 * @param configured - an explicit root, or `undefined` for the default.
 * @returns the resolved harness-home memory directory.
 */
export function resolveMemoryHome(configured?: string): string {
  return configured !== undefined && configured.length > 0
    ? configured
    : join(defaultDshHome(), 'memory')
}

/**
 * Disco the project-scoped memory root for a cwd, or `undefined` when the
 * filesystem service is absent or no project root is reachable.
 * @param ctx - the host context carrying the optional `fs` service.
 * @param cwd - the descendant path whose project root bounds the overlay.
 * @returns the project memory directory, or `undefined` when not discoverable.
 */
export async function resolveProjectMemoryRoot(
  ctx: Context,
  cwd: string,
): Promise<string | undefined> {
  const fileSystem = ctx.get('fs')
  if (fileSystem === undefined) return undefined
  const cwdResolved = await readResolve(fileSystem, cwd, ctx)
  const root = await findProjectRoot(cwdResolved, fileSystem)
  if (root === undefined) return undefined
  return join(root, PROJECT_MEMORY_DIR)
}

async function readResolve(fs: FileSystem, path: string, ctx: Context): Promise<string> {
  try {
    return (await fs.resolve(path)).displayPath
  } catch (error) {
    ctx.logger.warn(`memory: failed to resolve cwd ${path}: ${String(error)}`)
    return path
  }
}

async function findProjectRoot(cwd: string, fs: FileSystem): Promise<string | undefined> {
  let current = cwd
  while (true) {
    if (await pathExists(fs, join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

async function pathExists(fs: FileSystem, path: string): Promise<boolean> {
  try {
    const target = await fs.resolve(path)
    return await fs.stat(target) !== undefined
  } catch {
    // A backend may refuse or hide the candidate; keep walking upward.
    return false
  }
}
