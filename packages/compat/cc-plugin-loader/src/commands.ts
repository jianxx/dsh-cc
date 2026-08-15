/**
 * Mount a Claude Code plugin's slash commands.
 *
 * Translates manifest `commands` entries (inline content or a source file) into
 * typed command definitions registered on the commands seam. Each handler
 * returns the command's rendered content, so invoking `/name` surfaces the
 * plugin author's instructions. Registration is effect-scoped.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CcPluginManifest, CcCommand } from './types.ts'
import { ComponentTally } from './seams.ts'

/** The commands seam: accepts a typed slash-command definition. */
export interface CommandsSeam {
  /**
   * Register one command definition.
   * @param definition - the command to register.
   * @returns the exact disposer that removes the command.
   */
  register(definition: CommandDefinition): () => void
}

/** The minimal typed command definition this loader emits. */
export interface CommandDefinition {
  /** Lowercase kebab command name. */
  readonly name: string
  /** Human-readable description. */
  readonly description: string
  /** Prompts the command's execution (returns content). */
  readonly handler: () => CommandResult | Promise<CommandResult>
}

/** Result shape the loader's command handlers return. */
export type CommandResult = { readonly kind: 'success'; readonly text?: string }

/** Commands live under this directory in a plugin root, when present. */
export const STANDARD_COMMANDS_DIR = 'commands'

/** Options for mounting one plugin's commands. */
export interface MountCommandsOptions {
  /** The plugin root directory; inline `source` paths resolve against it. */
  readonly pluginRoot: string
  /** The parsed manifest, whose `commands` field drives registration. */
  readonly manifest: CcPluginManifest
  /** The commands seam (probed; `undefined` to skip commands). */
  readonly commands: CommandsSeam | undefined
}

/**
 * Register a plugin's manifest commands.
 * @param options - plugin root, manifest, and the commands seam.
 * @returns mounted disposers and per-component counts.
 */
export function mountCommands(options: MountCommandsOptions): { disposers: (() => void)[]; tally: ComponentTally } {
  const tally = new ComponentTally('commands')
  const disposers: (() => void)[] = []
  if (options.commands === undefined) {
    tally.addSkipped('commands seam "commands" is not mounted')
    return { disposers, tally }
  }
  const entries = options.manifest.commands
  if (entries.length === 0) {
    tally.addSkipped('plugin ships no commands')
    return { disposers, tally }
  }
  for (const entry of entries) {
    const rendered = renderCommand(options.pluginRoot, entry)
    if (rendered.error !== undefined) {
      tally.addFailed(`command "${entry.name}": ${rendered.error}`)
      continue
    }
    disposers.push(options.commands.register({
      name: entry.name,
      description: entry.description ?? '',
      handler: () => rendered.content === undefined
        ? { kind: 'success' }
        : { kind: 'success', text: rendered.content },
    }))
    tally.addLoaded()
  }
  return { disposers, tally }
}

/** Resolve a command entry to consumable content, or a failure reason. */
function renderCommand(pluginRoot: string, entry: CcCommand): { content?: string; error?: string } {
  if (entry.content !== undefined) {
    return { content: entry.content }
  }
  if (entry.source !== undefined) {
    const path = resolve(pluginRoot, entry.source)
    try {
      return { content: readFileSync(path, 'utf8') }
    } catch (error) {
      return { error: `could not read command file "${entry.source}": ${String(error)}` }
    }
  }
  return { error: 'has neither "content" nor a readable "source"' }
}
