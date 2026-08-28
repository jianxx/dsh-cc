/**
 * Render structured FileDiff data as ANSI-styled hunk lines for the
 * transcript. Hunks come from {@link computeHunks} (line-level LCS with a
 * size-capped prefix/suffix fallback). Large unchanged runs between hunks
 * collapse to a single dim `… N unchanged lines …` marker; small runs render
 * as dim context so adjacent hunks read as one cluster. Changed lines carry a
 * right-aligned gutter line number (old-side number on `-` lines, new-side on
 * `+` lines). Output is capped so a single tool row never blows the
 * transcript line budget, and truncation respects hunk boundaries: a hunk
 * that fits in the remaining budget is never split in half.
 * @module @jianxx/dsh-cc-tui/components/diff-card
 */

import type { FileDiff } from '../tool-card.ts'
import { computeHunks, splitLines, type DiffHunk } from './diff-hunks.ts'
import { bold, dim, green, red } from './theme.ts'

/** Default cap on emitted lines for a single tool row's diffs. */
export const DEFAULT_DIFF_LINE_CAP = 60

/** Context lines shown at the start/end of a file's diff (edge gaps). */
const DIFF_CONTEXT_LINES = 2
/** Hunks separated by at most this many unchanged lines render as one cluster. */
const HUNK_MERGE_GAP = 2 * DIFF_CONTEXT_LINES

/**
 * Hunk computation memo keyed by FileDiff object identity. Store rows are
 * immutable, so the same FileDiff instances recur on every driver emit; the
 * memo keeps repeated renders (including transcript budget counting, which
 * calls renderDiffLines on every pass) from recomputing the LCS.
 */
const hunkMemo = new WeakMap<FileDiff, readonly DiffHunk[]>()

function hunksFor(diff: FileDiff): readonly DiffHunk[] {
  let hunks = hunkMemo.get(diff)
  if (hunks === undefined) {
    hunks = computeHunks(diff.oldText ?? '', diff.newText)
    hunkMemo.set(diff, hunks)
  }
  return hunks
}

/**
 * One atomically-emittable block of output lines. Small atoms are dropped
 * whole when the line budget runs out; only atoms too large to ever fit the
 * whole cap may emit partially.
 */
interface Atom {
  readonly lines: readonly string[]
  readonly splittable: boolean
}

/** Gutter width covering every line number in either file version. */
function gutterWidth(oldCount: number, newCount: number): number {
  return String(Math.max(oldCount, newCount, 1)).length
}

function headerFor(diff: FileDiff): string {
  const tag = diff.oldText === null
    ? ' (new file)'
    : diff.newText === ''
      ? ' (deleted)'
      : ''
  return `  ${bold(diff.path)}${tag.length > 0 ? dim(tag) : ''}`
}

function removalLine(num: number, width: number, line: string): string {
  return `  ${String(num).padStart(width)} ${red(`- ${line}`)}`
}

function additionLine(num: number, width: number, line: string): string {
  return `  ${String(num).padStart(width)} ${green(`+ ${line}`)}`
}

function contextLine(line: string): string {
  return dim(`    ${line}`)
}

function unchangedMarker(count: number): string {
  return dim(`    … ${count} unchanged line${count === 1 ? '' : 's'} …`)
}

function contextAtom(line: string): Atom {
  return { lines: [contextLine(line)], splittable: false }
}

