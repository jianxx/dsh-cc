/**
 * Approval and question overlay containers. Rendered inline (not as pi-tui
 * overlays) so they participate in the main-screen scrollback flow, matching
 * the previous Ink layout.
 * @module @jianxx/dsh-cc-tui/components/overlays
 */

import { Container, Markdown, Text } from '@jianxx/dsh-cc-pi-tui'
import type { ApprovalView, QuestionView } from '../store.ts'
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
