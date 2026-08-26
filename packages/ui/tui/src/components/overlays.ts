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
 * Approval box: "Approve <tool>?" + optional command + "1 yes · 2 no".
 */
export function createApprovalBox(approval: ApprovalView): Container {
  const box = new Container()
  box.addChild(new Text(yellow(`Approve ${approval.toolName}?`), 0, 0))
  if (approval.command !== undefined) {
    box.addChild(new Text(dim(approval.command), 0, 0))
  }
  box.addChild(new Text(yellow('1 yes · 2 no'), 0, 0))
  return box
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
