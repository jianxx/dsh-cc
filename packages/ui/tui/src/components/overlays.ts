/**
 * Approval and question overlay containers. Rendered inline (not as pi-tui
 * overlays) so they participate in the main-screen scrollback flow, matching
 * the previous Ink layout.
 * @module @jianxx/dsh-cc-tui/components/overlays
 */

import { Container, Markdown, Text } from '@jianxx/dsh-cc-pi-tui'
import type {
  ApprovalView,
  ModelPickerView,
  QuestionView,
  SessionSwitcherView,
  TodoItemView,
  UsageView,
} from '../store.ts'
import { renderDiffLines } from './diff-card.ts'
import { createMarkdownTheme } from './markdown-theme.ts'
import { defaultTheme, type Theme } from './theme.ts'

/**
 * Cap on command/JSON preview lines in an approval box so a long payload
 * cannot push the composer off-screen; a trailing `…` marks the cut.
 */
const APPROVAL_PREVIEW_MAX_LINES = 8

/**
 * Cap on diff lines in an approval box, passed to the transcript's diff
 * renderer (which cuts on a hunk boundary and appends its own dim trailer).
 */
const APPROVAL_DIFF_MAX_LINES = 16

/**
 * Approval box: the title ("Approve <tool>?", or "Approval (1 of N)" when
 * other modals wait behind this one) + optional reason + the structured
 * payload preview (command block, diff card, or raw-arguments JSON block) +
 * an explicit key→outcome hint including the always-allow option.
 */
export function createApprovalBox(approval: ApprovalView, theme: Theme = defaultTheme): Container {
  const box = new Container()
  const title = approval.pendingCount === undefined
    ? `Approve ${approval.toolName}?`
    : `Approval (1 of ${approval.pendingCount + 1})`
  box.addChild(new Text(theme.warning(title), 0, 0))
  if (approval.reason !== undefined) {
    box.addChild(new Text(theme.muted(approval.reason), 0, 0))
  }
  const preview = approval.preview
  if (preview?.kind === 'command') {
    for (const line of previewLines(preview.command, APPROVAL_PREVIEW_MAX_LINES)) {
      box.addChild(new Text(theme.muted(line), 0, 0))
    }
  } else if (preview?.kind === 'diff') {
    for (const line of renderDiffLines(preview.diffs, APPROVAL_DIFF_MAX_LINES, theme)) {
      box.addChild(new Text(theme.muted(line), 0, 0))
    }
  } else if (preview?.kind === 'args') {
    for (const line of previewLines(preview.json, APPROVAL_PREVIEW_MAX_LINES)) {
      box.addChild(new Text(theme.muted(line), 0, 0))
    }
  }
  box.addChild(new Text(theme.muted('1 once · 2 no · 3 always'), 0, 0))
  return box
}

/**
 * Cap a multi-line preview at `maxLines`; a trailing `…` marks the cut so a
 * long payload cannot push the composer off-screen.
 */
function previewLines(text: string, maxLines: number): string[] {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return lines
  return [...lines.slice(0, maxLines - 1), `${lines[maxLines - 1]!} …`]
}

/**
 * Question box v2: title + question text, the plan markdown for plan-review
 * intents, focusable option rows (multi-select checkboxes), the trailing
 * free-text "Other" row, and a key hint footer.
 */
export function createQuestionBox(question: QuestionView, theme: Theme = defaultTheme): Container {
  const box = new Container()
  const planReview = question.intent?.kind === 'plan-review' && question.detail !== undefined
  box.addChild(new Text(theme.bold(planReview ? 'Plan review' : question.header), 0, 0))
  box.addChild(new Text(question.question, 0, 0))
  if (planReview) {
    box.addChild(new Markdown(question.detail!, 0, 0, createMarkdownTheme(theme)))
  }

  const lastRow = question.options.length // trailing "Other" row index
  for (let index = 0; index <= lastRow; index += 1) {
    const focused = question.focused === index
    const marker = focused ? '❯ ' : '  '
    if (index < question.options.length) {
      const option = question.options[index]!
      const check = question.multiSelect
        ? question.selected.includes(option.label) ? '[x] ' : '[ ] '
        : ''
      const description = option.description === undefined
        ? ''
        : theme.muted(` — ${option.description}`)
      box.addChild(new Text(`${marker}${index + 1}. ${check}${option.label}${description}`, 0, 0))
    } else {
      box.addChild(new Text(`${marker}Other: ${question.custom}`, 0, 0))
    }
  }

  const hint = question.multiSelect
    ? '↑↓ move · space toggle · enter confirm · esc cancel'
    : '↑↓ move · enter select · type to answer freely · esc cancel'
  box.addChild(new Text(theme.muted(hint), 0, 0))
  return box
}

/**
 * Maximum model-picker rows rendered at once. A longer catalog is windowed
 * around the focus so the box can never overflow the frame (the 16-line
 * catalog-dump regression class).
 */
const MODEL_PICKER_VISIBLE_ROWS = 10

