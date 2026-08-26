/**
 * Approval and question overlay containers. Rendered inline (not as pi-tui
 * overlays) so they participate in the main-screen scrollback flow, matching
 * the previous Ink layout.
 * @module @jianxx/dsh-cc-tui/components/overlays
 */

import { Container, Markdown, Text } from '@jianxx/dsh-cc-pi-tui'
import type { ApprovalView, ModelPickerView, QuestionView } from '../store.ts'
import { createMarkdownTheme } from './markdown-theme.ts'
import { bold, dim, yellow } from './theme.ts'

/**
 * Approval box: "Approve <tool>?" + optional reason + optional command
 * preview (capped at three lines) + an explicit key→outcome hint.
 */
export function createApprovalBox(approval: ApprovalView): Container {
  const box = new Container()
  box.addChild(new Text(yellow(`Approve ${approval.toolName}?`), 0, 0))
  if (approval.reason !== undefined) {
    box.addChild(new Text(dim(approval.reason), 0, 0))
  }
  if (approval.command !== undefined) {
    for (const line of commandPreviewLines(approval.command)) {
      box.addChild(new Text(dim(line), 0, 0))
    }
  }
  box.addChild(new Text(dim('1 Yes, allow once · 2 No, reject'), 0, 0))
  return box
}

/**
 * Cap a command preview at three lines; a trailing `…` marks the cut so a
 * long multi-line script cannot push the composer off-screen.
 */
function commandPreviewLines(command: string, maxLines = 3): string[] {
  const lines = command.split('\n')
  if (lines.length <= maxLines) return lines
  return [...lines.slice(0, maxLines - 1), `${lines[maxLines - 1]!} …`]
}

/**
 * Question box v2: title + question text, the plan markdown for plan-review
 * intents, focusable option rows (multi-select checkboxes), the trailing
 * free-text "Other" row, and a key hint footer.
 */
export function createQuestionBox(question: QuestionView): Container {
  const box = new Container()
  const planReview = question.intent?.kind === 'plan-review' && question.detail !== undefined
  box.addChild(new Text(bold(planReview ? 'Plan review' : question.header), 0, 0))
  box.addChild(new Text(question.question, 0, 0))
  if (planReview) {
    box.addChild(new Markdown(question.detail!, 0, 0, createMarkdownTheme()))
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
        : dim(` — ${option.description}`)
      box.addChild(new Text(`${marker}${index + 1}. ${check}${option.label}${description}`, 0, 0))
    } else {
      box.addChild(new Text(`${marker}Other: ${question.custom}`, 0, 0))
    }
  }

  const hint = question.multiSelect
    ? '↑↓ move · space toggle · enter confirm · esc cancel'
    : '↑↓ move · enter select · type to answer freely · esc cancel'
  box.addChild(new Text(dim(hint), 0, 0))
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
export function createModelPickerBox(picker: ModelPickerView): Container {
  const box = new Container()
  box.addChild(new Text(bold('Select model'), 0, 0))

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

  box.addChild(new Text(dim('↑↓ move · enter select · esc cancel'), 0, 0))
  return box
}
