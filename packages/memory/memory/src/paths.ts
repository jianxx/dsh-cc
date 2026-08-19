/**
 * Memdir root resolution: the default harness-home memory directory plus an
 * optional per-project `.claude/memory` overlay. All reads go through the
 * optional `ctx.fs` seam so remote backends work unchanged.
 * @module @jianxx/dsh-cc-memory/paths
 */

import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { defaultDshHome } from '@deepseek-ai/dsh-home-paths'

/** Directory label for the project-scoped memory overlay. */
export const PROJECT_MEMORY_DIR = '.claude/memory'

/** Directory label grouping the per-workspace memory directories. */
export const PROJECTS_DIR = 'projects'

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
 * Encode a workspace path as a single filesystem-safe directory name. Ported
 * from upstream `projectKey` (`session-persistence-jsonl/src/format.ts`),
 * minus the `--` wrapper, so a workspace's memory directory matches the slug
 * used in `~/.dsh/sessions/--<slug>--`: separators and drive colons collapse
 * to `-`, unsafe code units escape as `~XXXX`, leading dashes strip, and the
 * result truncates to 251 chars (fallback `root`).
 * @param cwd - the workspace path to encode.
 * @returns the workspace slug.
 */
export function projectSlug(cwd: string): string {
  if (cwd.length === 0) return 'root'
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return slug.slice(0, 251)
}

/**
 * Resolve the per-workspace private memory directory under a memory home:
 * `<home>/projects/<slug>` where the slug encodes the workspace cwd.
 * @param home - the resolved memory home (the global layer's directory).
 * @param cwd - the workspace path this directory is private to.
 * @returns the workspace memory directory.
 */
export function resolveWorkspaceMemoryDir(home: string, cwd: string): string {
  return join(home, PROJECTS_DIR, projectSlug(cwd))
}

/**
 * The workspace path an agent's memories belong to: the session's bound cwd,
 * falling back to the process cwd when the header carries none.
 * @param agent - the agent whose workspace is needed.
 * @returns the workspace cwd.
 */
export function cwdOf(agent: Agent): string {
  return agent.session.header.cwd ?? process.cwd()
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
