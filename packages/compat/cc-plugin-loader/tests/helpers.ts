/**
 * Test helpers: throwaway plugin fixture directories and fake seams for the
 * cc-plugin-loader unit tests.
 *
 * @module
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

/** Create a fresh temp plugin root; call `dispose` to remove it. */
export async function tempPluginRoot(): Promise<{ root: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'cc-plugin-loader-'))
  return {
    root,
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}

/** Write a file under the fixture root, creating parent directories. */
export async function writeFileAt(root: string, relativePath: string, contents: string): Promise<void> {
  const dir = join(root, dirnameOf(relativePath))
  if (dir !== root && dir !== '.') await mkdir(dir, { recursive: true })
  await writeFile(join(root, relativePath), contents, 'utf8')
}

/** Write a `SKILL.md` under `<root>/skills/<skill>/SKILL.md`. */
export async function writeSkill(
  root: string,
  skill: string,
  frontmatter: Record<string, unknown>,
  body = '',
): Promise<string> {
  const dir = join(root, 'skills', skill)
  await mkdir(dir, { recursive: true })
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')
  const path = join(dir, 'SKILL.md')
  await writeFile(path, `---\n${fm}\n---\n\n${body}`, 'utf8')
  return path
}

/** A fresh cordis context for effect-lifecycle tests. */
export function makeContext(): Context {
  return new Context()
}

function dirnameOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}
