/**
 * Skill body rendering: argument interpolation, placeholder substitution, and
 * inline-shell segmentation.
 *
 * Rendering is pure and side-effect free: it produces the substituted body text
 * plus any `` !`...` `` inline-shell commands it found. Executing those commands
 * is the caller's responsibility (guarded by `allowInlineShell`, which MCP-sourced
 * skills must force off).
 *
 * @module
 */

/** One text-or-shell segment of a rendered skill body. */
export type SkillRenderSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'shell'; readonly command: string }

/** Options controlling one `renderSkillBody` pass. */
export interface RenderSkillBodyOptions {
  /** Raw arguments string, or undefined when the skill was invoked without them. */
  readonly args?: string | undefined
  /** Named argument placeholders in frontmatter order. */
  readonly argumentNames: readonly string[]
  /** The skill's own directory, for `${CLAUDE_SKILL_DIR}`. */
  readonly skillDir?: string
  /** The current session id, for `${CLAUDE_SESSION_ID}`. */
  readonly sessionId: string
  /** Whether inline shell execution is permitted; MCP-sourced skills force it off. */
  readonly allowInlineShell: boolean
}

/** A fully substituted body plus any inline-shell segments awaiting execution. */
export interface RenderedSkillBody {
  /** Substituted text with inline-shell placeholders removed. */
  readonly text: string
  /** Inline-shell commands extracted in document order. */
  readonly inlineShell: readonly string[]
}

/** A shell-segmented body before execution. */
export interface SegmentedSkillBody {
  /** Ordered text and shell segments. */
  readonly segments: readonly SkillRenderSegment[]
  /** Inline-shell commands in document order. */
  readonly inlineShell: readonly string[]
  /** Plain text after placeholder substitution, shell placeholders removed. */
  readonly text: string
}