/** Atoms for an in-place edit: per-hunk blocks with context and collapse markers. */
function buildEditAtoms(diff: FileDiff, maxLines: number): Atom[] {
  const oldLines = splitLines(diff.oldText ?? '')
  const newLines = splitLines(diff.newText)
  const width = gutterWidth(oldLines.length, newLines.length)
  const hunks = hunksFor(diff)
  const atoms: Atom[] = [{ lines: [headerFor(diff)], splittable: false }]

  if (hunks.length === 0) {
    atoms.push({ lines: [dim('    (no changes)')], splittable: false })
    return atoms
  }

  // 1-based old-file line consumed by the previous hunk.
  let prevEnd = 0
  hunks.forEach((hunk, i) => {
    const gap = oldLines.slice(prevEnd, hunk.oldStart - 1)
    if (i === 0) {
      // Leading context: at most DIFF_CONTEXT_LINES lines before the first hunk.
      for (const line of gap.slice(Math.max(0, gap.length - DIFF_CONTEXT_LINES))) {
        atoms.push(contextAtom(line))
      }
    } else if (gap.length <= HUNK_MERGE_GAP) {
      // Adjacent hunks: show the small unchanged run so the two changes read
      // as one cluster instead of earning a collapse marker.
      for (const line of gap) atoms.push(contextAtom(line))
    } else {
      atoms.push({ lines: [unchangedMarker(gap.length)], splittable: false })
    }

    const lines: string[] = []
    hunk.removed.forEach((line, k) => lines.push(removalLine(hunk.oldStart + k, width, line)))
    hunk.added.forEach((line, k) => lines.push(additionLine(hunk.newStart + k, width, line)))
    atoms.push({ lines, splittable: lines.length > maxLines })
    prevEnd = hunk.oldStart - 1 + hunk.removed.length
  })

  // Trailing context: at most DIFF_CONTEXT_LINES lines after the last hunk.
  for (const line of oldLines.slice(prevEnd, prevEnd + DIFF_CONTEXT_LINES)) {
    atoms.push(contextAtom(line))
  }
  return atoms
}

/** Atoms for a whole-file addition (new file) or removal (deleted file). */
function buildWholesaleAtoms(diff: FileDiff, maxLines: number, isAddition: boolean): Atom[] {
  const lines = splitLines(isAddition ? diff.newText : diff.oldText ?? '')
  const width = gutterWidth(isAddition ? 0 : lines.length, isAddition ? lines.length : 0)
  const body = lines.map((line, i) =>
    isAddition ? additionLine(i + 1, width, line) : removalLine(i + 1, width, line)
  )
  return [
    { lines: [headerFor(diff)], splittable: false },
    { lines: body, splittable: body.length > maxLines },
  ]
}

/**
 * Flush atoms under the cap. Atoms that fit are emitted whole; when an atom
 * does not fit, emission stops there (dropping it and everything after) so
 * hunks are never cut mid-way — except for oversized atoms, which stream to
 * fill the budget. The trailer reports how many lines were left out.
 */
function flushAtoms(atoms: readonly Atom[], maxLines: number): string[] {
  const total = atoms.reduce((sum, atom) => sum + atom.lines.length, 0)
  if (total <= maxLines) {
    const all: string[] = []
    for (const atom of atoms) all.push(...atom.lines)
    return all
  }

  const out: string[] = []
  for (const atom of atoms) {
    const room = maxLines - out.length
    if (room <= 0) break
    if (atom.lines.length <= room) {
      out.push(...atom.lines)
      continue
    }
    if (atom.splittable) {
      for (const line of atom.lines.slice(0, room)) out.push(line)
    }
    break
  }
  out.push(dim(`  … (${total - out.length} more lines)`))
  return out
}

/**
 * Render FileDiff[] as ANSI-styled lines: a bold per-file header with a tag,
 * then gutter-numbered red removals and green additions grouped into hunks,
 * with dim context and `… N unchanged lines …` collapse markers between
 * them. Capped at `maxLines` (default 60); a dim trailer is appended when
 * content is cut, and the cut lands on a hunk boundary.
 *
 * Indentation (two leading spaces) is applied here so callers can drop the
 * returned lines directly beneath a tool row's head line.
 */
export function renderDiffLines(
  diffs: readonly FileDiff[],
  maxLines: number = DEFAULT_DIFF_LINE_CAP,
): string[] {
  if (diffs.length === 0) return []
  const atoms: Atom[] = []
  for (const diff of diffs) {
    if (diff.oldText === null) {
      atoms.push(...buildWholesaleAtoms(diff, maxLines, true))
    } else if (diff.newText === '') {
      atoms.push(...buildWholesaleAtoms(diff, maxLines, false))
    } else {
      atoms.push(...buildEditAtoms(diff, maxLines))
    }
  }
  return flushAtoms(atoms, maxLines)
}
