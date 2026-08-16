/**
 * Bundled skills shipped with this compatible provider.
 *
 * A portable subset of Claude Code's own bundled skills (`~/workspace/github.com/claude-code/skills/bundled/`),
 * authored as `SKILL.md` documents and served directly from this package — no
 * disk extraction. They are provided with `source: 'bundled'` and the registry's
 * `BUNDLED_SKILL_RANK`, so any project, user, managed, or additional skill of the
 * same name wins the name conflict — matching Claude Code's precedence where
 * local skills override built-ins.
 *
 * Only self-contained, harness-portable skills are included; ant-only skills
 * (`verify`, `stuck`) and claude.ai/vendor-bound skills are excluded.
 *
 * @module
 */

import { isSkillName } from '@deepseek-ai/dsh-skill'
import {
  parseCcFrontmatter,
  parseCcFrontmatterDocument,
  type ParsedCcFrontmatter,
} from '../frontmatter.ts'
import { SKILL_MD as BATCH_MD, name as batchName } from './batch.ts'
import { SKILL_MD as DEBUG_MD, name as debugName } from './debug.ts'
import { SKILL_MD as SIMPLIFY_MD, name as simplifyName } from './simplify.ts'

/** One parsed bundled skill with a stable locator for the provider. */
export interface BundledSkillFile {
  /** Discriminator so the provider can tell bundled locators from `CcSkillFile`. */
  readonly kind: 'bundled'
  /** Kebab-case skill name, validated for the registry. */
  readonly name: string
  /** Logical base directory string (in-package; not a real filesystem dir). */
  readonly directory: string
  /** Human-readable source description for logs. */
  readonly path: string
  /** Already-read Markdown body. */
  readonly body: string
  /** Parsed frontmatter with a proven-valid registry name. */
  readonly parsed: ParsedCcFrontmatter & { name: string }
}

const ENTRIES: readonly { readonly name: string; readonly md: string }[] = [
  { name: debugName, md: DEBUG_MD },
  { name: simplifyName, md: SIMPLIFY_MD },
  { name: batchName, md: BATCH_MD },
]

/** Parse the in-package bundled skill set once. Skills with missing or invalid names are skipped. */
export function discoverBundledSkills(): readonly BundledSkillFile[] {
  const result: BundledSkillFile[] = []
  for (const { name, md } of ENTRIES) {
    const parsed = parseCcFrontmatter(md)
    if (parsed === undefined || parsed.name === undefined || !isSkillName(parsed.name)) continue
    if (parsed.name !== name) continue
    const body = parseCcFrontmatterDocument(md)?.body ?? ''
    result.push({
      kind: 'bundled',
      name,
      directory: `bundled:${name}`,
      path: `bundled:${name}/SKILL.md`,
      body,
      parsed: { ...parsed, name },
    })
  }
  return result
}