const INLINE_SHELL = /!`([^`]*)`/g

/**
 * Split a skill body on `` !`...` `` inline-shell markers into ordered text and
 * shell segments. The regex is intentionally loose (anything but a backtick so
 * embedded backticks do not break segmentation); validation of the command is
 * the executing shell's job.
 * @param content - body text after argument/placeholder substitution.
 * @returns the ordered segments and their pending shell commands.
 */
export function segmentSkillBody(content: string): SegmentedSkillBody {
  const segments: SkillRenderSegment[] = []
  const inlineShell: string[] = []
  let lastIndex = 0
  let text = ''
  for (const match of content.matchAll(INLINE_SHELL)) {
    const index = match.index
    const lead = content.slice(lastIndex, index)
    if (lead.length > 0) {
      segments.push({ kind: 'text', text: lead })
      text += lead
    }
    const command = match[1] ?? ''
    segments.push({ kind: 'shell', command })
    inlineShell.push(command)
    lastIndex = index + match[0].length
  }
  if (lastIndex < content.length) {
    segments.push({ kind: 'text', text: content.slice(lastIndex) })
    text += content.slice(lastIndex)
  }
  return { segments, inlineShell, text }
}

/**
 * Render a skill body with argument and placeholder substitution, returning the
 * substituted text plus extracted inline-shell commands. Inline-shell commands
 * are never executed here.
 * @param content - raw skill body.
 * @param options - substitution and shell-policy inputs.
 * @returns the substituted text and pending shell commands.
 */
export function renderSkillBody(content: string, options: RenderSkillBodyOptions): RenderedSkillBody {
  const substituted = substituteArguments(content, options.args, options.argumentNames)
  const placed = substitutePlaceholders(substituted, options.skillDir, options.sessionId)
  return segmentSkillBody(placed)
}

/**
 * Extract inline-shell segments from already-substituted body text.
 * @param content - body text with arguments and placeholders already substituted.
 * @returns the ordered segments; a single text segment when no inline shell is present.
 */
export function extractInlineShell(content: string): readonly SkillRenderSegment[] {
  return segmentSkillBody(content).segments
}

/**
 * Substitute `$ARGUMENTS`, `$ARGUMENTS[n]`, `$n`, and named `$name` placeholders
 * in a skill body with positional argument values. Named arguments map to
 * positions by frontmatter order. When `args` is undefined the content is
 * returned unchanged; when a non-empty `args` matched no placeholder it is
 * appended as an `ARGUMENTS:` line.
 * @param content - body text to substitute.
 * @param args - raw arguments string, or undefined for none.
 * @param argumentNames - named placeholders in frontmatter order.
 * @returns the substituted body.
 */
export function substituteArguments(content: string, args: string | undefined, argumentNames: readonly string[]): string {
  if (args === undefined) return content
  const parsed = parseArguments(args)
  let out = content
  const original = content
  for (let i = 0; i < argumentNames.length; i++) {
    const name = argumentNames[i]
    if (name === undefined) continue
    out = out.replace(new RegExp(`\\$${name}(?![\\[\\w])`, 'g'), parsed[i] ?? '')
  }
  out = out.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, index: string) => parsed[Number(index)] ?? '')
  out = out.replace(/\$(\d+)(?!\w)/g, (_, index: string) => parsed[Number(index)] ?? '')
  out = out.replaceAll('$ARGUMENTS', args)
  if (out === original && args.length > 0) out = `${out}\n\nARGUMENTS: ${args}`
  return out
}

/**
 * Parse a raw arguments string into positionally indexed values, honoring
 * single and double quotes. Shell operators and unquoted whitespace collapse;
 * quoted spaces are preserved.
 * @param args - raw arguments string.
 * @returns the positional argument values.
 */
export function parseArguments(args: string): readonly string[] {
  const trimmed = args.trim()
  if (trimmed.length === 0) return []
  const result: string[] = []
  let current = ''
  let quoted: '"' | "'" | undefined
  let tokenOpen = false
  for (let i = 0; i < trimmed.length; i++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the loop bound proves the index exists.
    const char = trimmed[i]!
    if (quoted === undefined) {
      if (char === '"' || char === "'") {
        quoted = char
        tokenOpen = true
        continue
      }
      if (/\s/.test(char)) {
        if (tokenOpen) {
          result.push(current)
          current = ''
          tokenOpen = false
        }
        continue
      }
      current += char
      tokenOpen = true
      continue
    }
    if (char === quoted) {
      quoted = undefined
      continue
    }
    current += char
  }
  if (tokenOpen) result.push(current)
  return result
}

/**
 * Substitute `${CLAUDE_SKILL_DIR}` and `${CLAUDE_SESSION_ID}` placeholders.
 * @param content - body text after argument substitution.
 * @param skillDir - the skill's own directory, or undefined to leave the placeholder.
 * @param sessionId - the current session id.
 * @returns the substituted body.
 */
export function substitutePlaceholders(content: string, skillDir: string | undefined, sessionId: string): string {
  let out = content
  if (skillDir !== undefined) out = out.replaceAll('${CLAUDE_SKILL_DIR}', skillDir)
  out = out.replaceAll('${CLAUDE_SESSION_ID}', sessionId)
  return out
}

/**
 * Estimate the catalog-facing token cost of a skill from its frontmatter only:
 * name, description, and `when_to_use`. The full body is never counted here
 * because it is loaded only on invocation.
 * @param name - skill name.
 * @param description - routing description.
 * @param whenToUse - optional routing guidance.
 * @returns a rough token estimate over the joined frontmatter fields.
 */
export function estimateFrontmatterTokens(
  name: string,
  description: string,
  whenToUse: string | undefined,
): number {
  const text = [name, description, whenToUse].filter(Boolean).join(' ')
  return roughTokenCount(text)
}

/**
 * A rough token estimate without a statistical model: every four code points
 * (approximating one token per ~4 characters) plus a minimum of one.
 * @param text - the text to estimate.
 * @returns the estimated token count.
 */
function roughTokenCount(text: string): number {
  if (text.length === 0) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}
