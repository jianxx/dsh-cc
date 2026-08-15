/**
 * Mount a Claude Code plugin's skills.
 *
 * Discovers `SKILL.md` skills in the plugin's standard `skills/` directory and
 * any inline manifest `skills` paths, parses each with the skill-claude-code
 * frontmatter translator, registers it on the skill registry as a runtime
 * skill, and wires the consumer-side activation semantics (allowed-tools,
 * `context: fork`, `paths`, MCP-source shell). Every registration is a Cordis
 * effect so unmounting the plugin recalls it.
 *
 * @module
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  ccInvocation,
  discoverCcSkills,
  parseCcFrontmatter,
  parseCcFrontmatterDocument,
  type CcSkillFile,
  type CcSkillMetadata,
} from '@jianxx/dsh-cc-skill-loader'
import { isSkillName, type SkillDefinition } from '@deepseek-ai/dsh-skill'
import type { CcPluginManifest } from './types.ts'
import { ComponentTally } from './seams.ts'
import { PROVIDER, registerSkillPathActivator, activationFor } from './skill-semantics.ts'

/** Skills live under this directory in a plugin root, when present. */
export const STANDARD_SKILLS_DIR = 'skills'

/** The skill registry seam that accepts runtime skill registrations. */
export interface SkillsSeam {
  /**
   * Register a runtime skill definition.
   * @param skill - the skill definition to register.
   * @returns the exact disposer that unregisters the skill.
   */
  register(skill: unknown): () => void
}

/** Options for mounting one plugin's skills. */
export interface MountSkillsOptions {
  /** Active context carrying the `fs/observed` event for path activation. */
  readonly ctx: Context
  /** The plugin root directory; standard `skills/` resolves against it. */
  readonly pluginRoot: string
  /** The parsed manifest, whose `skills` paths add extra skill roots. */
  readonly manifest: CcPluginManifest
  /** The skill registry seam (probed; `undefined` to skip skills). */
  readonly skills: SkillsSeam | undefined
  /** The subagent seam presence (drives `context: fork` routing). */
  readonly subagentsPresent: boolean
}

/**
 * Discover and register a plugin's skills, wiring activation semantics.
 * @param options - plugin root, manifest, and the skill/subagent seams.
 * @returns mounted disposers and per-component counts.
 */
export async function mountSkills(options: MountSkillsOptions): Promise<{ disposers: (() => void)[]; tally: ComponentTally }> {
  const tally = new ComponentTally('skills')
  const disposers: (() => void)[] = []
  if (options.skills === undefined) {
    tally.addSkipped('skill registry seam "skills" is not mounted')
    return { disposers, tally }
  }
  const roots = skillRoots(options.pluginRoot, options.manifest)
  if (roots.length === 0) {
    tally.addSkipped('plugin ships no skills directory or manifest skills paths')
    return { disposers, tally }
  }
  const files = await discoverCcSkills({ dshHome: resolve(options.pluginRoot), additionalDirs: roots })
  if (files.length === 0) {
    tally.addSkipped('plugin ships no skills')
    return { disposers, tally }
  }
  for (const file of files) {
    const loaded = await loadSkillFile(file)
    if (loaded === undefined) {
      tally.addFailed(`could not parse skill "${file.name}"`)
      continue
    }
    if (!isSkillName(file.name)) {
      tally.addFailed(`skill "${file.name}" has an invalid registry name`)
      continue
    }
    const { parsed, body } = loaded
    const metadata = toMetadata(file, parsed)
    const definition: SkillDefinition = {
      name: file.name,
      description: parsed.description,
      ...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
      invocation: ccInvocation(parsed),
      source: 'project-dsh',
      provider: PROVIDER,
      resourceBase: { kind: 'directory', path: file.directory },
      path: file.path,
      content: body,
      metadata: metadata as unknown as Readonly<Record<string, unknown>>,
    }
    disposers.push(options.skills.register(definition))
    disposers.push(registerSkillPathActivator(options.ctx, definition, options.pluginRoot))
    activationFor(metadata, options.subagentsPresent)
    tally.addLoaded()
  }
  return { disposers, tally }
}

/** Standard plus manifest skills roots, resolved against the plugin root. */
function skillRoots(pluginRoot: string, manifest: CcPluginManifest): string[] {
  const roots: string[] = []
  roots.push(join(pluginRoot, STANDARD_SKILLS_DIR))
  for (const path of manifest.skills) {
    roots.push(resolve(pluginRoot, path))
  }
  return roots
}

/** Read and parse one skill file's frontmatter and body. */
async function loadSkillFile(file: CcSkillFile): Promise<{ parsed: CcPluginFrontmatter; body: string } | undefined> {
  let raw: string
  try {
    raw = await readFile(file.path, 'utf8')
  } catch {
    return undefined
  }
  const document = parseCcFrontmatterDocument(raw)
  const parsed = parseCcFrontmatter(raw)
  if (document === undefined || parsed === undefined) return undefined
  return { parsed, body: document.body }
}

/** The frontmatter surface the loader's metadata builder reads. */
type CcPluginFrontmatter = ReturnType<typeof parseCcFrontmatter> & {}

/** Build CC metadata for a parsed plugin skill, mirroring the provider's view. */
function toMetadata(file: CcSkillFile, parsed: CcPluginFrontmatter): CcSkillMetadata {
  return {
    allowedTools: parsed.allowedTools,
    arguments: parsed.arguments,
    deprecated: file.deprecated,
    source: 'additional',
    unknown: parsed.unknown,
    ...parsed.argumentHint !== undefined ? { argumentHint: parsed.argumentHint } : {},
    ...parsed.version !== undefined ? { version: parsed.version } : {},
    ...parsed.model !== undefined ? { model: parsed.model } : {},
    ...parsed.executionContext !== undefined ? { executionContext: parsed.executionContext } : {},
    ...parsed.agent !== undefined ? { agent: parsed.agent } : {},
    ...parsed.effort !== undefined ? { effort: parsed.effort } : {},
    ...parsed.shell !== undefined ? { shell: parsed.shell } : {},
    ...parsed.hooks !== undefined ? { hooks: parsed.hooks } : {},
    ...parsed.paths !== undefined ? { paths: parsed.paths } : {},
  }
}
