/**
 * Approval and question overlay containers. Rendered inline (not as pi-tui
 * overlays) so they participate in the main-screen scrollback flow, matching
 * the previous Ink layout.
 * @module @jianxx/dsh-cc-tui/components/overlays
 */

import { Container, Text } from '@jianxx/dsh-cc-pi-tui'
import type { ApprovalView, QuestionView } from '../store.ts'
import { dim, yellow } from './theme.ts'

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
 * Question box: header + numbered options.
 */
export function createQuestionBox(question: QuestionView): Container {
  const box = new Container()
  box.addChild(new Text(question.header, 0, 0))
  for (let index = 0; index < question.options.length; index += 1) {
    const option = question.options[index]!
    box.addChild(new Text(`${index + 1}. ${option}`, 0, 0))
  }
  return box
}
