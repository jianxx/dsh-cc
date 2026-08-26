/**
 * Render structured FileDiff data as ANSI-styled hunk lines for the
 * transcript. No diff library: the longest common line-prefix and -suffix are
 * trimmed, and the middle (the actual change) is emitted as red removals and
 * green additions, flanked by at most two context lines on each side. Output
 * is capped so a single tool row never blows the transcript line budget.
 * @module @jianxx/dsh-cc-tui/components/diff-card
 */

import type { FileDiff } from '../tool-card.ts'
import { bold, dim, green, red } from './theme.ts'

/** Default cap on emitted lines for a single tool row's diffs. */
export const DEFAULT_DIFF_LINE_CAP = 60

/**
 * Split text into lines, dropping a single trailing empty line produced by a
 * final newline so `a\nb\n` → `['a','b']` (not `['a','b','']`). A bare empty
 * string yields `[]`.
 */
function toLines(text: string): string[] {
  if (text.length === 0) return []
  const parts = text.split('\n')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** Trim the longest common line-exact prefix; return [prefix, oldRest, newRest]. */
function trimCommonPrefix(oldLines: string[], newLines: string[]): [string[], string[], string[]] {
  const min = Math.min(oldLines.length, newLines.length)
  let i = 0
  while (i < min && oldLines[i] === newLines[i]) i++
  return [oldLines.slice(0, i), oldLines.slice(i), newLines.slice(i)]
}

/** Trim the longest common line-exact suffix; return [oldRest, newRest, suffix]. */
function trimCommonSuffix(oldLines: string[], newLines: string[]): [string[], string[], string[]] {
  const min = Math.min(oldLines.length, newLines.length)
  let i = 0
  while (i < min && oldLines[oldLines.length - 1 - i] === newLines[newLines.length - 1 - i]) i++
  return [oldLines.slice(0, oldLines.length - i), newLines.slice(0, newLines.length - i), oldLines.slice(oldLines.length - i)]
}

interface HunkMiddle {
  readonly removed: readonly string[]
  readonly added: readonly string[]
  readonly prefixContext: readonly string[]
  readonly suffixContext: readonly string[]
}

/**
 * Compute the changed middle for one file. The common prefix/suffix are
 * collapsed to at most 2 trailing/leading context lines respectively.
 * When prefix and suffix overlap (ambiguous), prefix wins: the suffix is
 * trimmed so the two context windows never share lines.
 */
function computeMiddle(oldText: string, newText: string): HunkMiddle {
  const oldLines = toLines(oldText)
  const newLines = toLines(newText)

  // Trim common prefix first (prefix-wins on overlap).
  const [, oldAfterPrefix, newAfterPrefix] = trimCommonPrefix(oldLines, newLines)
  // Then trim the common suffix of the remaining middles.
  const [oldMiddle, newMiddle, suffix] = trimCommonSuffix(oldAfterPrefix, newAfterPrefix)

  // Recompute the prefix context from the original split point.
  const prefixLen = oldLines.length - oldAfterPrefix.length
  const fullPrefix = oldLines.slice(0, prefixLen)
  const prefixContext = fullPrefix.slice(Math.max(0, fullPrefix.length - 2))

  // Suffix context: at most 2 leading lines of the suffix, clamped so the
  // prefix context and suffix context never overlap (prefix wins).
  const remainingAfterMiddle = oldLines.length - prefixLen - oldMiddle.length
  const maxSuffixContext = Math.max(0, 2 - Math.max(0, 2 - remainingAfterMiddle))
  // Actually clamp suffix context to the smaller of (2, suffix.length, and
  // not overlapping prefix context region).
  const suffixContext = suffix.slice(0, Math.min(2, suffix.length, maxSuffixContext + 2))

  // If nothing changed, the middles are empty — signal that upstream.
  return {
    removed: oldMiddle,
    added: newMiddle,
    prefixContext,
    suffixContext,
  }
}

/**
 * Render FileDiff[] as ANSI-styled lines: a bold per-file header with a tag,
 * then red removals and green additions flanked by dim context lines. Capped
 * at `maxLines` (default 60); a dim trailer is appended when content is cut.
 *
 * Indentation (two leading spaces) is applied here so callers can drop the
 * returned lines directly beneath a tool row's head line.
 */
export function renderDiffLines(
  diffs: readonly FileDiff[],
  maxLines: number = DEFAULT_DIFF_LINE_CAP,
): string[] {
  if (diffs.length === 0) return []
  const out: string[] = []

  for (const diff of diffs) {
    if (out.length > maxLines) break

    // Header: bold path + tag.
    const tag = diff.oldText === null
      ? ' (new file)'
      : diff.newText === ''
        ? ' (deleted)'
        : ''
    out.push(`  ${bold(diff.path)}${tag.length > 0 ? dim(tag) : ''}`)

    // New file: every line is an addition. Deleted file: every line is a removal.
    if (diff.oldText === null) {
      for (const line of toLines(diff.newText)) {
        if (out.length > maxLines) break
        out.push(`  ${green(`+ ${line}`)}`)
      }
      continue
    }
    if (diff.newText === '') {
      for (const line of toLines(diff.oldText)) {
        if (out.length > maxLines) break
        out.push(`  ${red(`- ${line}`)}`)
      }
      continue
    }

    const middle = computeMiddle(diff.oldText, diff.newText)

    // No change at all.
    if (middle.removed.length === 0 && middle.added.length === 0) {
      if (out.length < maxLines) out.push(dim('    (no changes)'))
      continue
    }

    // Prefix context (dimmed, leading space — already indented to column 2).
    for (const line of middle.prefixContext) {
      if (out.length > maxLines) break
      out.push(dim(`    ${line}`))
    }

    // Removals then additions.
    for (const line of middle.removed) {
      if (out.length > maxLines) break
      out.push(`  ${red(`- ${line}`)}`)
    }
    for (const line of middle.added) {
      if (out.length > maxLines) break
      out.push(`  ${green(`+ ${line}`)}`)
    }

    // Suffix context.
    for (const line of middle.suffixContext) {
      if (out.length > maxLines) break
      out.push(dim(`    ${line}`))
    }
  }

  if (out.length > maxLines) {
    const remaining = out.length - maxLines
    out.length = maxLines
    out.push(dim(`  … (${remaining} more lines)`))
  }

  return out
}
