/**
 * TUI-local slash parsing. Harness commands still dispatch through
 * `ctx.commands`; these names are owned by the terminal surface.
 * @module @jianxx/dsh-cc-tui/slash
 */

/** Slash names the TUI handles without calling `ctx.commands`. */
export const LOCAL_SLASH = ['quit', 'exit', 'clear', 'tui-help', 'resume', 'model'] as const

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
] as const

export type ParsedSlash =
  | { kind: 'local'; name: LocalSlashName; rawInput: string }
  | { kind: 'harness'; line: string }
  | { kind: 'none' }

/**
 * Classify one composer line. Leading slash required; unknown names go to
 * the harness catalog so preset commands (`/permissions`, `/status`, …) work.
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
