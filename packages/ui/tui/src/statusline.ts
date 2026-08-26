/**
 * Footer status line for the CC-mode TUI.
 * @module @jianxx/dsh-cc-tui/statusline
 */

import { homedir } from 'node:os'

export interface StatusLineInput {
  cwd: string
  sessionId: string
  permissionMode: string
  model?: string
  busy: boolean
}

function shortenCwd(cwd: string): string {
  const home = homedir()
  if (home.length > 0 && (cwd === home || cwd.startsWith(`${home}/`))) {
    return `~${cwd.slice(home.length)}`
  }
  return cwd
}

/**
 * Compact a session id to its `prefix-first8hex` form (e.g.
 * `tui-abcdef01-…` → `tui-abcdef01`). Falls back to the full id when the
 * shape doesn't match. Shared by the footer and `/agents`.
 */
export function shortenSession(sessionId: string): string {
  const match = sessionId.match(/^([a-z]+-[0-9a-f]{8})/i)
  return match?.[1] ?? sessionId
}

/**
 * Compact footer: cwd · session · mode · model · hints.
 */
export function formatStatusLine(input: StatusLineInput): string {
  const parts = [
    shortenCwd(input.cwd),
    shortenSession(input.sessionId),
    input.permissionMode,
  ]
  if (input.model !== undefined && input.model.length > 0) parts.push(input.model)
  if (input.busy) parts.push('working')
  parts.push('shift+tab', '/quit')
  return parts.join(' · ')
}
