/**
 * Transcript view: a Container that mirrors the TuiState rows. Assistant rows
 * render through the vendored Markdown component; other row kinds use Text.
 * Per-row identity caching avoids re-parsing unchanged historical markdown on
 * every streaming chunk, and a source-line budget clips the oldest rows when
 * the transcript grows very long.
 * @module @jianxx/dsh-cc-tui/components/transcript
 */

import {
  Container,
  Markdown,
  Text,
  type Component,
} from '@jianxx/dsh-cc-pi-tui'
import type { TranscriptRow } from '../store.ts'
import { toolVerb } from '../tool-verbs.ts'
import { renderDiffLines } from './diff-card.ts'
import { createMarkdownTheme } from './markdown-theme.ts'
import { cyan, dim, italic, red, yellow } from './theme.ts'

/** Drop oldest rows once the total source-line count exceeds this. */
export const TRANSCRIPT_LINE_BUDGET = 2000

/** Cheap source-line count for a row (NOT rendered lines). */
function rowSourceLines(row: TranscriptRow): number {
  if (row.kind === 'tool') {
    if (row.diffs !== undefined && row.diffs.length > 0) {
      // Diff hunks replace the summary body; count their rendered lines.
      return 1 + renderDiffLines(row.diffs).length
    }
    const body = row.body ?? row.result ?? row.args ?? ''
    return 1 + body.split('\n').length
  }
  return row.text.split('\n').length
}

/** Options that affect how a row renders (independent of row identity). */
export interface RowRenderOptions {
  /** Expand thinking rows; default false (collapsed to a one-line hint). */
  thinkingExpanded?: boolean
}

function renderRowText(row: TranscriptRow, options?: RowRenderOptions): string {
  switch (row.kind) {
    case 'user':
      return cyan(`> ${row.text}`)
    case 'assistant':
      return row.text
    case 'thinking': {
      const expanded = options?.thinkingExpanded ?? false
      if (!expanded) {
        const lines = row.text.split('\n').length
        return dim(italic(`▸ thinking (${lines} lines — Ctrl+O to expand)`))
      }
      return dim(italic(`▾ ${row.text}`))
    }
    case 'tool': {
      // Running rows lead with a dim present-tense verb (Running/Reading/…);
      // completed rows drop the verb and show only a result glyph.
      const status = row.running ? '…' : (row.error === true ? '✗' : '✓')
      const verbPrefix = row.running ? `${dim(toolVerb(row.name))} ` : ''
      const head = yellow(`⏺ ${verbPrefix}${row.title} ${status}`)
      const headLine = row.error === true ? red(head) : head

      // When structured diffs are present, render real hunks beneath the head.
      // The one-line summary body is replaced to avoid duplicating the path info.
      if (row.diffs !== undefined && row.diffs.length > 0) {
        const diffLines = renderDiffLines(row.diffs)
        return diffLines.length > 0 ? `${headLine}\n${diffLines.join('\n')}` : headLine
      }

      const body = row.body ?? row.result ?? row.args
      if (body !== undefined && body.length > 0) {
        const firstLine = body.split('\n')[0] ?? ''
        return `${headLine}\n  ⎿ ${row.error === true ? red(firstLine) : firstLine}`
      }
      return headLine
    }
    case 'status':
      return dim(row.text)
  }
}

/** Build the pi-tui component for a single row. */
function buildChild(row: TranscriptRow, options?: RowRenderOptions): Component {
  if (row.kind === 'assistant') {
    return new Markdown(row.text, 0, 0, createMarkdownTheme())
  }
  return new Text(renderRowText(row, options), 0, 0)
}

/**
 * Container that renders transcript rows as stacked Text/Markdown components.
 * Call `setRows` whenever the driver emits a new state.
 */
export class TranscriptView extends Container {
  private prevRows: readonly TranscriptRow[] = []
  private prevChildren: Component[] = []
  private prevThinkingExpanded = false

  setRows(rows: readonly TranscriptRow[], options?: RowRenderOptions): void {
    const thinkingExpanded = options?.thinkingExpanded ?? false
    const thinkingFlagChanged = thinkingExpanded !== this.prevThinkingExpanded

    // Apply the line budget: drop oldest rows until under budget (always keep
    // at least one row so a single huge paste is not emptied entirely).
    const clipped = Array.from(rows)
    let dropped = 0
    let total = clipped.reduce((sum, r) => sum + rowSourceLines(r), 0)
    while (total > TRANSCRIPT_LINE_BUDGET && clipped.length > 1) {
      total -= rowSourceLines(clipped[0]!)
      clipped.shift()
      dropped++
    }

    // Build children with per-row identity caching. The store's immutable
    // updates only replace changed row objects, so reference equality at the
    // same index lets us reuse the existing component (and its render cache).
    // Thinking rows are the exception: their rendering depends on the
    // thinkingExpanded flag, so a flag change forces a rebuild even when the
    // row reference is unchanged (toggleThinking does not touch the rows array).
    const rowChildren: Component[] = []
    for (let i = 0; i < clipped.length; i++) {
      const row = clipped[i]!
      const thinkingStale = thinkingFlagChanged && row.kind === 'thinking'
      if (
        i < this.prevChildren.length &&
        this.prevRows[i] === row &&
        !thinkingStale
      ) {
        rowChildren.push(this.prevChildren[i]!)
      } else {
        rowChildren.push(buildChild(row, { thinkingExpanded }))
      }
    }

    // Prepend a dim clip indicator when rows were dropped.
    this.children = dropped > 0
      ? [new Text(dim(`… earlier output hidden (${dropped} rows)`), 0, 0), ...rowChildren]
      : rowChildren

    this.prevRows = clipped
    this.prevChildren = rowChildren
    this.prevThinkingExpanded = thinkingExpanded
  }
}
