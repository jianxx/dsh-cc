/**
 * TUI-local slash parsing. Harness commands still dispatch through
 * `ctx.commands`; these names are owned by the terminal surface.
 * @module @jianxx/dsh-cc-tui/slash
 */

/** Slash names the TUI handles without calling `ctx.commands`. */
export const LOCAL_SLASH = ['quit', 'exit', 'clear', 'tui-help'] as const

export type LocalSlashName = (typeof LOCAL_SLASH)[number]

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
