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
  /** Git branch of the session cwd (best-effort boot probe; omitted when unknown). */
  branch?: string
  /** Context occupancy percent, 0-100 (rounded here when fractional). */
  contextPercent?: number
  /** Cumulative token totals for the session. */
  tokens?: { input: number; output: number }
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
 * Compact a token count for the footer: exact below 1k, one decimal below
 * 100k (`12.3k`), integer above (`123k`), and `m` past a million. Negative
 * and non-finite inputs clamp to `0` — the line stays total on bad data.
 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '0'
  if (tokens < 1000) return String(Math.round(tokens))
  const scaled = (divisor: number, suffix: string): string => {
    const value = tokens / divisor
    const compact = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
    return `${compact}${suffix}`
  }
  if (tokens < 1_000_000) return scaled(1000, 'k')
  return scaled(1_000_000, 'm')
}

/**
 * Compact footer: `cwd [branch] · session · mode · model · ctx NN% ·
 * ↑in ↓out tok` plus the busy marker and key hints. Absent optional fields
 * drop their segments; the function is pure and total on undefined inputs.
 */
export function formatStatusLine(input: StatusLineInput): string {
  const left = input.branch === undefined || input.branch.length === 0
    ? shortenCwd(input.cwd)
    : `${shortenCwd(input.cwd)} [${input.branch}]`
  const parts = [
    left,
    shortenSession(input.sessionId),
    input.permissionMode,
  ]
  if (input.model !== undefined && input.model.length > 0) parts.push(input.model)
  if (input.contextPercent !== undefined) {
    const percent = Math.max(0, Math.min(100, Math.round(input.contextPercent)))
    parts.push(`ctx ${percent}%`)
  }
  if (input.tokens !== undefined) {
    parts.push(`↑${formatTokens(input.tokens.input)} ↓${formatTokens(input.tokens.output)} tok`)
  }
  if (input.busy) parts.push('working')
  parts.push('shift+tab', '/quit')
  return parts.join(' · ')
}
