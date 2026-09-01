/**
 * TUI-local slash parsing. Harness commands still dispatch through
 * `ctx.commands`; these names are owned by the terminal surface.
 * @module @jianxx/dsh-cc-tui/slash
 */

/** Slash names the TUI handles without calling `ctx.commands`. */
export const LOCAL_SLASH = [
  'quit', 'exit', 'clear', 'tui-help', 'resume', 'model', 'effort', 'agents', 'cost', 'usage', 'export-md', 'copy',
] as const

export type LocalSlashName = (typeof LOCAL_SLASH)[number]

export interface LocalCommand {
  readonly name: string
  readonly description: string
  readonly argumentHint?: string
}

/**
 * Catalog of TUI-owned slash commands, surfaced via {@link Driver.listCommands}
 * and the composer autocomplete. Descriptions mirror runLocal's behavior so
 * the suggestion list matches what each command actually does.
 */
export const LOCAL_COMMANDS: readonly LocalCommand[] = [
  { name: 'quit', description: 'Exit the TUI session' },
  { name: 'exit', description: 'Exit the TUI session' },
  { name: 'clear', description: 'Clear the transcript rows' },
  { name: 'tui-help', description: 'Show TUI keyboard and command help' },
  { name: 'resume', description: 'Switch to a resumed session (picker or /resume <id>)', argumentHint: '<sessionId>' },
  { name: 'model', description: 'List or switch the active model', argumentHint: '<n|provider/id>' },
  { name: 'effort', description: 'Set reasoning effort for the current model', argumentHint: '<level|default>' },
  { name: 'agents', description: 'List subagent activity' },
  { name: 'cost', description: 'Show token usage' },
  { name: 'usage', description: 'Open the live token and context usage panel' },
  {
    name: 'export-md',
    description: 'Export the transcript to a Markdown file',
    argumentHint: '<path>',
  },
  { name: 'copy', description: 'Copy the latest assistant reply to the clipboard' },
] as const

export type ParsedSlash =
  | { kind: 'local'; name: LocalSlashName; rawInput: string }
  | { kind: 'harness'; line: string }
  | { kind: 'none' }

/**
 * Classify one composer line. Leading slash required; unknown names go to
 * the harness catalog so preset commands (`/permissions`, `/status`, …) work.
 * At submit, a harness-kind line the command registry does not match falls
 * through to a user prompt — user-invocable skills load through that
 * host-side gesture boundary, so a hand-typed `/skill-name` reaches the model
 * the same way a menu pick would.
 * @param line - the raw composer contents.
 */
export function parseSlash(line: string): ParsedSlash {
  const trimmed = line.trim()
  if (!trimmed.startsWith('/')) return { kind: 'none' }
  const body = trimmed.slice(1)
  const space = body.search(/\s/)
  const name = (space === -1 ? body : body.slice(0, space)).toLowerCase()
  const rawInput = space === -1 ? '' : body.slice(space).trim()
  if ((LOCAL_SLASH as readonly string[]).includes(name)) {
    return { kind: 'local', name: name as LocalSlashName, rawInput }
  }
  return { kind: 'harness', line: trimmed }
}
