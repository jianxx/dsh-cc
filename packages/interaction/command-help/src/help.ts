/**
 * Pure `/help` rendering: a sorted command index and a single-command detail
 * view. No cordis imports, so the renderers are unit-testable in isolation.
 * @module @jianxx/dsh-cc-command-help/help
 */

import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'

/**
 * Render the full command index, sorted by name.
 * @param descriptors - the effective command descriptors for one agent.
 * @returns a sorted multi-line list of `name — description`.
 */
export function formatHelpList(descriptors: readonly CommandDescriptor[]): string {
  const sorted = [...descriptors].sort((a, b) => a.name.localeCompare(b.name))
  if (sorted.length === 0) return 'No commands registered.'
  return sorted.map(cmd => `/${cmd.name} — ${cmd.description}`).join('\n')
}

/**
 * Render one command's detail, including its input hint when declared.
 * @param descriptors - the effective command descriptors for one agent.
 * @param name - the requested command name without the leading slash.
 * @returns the detail block, or `undefined` when the name is unknown.
 */
export function formatHelpDetail(
  descriptors: readonly CommandDescriptor[],
  name: string,
): string | undefined {
  const command = descriptors.find(cmd => cmd.name === name)
  if (command === undefined) return undefined
  const lines = [`/${command.name}`, command.description]
  if (command.input !== undefined) lines.push(`usage: /${command.name} ${command.input.hint}`)
  return lines.join('\n')
}
