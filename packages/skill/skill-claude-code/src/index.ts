/**
 * Claude Code skill-format compatible provider for the `ctx.skills` registry.
 *
 * This package discovers `SKILL.md` skills in Claude Code's directory layout
 * (managed, project, user, and additional roots), parses the full Claude Code
 * frontmatter spec, and serves them through `@deepseek-ai/dsh-skill`. It is a
 * compatibility provider: the harness can consume skills written for Claude
 * Code without copying the runtime that executes them.
 *
 * @module @jianxx/dsh-cc-skill-loader
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  isSkillName,
  type SkillCandidate,
  type SkillDefinition,
  type SkillInvocationPolicy,
  type SkillLookupOptions,
  type SkillProvider,
  type SkillProviderControl,
  type SkillSource,
} from '@deepseek-ai/dsh-skill'
import { discoverCcSkills, type CcSkillFile } from './discovery.ts'
import {
  parseCcFrontmatter,
  parseCcFrontmatterDocument,
  type ParsedCcFrontmatter,
} from './frontmatter.ts'
import type { CcInvocationPolicy, CcSkillMetadata } from './types.ts'

export type { CcSkillMetadata, CcInvocationPolicy } from './types.ts'
export { parseCcFrontmatter, parseCcFrontmatterDocument, type ParsedCcFrontmatter } from './frontmatter.ts'
export { estimateFrontmatterTokens, renderSkillBody, substituteArguments, extractInlineShell } from './render.ts'
export { ccRestriction, ccPathMatcher, registerPathActivator } from './translate.ts'
export { discoverCcRoots, discoverCcSkills, type CcSkillFile, type CcRoot, type CcSkillSource } from './discovery.ts'

export const name = 'skill-claude-code'
export const inject = ['skills']

const DEFAULT_PROVIDER_NAME = 'claude-code'
const MANAGED_SOURCE: SkillSource = 'managed'
const PROJECT_SOURCE: SkillSource = 'project-dsh'
const USER_SOURCE: SkillSource = 'user-dsh'
const ADDITIONAL_SOURCE: SkillSource = 'custom'

/** Claude Code skill provider configuration. */
export interface Config {
  /** Unique provider name. Defaults to `claude-code`. */
  providerName?: string
  /** Harness home that owns the user skill root. */
  dshHome?: string
  /** Optional managed policy skill root, scanned before all defaults. */
  managedDir?: string
  /** Additional skill roots appended after project and user roots. */
  additionalDirs?: string[]
}

export const Config: Schema<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  dshHome: z.string(),
  managedDir: z.string(),
  additionalDirs: z.array(z.string()).default([]),
})

/**
 * Register the Claude Code skill provider on `ctx.skills`.
 * @param ctx - active context carrying the skill registry.
 * @param config - provider configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.skills.registerProvider((control) => {
    return new ClaudeCodeSkillProvider(ctx, control, config)
  })
}

/** Provider that maps Claude Code skill directories into `ctx.skills`. */
export class ClaudeCodeSkillProvider implements SkillProvider {
  readonly name: string
  private readonly dshHome: string
  private readonly managedDir: string | undefined
  private readonly additionalDirs: readonly string[]

  constructor(
    private readonly ctx: Context,
    _control: SkillProviderControl,
    config: Config = {},
  ) {
    this.name = config.providerName ?? DEFAULT_PROVIDER_NAME
    this.dshHome = resolveDshHome(config.dshHome)
    this.managedDir = config.managedDir === undefined ? undefined : resolve(config.managedDir)
    this.additionalDirs = (config.additionalDirs ?? []).map(dir => resolve(dir))
  }

  /**
   * Discover Claude Code skills for a cwd-sensitive workspace.
   * @param options - lookup options; `cwd` selects the project root to scan.
   * @returns provider candidates, one per discovered `SKILL.md`.
   */
  async list(options: SkillLookupOptions): Promise<SkillCandidate[]> {
    const files = await discoverCcSkills({
      dshHome: this.dshHome,
      managedDir: this.managedDir,
      projectCwd: options.cwd,
      additionalDirs: this.additionalDirs,
    })
    const candidates: SkillCandidate[] = []
    for (const file of files) {
      const parsed = await this.parseFile(file)
      if (parsed === undefined) continue
      candidates.push(this.toCandidate(file, parsed))
    }
    return candidates
  }

