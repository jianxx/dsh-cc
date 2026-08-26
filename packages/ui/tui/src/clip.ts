/**
 * Keep the transcript from growing taller than the terminal. Ink's log-update
 * walks the cursor up by the previous frame height; a frame taller than
 * stdout.rows leaves the composer off-screen and subsequent input invisible.
 * @module @jianxx/dsh-cc-tui/clip
 */

import type { TranscriptRow } from './store.ts'

function visualLinesOf(row: TranscriptRow): string[] {
  if (row.kind === 'tool') {
    const title = `⏺ ${row.title}`
    const body = row.body ?? row.result ?? row.args
    return body !== undefined && body.length > 0
      ? [title, ...body.split('\n').map(line => `  ⎿ ${line}`)]
      : [title]
  }
  return row.text.split('\n')
}

function withVisualTail(row: TranscriptRow, keep: number): TranscriptRow | undefined {
  if (keep <= 0) return undefined
  const lines = visualLinesOf(row)
  if (lines.length <= keep) return row
  const tail = lines.slice(-keep)
  if (row.kind === 'tool') {
    return { ...row, body: tail.slice(1).join('\n') }
  }
  return { ...row, text: tail.join('\n') }
}

/**
 * Last `maxLines` visual lines of the transcript, preserving row order.
 * A multiline status/catalog row is itself clipped from the bottom.
 */
export function clipTranscript(rows: readonly TranscriptRow[], maxLines: number): TranscriptRow[] {
  if (maxLines <= 0) return []
  const out: TranscriptRow[] = []
  let used = 0
  for (let index = rows.length - 1; index >= 0 && used < maxLines; index -= 1) {
    const row = rows[index]!
    const lines = visualLinesOf(row)
    const remaining = maxLines - used
    if (lines.length <= remaining) {
      out.unshift(row)
      used += Math.max(lines.length, 1)
      continue
    }
    const clipped = withVisualTail(row, remaining)
    if (clipped !== undefined) out.unshift(clipped)
    break
  }
  return out
}