/**
 * Model picker box: a modal list of `provider/id — name` rows with a `❯`
 * focus marker and a `*` on the active route, windowed to
 * {@link MODEL_PICKER_VISIBLE_ROWS} rows around the focus.
 *
 * Hand-rolled (not the vendored `SelectList`) because SelectList owns its own
 * `selectedIndex` and routes input through its own `handleInput`, which would
 * fight the driver-owned `modelPicker` state and the emit/setter flow the rest
 * of the overlays use. SelectList also renders a `→` prefix and a two-column
 * layout that clash with the `❯` + Text-row convention shared by the approval
 * and question boxes. A focused-list mirroring the question overlay keeps one
 * state owner and one styling language.
 */
export function createModelPickerBox(picker: ModelPickerView, theme: Theme = defaultTheme): Container {
  const box = new Container()
  box.addChild(new Text(theme.bold('Select model'), 0, 0))

  const total = picker.entries.length
  const cap = MODEL_PICKER_VISIBLE_ROWS
  let start = 0
  if (total > cap) {
    start = Math.max(0, Math.min(picker.focused - Math.floor(cap / 2), total - cap))
  }
  const end = Math.min(start + cap, total)

  for (let index = start; index < end; index += 1) {
    const entry = picker.entries[index]!
    const focused = picker.focused === index
    const isCurrent = picker.current !== undefined
      && picker.current.provider === entry.provider
      && picker.current.model === entry.id
    const marker = focused ? '❯ ' : '  '
    const currentMark = isCurrent ? ' *' : ''
    box.addChild(new Text(`${marker}${entry.provider}/${entry.id} — ${entry.name}${currentMark}`, 0, 0))
  }

  box.addChild(new Text(theme.muted('↑↓ move · enter select · esc cancel'), 0, 0))
  return box
}

/**
 * Maximum session-switcher rows rendered at once. Mirrors the model picker
 * cap so a long session list can never overflow the frame.
 */
const SESSION_SWITCHER_VISIBLE_ROWS = 10

/**
 * Short relative-time label for a session timestamp. Renders as e.g.
 * "2m ago", "1h ago", "3d ago", or a `M/D` date for older entries.
 */
function relativeDate(ts: number): string {
  const diff = Date.now() - ts
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** First 8 chars of a session id — enough to distinguish in a short list. */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

/**
 * Session switcher box: title `Resume session`, rows of relative-date +
 * short id + dim cwd, a `❯` focus marker, a `●` on the current session,
 * windowed to {@link SESSION_SWITCHER_VISIBLE_ROWS} rows. A dim `Switching…`
 * footer replaces the key hint while a switch is in flight (input blocked).
 */
export function createSessionSwitcherBox(sw: SessionSwitcherView, theme: Theme = defaultTheme): Container {
  const box = new Container()
  box.addChild(new Text(theme.bold('Resume session'), 0, 0))

  const total = sw.sessions.length
  const cap = SESSION_SWITCHER_VISIBLE_ROWS
  let start = 0
  if (total > cap) {
    start = Math.max(0, Math.min(sw.focused - Math.floor(cap / 2), total - cap))
  }
  const end = Math.min(start + cap, total)

  for (let index = start; index < end; index += 1) {
    const session = sw.sessions[index]!
    const focused = sw.focused === index
    const isCurrent = session.id === sw.currentId
    const marker = focused ? '❯ ' : '  '
    const currentMark = isCurrent ? ' ●' : ''
    const cwdPart = session.cwd === undefined ? '' : theme.muted(` — ${session.cwd}`)
    box.addChild(new Text(
      `${marker}${relativeDate(session.createdAt)} ${shortId(session.id)}${cwdPart}${currentMark}`,
      0, 0,
    ))
  }

  box.addChild(new Text(
    sw.switching ? theme.muted('Switching…') : theme.muted('↑↓ move · enter switch · esc cancel'),
    0, 0,
  ))
  return box
}

/**
 * Maximum todo-panel rows rendered at once. A longer list is windowed around
 * the focus (mirroring the model picker cap) so the box can never overflow
 * the frame.
 */
const TODO_PANEL_VISIBLE_ROWS = 12

/**
 * Status icon for one todo row: checked for completed, half-full for the
 * in-progress item, empty for pending.
 */
function todoIcon(status: TodoItemView['status']): string {
  if (status === 'completed') return '☑'
  if (status === 'in_progress') return '◐'
  return '☐'
}

/**
 * Todo panel box: the session todo list with status icons, a `❯` focus
 * marker, and a key hint footer, windowed to {@link TODO_PANEL_VISIBLE_ROWS}
 * rows around the focus. An empty (or absent) todo list renders a dim
 * placeholder instead of rows; the panel still opens so Ctrl+T is a stable
 * toggle either way.
 */
export function createTodoPanelBox(todos: readonly TodoItemView[], focused: number, theme: Theme = defaultTheme): Container {
  const box = new Container()
  box.addChild(new Text(theme.bold('Todos'), 0, 0))

  const total = todos.length
  if (total === 0) {
    box.addChild(new Text(theme.muted('No todos'), 0, 0))
    box.addChild(new Text(theme.muted('↑↓ navigate · Esc close'), 0, 0))
    return box
  }

  const cap = TODO_PANEL_VISIBLE_ROWS
  let start = 0
  if (total > cap) {
    start = Math.max(0, Math.min(focused - Math.floor(cap / 2), total - cap))
  }
  const end = Math.min(start + cap, total)

  for (let index = start; index < end; index += 1) {
    const todo = todos[index]!
    const marker = focused === index ? '❯ ' : '  '
    box.addChild(new Text(`${marker}${todoIcon(todo.status)} ${todo.content}`, 0, 0))
  }

  box.addChild(new Text(theme.muted('↑↓ navigate · Esc close'), 0, 0))
  return box
}

/** Width (in cells) of the context-occupancy bar in the usage panel. */
const USAGE_BAR_WIDTH = 10

/**
 * Compact token count for the context line: digits below a thousand, then
 * `86k` / `1.2k`-style thousands (single decimal, dropped when it rounds to
 * `.0`; none past three digits).
 */
function compactTokens(count: number): string {
  if (count < 1000) return String(count)
  const k = count / 1000
  const text = k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, '')
  return `${text}k`
}