  /**
   * Load a complete Claude Code skill body from a candidate's file.
   * @param candidate - the winning candidate returned by this provider.
   * @returns the full skill definition, or `undefined` if the file disappeared.
   */
  async get(candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const file = candidate.locator as CcSkillFile
    const loaded = await loadCcSkillFile(file.path)
    if (loaded === undefined) return undefined
    const parsed = loaded.parsed
    if (!validCcName(parsed)) return undefined
    return this.toDefinition(candidate, file, parsed, loaded.body)
  }

  private async parseFile(file: CcSkillFile): Promise<ValidCcName | undefined> {
    const loaded = await loadCcSkillFile(file.path)
    if (loaded === undefined) return undefined
    const parsed = loaded.parsed
    if (!validCcName(parsed)) {
      this.ctx.logger.warn(`Claude Code skill ${file.path} ignored: invalid or missing name`)
      return undefined
    }
    return parsed
  }

  private toCandidate(file: CcSkillFile, parsed: ValidCcName): SkillCandidate {
    const source = this.sourceOf(file.source)
    const metadata = metadataRecord(this.toMetadata(file, parsed))
    return {
      name: parsed.name,
      description: parsed.description,
      ...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
      invocation: ccInvocation(parsed),
      source,
      provider: this.name,
      rank: file.rank,
      locator: file,
      resourceBase: { kind: 'directory', path: file.directory },
      path: file.path,
      metadata,
    }
  }

  private toDefinition(
    candidate: SkillCandidate,
    file: CcSkillFile,
    parsed: ValidCcName,
    body: string,
  ): SkillDefinition {
    return {
      name: parsed.name,
      description: parsed.description,
      ...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
      invocation: ccInvocation(parsed),
      source: candidate.source,
      provider: this.name,
      resourceBase: { kind: 'directory', path: file.directory },
      path: file.path,
      metadata: metadataRecord(this.toMetadata(file, parsed)),
      content: body,
    }
  }

  private toMetadata(file: CcSkillFile, parsed: ParsedCcFrontmatter): CcSkillMetadata {
    return {
      allowedTools: parsed.allowedTools,
      arguments: parsed.arguments,
      deprecated: file.deprecated,
      source: file.source,
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

  private sourceOf(source: CcSkillFile['source']): SkillSource {
    switch (source) {
      case 'managed':
        return MANAGED_SOURCE
      case 'user':
        return USER_SOURCE
      case 'project':
        return PROJECT_SOURCE
      case 'additional':
        return ADDITIONAL_SOURCE
    }
  }
}

/** Resolve the registry invocation policy from Claude Code bool frontmatter. */
export function ccInvocation(parsed: Pick<ParsedCcFrontmatter, 'userInvocable' | 'disableModelInvocation'>): CcInvocationPolicy & SkillInvocationPolicy {
  return {
    modelInvocable: !parsed.disableModelInvocation,
    userInvocable: parsed.userInvocable,
  }
}

/** A parsed frontmatter whose `name` is proven valid kebab-case for the registry. */
type ValidCcName = ParsedCcFrontmatter & { name: string }

/** Whether a parsed skill carries a valid registry name. */
function validCcName(parsed: ParsedCcFrontmatter): parsed is ValidCcName {
  return parsed.name !== undefined && isSkillName(parsed.name)
}

/** Widen a typed CC metadata object to the registry's string-keyed metadata map. */
function metadataRecord(metadata: CcSkillMetadata): Readonly<Record<string, unknown>> {
  return metadata as unknown as Readonly<Record<string, unknown>>
}

async function loadCcSkillFile(path: string): Promise<{ parsed: ParsedCcFrontmatter; body: string } | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  const document = parseCcFrontmatterDocument(raw)
  if (document === undefined) return undefined
  const parsed = parseCcFrontmatter(raw)
  if (parsed === undefined) return undefined
  return { parsed, body: document.body }
}
