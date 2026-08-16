/**
 * Human-facing `/help` command: lists every registered slash command or shows
 * the detail for one named command, including its input hint.
 * @module @jianxx/dsh-cc-command-help
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { formatHelpDetail, formatHelpList } from './help.ts'

export const name = 'command-help'
export const inject = ['commands']

/** Execute `/help [cmd]`. */
function executeHelp(ctx: Context, invocation: CommandInvocation): CommandResult {
  const descriptors = ctx.commands.list(invocation.agent)
  const token = invocation.rawInput.trim()
  if (token.length === 0) {
    return { kind: 'success', text: formatHelpList(descriptors) }
  }
  const detail = formatHelpDetail(descriptors, token.toLowerCase())
  if (detail === undefined) {
    return { kind: 'success', text: `Unknown command /${token}. Try /help for a list.` }
  }
  return { kind: 'success', text: detail }
}

/**
 * Register the `/help` command for every composed command adapter.
 * @param ctx - context carrying the command registry.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'help',
    description: 'list all slash commands, or show details for one (e.g. /help memory)',
    input: { hint: '[command]' },
    handler: (invocation: CommandInvocation) => executeHelp(ctx, invocation),
  })
}