/**
 * Context-occupancy line: a bar, the percent, and both raw counts —
 * `████░░░░░░ 43% (86k/200k)`. The bar fills by the rounded occupancy ratio
 * with the percent clamped to [0, 100]. Each unknown degrades to a dim
 * fallback: no used count at all renders `n/a`; a used count without a known
 * window renders the count plus a dim `window n/a` (no percent is claimed).
 */
function contextLine(view: UsageView | undefined, theme: Theme): string {
  const { contextUsed, contextWindow } = view ?? {}
  if (contextUsed === undefined) return theme.muted('n/a')
  if (contextWindow === undefined) {
    return theme.muted(`${compactTokens(contextUsed)} tok · window n/a`)
  }
  const ratio = contextUsed / contextWindow
  const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)))
  const filled = Math.max(0, Math.min(USAGE_BAR_WIDTH, Math.round(ratio * USAGE_BAR_WIDTH)))
  const bar = '█'.repeat(filled) + '░'.repeat(USAGE_BAR_WIDTH - filled)
  return `${bar} ${percent}% (${compactTokens(contextUsed)}/${compactTokens(contextWindow)})`
}

/**
 * Aligned `  label  value` rows (thousands separators, shared column widths)
 * for one usage-panel section.
 */
function alignedRows(entries: readonly (readonly [string, number])[]): string[] {
  const labelWidth = Math.max(...entries.map(([label]) => label.length))
  const valueWidth = Math.max(...entries.map(([, value]) => value.toLocaleString('en-US').length))
  return entries.map(([label, value]) =>
    `  ${label.padEnd(labelWidth)}  ${value.toLocaleString('en-US').padStart(valueWidth)}`,
  )
}

/**
 * Usage panel box (`/usage`): the live context-occupancy bar, the cumulative
 * token totals (cache rows only when non-zero, mirroring /cost), and the
 * context breakdown by role. Pure display — no focus or navigation — and
 * each section degrades independently to a dim `n/a` when its projection has
 * no data. Quota and rate-limit figures have no projection at all, so the
 * footer says so explicitly instead of implying the panel is exhaustive.
 */
export function createUsagePanelBox(view: UsageView | undefined, theme: Theme = defaultTheme): Container {
  const box = new Container()
  box.addChild(new Text(theme.bold('Usage'), 0, 0))
  box.addChild(new Text(contextLine(view, theme), 0, 0))

  box.addChild(new Text('Tokens', 0, 0))
  const totals = view?.totals
  if (totals === undefined) {
    box.addChild(new Text(theme.muted('n/a'), 0, 0))
  } else {
    const entries: [string, number][] = [['input', totals.input], ['output', totals.output]]
    const { cacheRead, cacheWrite } = totals
    if (cacheRead !== undefined && cacheRead > 0) entries.push(['cache r', cacheRead])
    if (cacheWrite !== undefined && cacheWrite > 0) entries.push(['cache w', cacheWrite])
    for (const line of alignedRows(entries)) {
      box.addChild(new Text(line, 0, 0))
    }
  }

  box.addChild(new Text('Breakdown', 0, 0))
  const breakdown = view?.breakdown
  if (breakdown === undefined) {
    box.addChild(new Text(theme.muted('n/a'), 0, 0))
  } else {
    for (const line of alignedRows([
      ['system', breakdown.system],
      ['tools', breakdown.tools],
      ['messages', breakdown.messages],
    ])) {
      box.addChild(new Text(line, 0, 0))
    }
  }

  box.addChild(new Text(theme.muted('quota data unavailable · Esc close'), 0, 0))
  return box
}
