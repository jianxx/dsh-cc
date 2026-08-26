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
import { createMarkdownTheme } from './markdown-theme.ts'
import { cyan, dim, italic, red, yellow } from './theme.ts'

/** Drop oldest rows once the total source-line count exceeds this. */
export const TRANSCRIPT_LINE_BUDGET = 2000

/** Cheap source-line count for a row (NOT rendered lines). */
function rowSourceLines(row: TranscriptRow): number {
  if (row.kind === 'tool') {
    const body = row.body ?? row.result ?? row.args ?? ''
    return 1 + body.split('\n').length
  }
  return row.text.split('\n').length
}

function renderRowText(row: TranscriptRow): string {
  switch (row.kind) {
    case 'user':
      return cyan(`> ${row.text}`)
    case 'assistant':
      return row.text
    case 'thinking':
      return dim(italic(row.text))
    case 'tool': {
      const status = row.running ? '…' : (row.error === true ? '✗' : '✓')
      const body = row.body ?? row.result ?? row.args
      const head = yellow(`⏺ ${row.title} ${status}`)
      if (body !== undefined && body.length > 0) {
        const firstLine = body.split('\n')[0] ?? ''
        return `${head}\n  ⎿ ${row.error === true ? red(firstLine) : firstLine}`
      }
      return row.error === true ? red(head) : head
    }
    case 'status':
      return dim(row.text)
  }
}

/** Build the pi-tui component for a single row. */
function buildChild(row: TranscriptRow): Component {
  if (row.kind === 'assistant') {
    return new Markdown(row.text, 0, 0, createMarkdownTheme())
  }
  return new Text(renderRowText(row), 0, 0)
}

/**
 * Container that renders transcript rows as stacked Text/Markdown components.
 * Call `setRows` whenever the driver emits a new state.
 */
export class TranscriptView extends Container {
  private prevRows: readonly TranscriptRow[] = []
  private prevChildren: Component[] = []

  setRows(rows: readonly TranscriptRow[]): void {
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
    const rowChildren: Component[] = []
    for (let i = 0; i < clipped.length; i++) {
      if (
        i < this.prevChildren.length &&
        this.prevRows[i] === clipped[i]
      ) {
        rowChildren.push(this.prevChildren[i]!)
      } else {
        rowChildren.push(buildChild(clipped[i]!))
      }
    }

    // Prepend a dim clip indicator when rows were dropped.
    this.children = dropped > 0
      ? [new Text(dim(`… earlier output hidden (${dropped} rows)`), 0, 0), ...rowChildren]
      : rowChildren

    this.prevRows = clipped
    this.prevChildren = rowChildren
  }
}
