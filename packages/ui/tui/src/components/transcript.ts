/**
 * Transcript view: a Container of Text rows that mirrors the TuiState rows.
 * A full rebuild per emit is fine for R0; pi-tui's differential renderer
 * only writes changed lines to the terminal.
 * @module @jianxx/dsh-cc-tui/components/transcript
 */

import { Container, Text } from '@jianxx/dsh-cc-pi-tui'
import type { TranscriptRow } from '../store.ts'
import { cyan, dim, italic, red, yellow } from './theme.ts'

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

/**
 * Container that renders transcript rows as stacked Text components.
 * Call `setRows` whenever the driver emits a new state.
 */
export class TranscriptView extends Container {
  setRows(rows: readonly TranscriptRow[]): void {
    this.clear()
    for (const row of rows) {
      this.addChild(new Text(renderRowText(row), 0, 0))
    }
    this.invalidate()
  }
}
