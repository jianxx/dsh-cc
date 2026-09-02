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

import { readdirSync, readFileSync } from 'node:fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { parseCcFrontmatter, parseCcFrontmatterDocument } from '@jianxx/dsh-cc-skill-loader'
import { basename, join, resolve } from 'node:path'
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
  /** `plugin:command` namespaced name, or the bare command name. */
  readonly name: string
  /** Human-readable command description. */
  readonly description: string
  /** Argument placeholder hint, surfaced to the user. */
  readonly input?: { hint: string }
  /** Dispatches the rendered command body as a user prompt on the invoking agent. */
  readonly handler: (invocation: CommandInvocationLike) => CommandResult | Promise<CommandResult>
}

/** Result shape the loader's command handlers return. */
/**
 * Minimal structural view of the upstream command invocation. Duck-typed on
 * purpose: the loader never imports the commands package directly.
 */
export interface CommandInvocationLike {
  /** The agent the command was executed against; the prompt injection target. */
  readonly agent: { followup(message: unknown): unknown }
  /** Raw argument text following the command name (empty when none given). */
  readonly rawInput: string
}

export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

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
  const entries = options.manifest.commandsDeclared
    ? [...options.manifest.commands]
    : defaultCommandEntries(options.pluginRoot, tally)
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
    const hint = entry.argumentHint ?? rendered.argumentHint
    const definition: CommandDefinition = {
      name: entry.name,
      description: entry.description ?? rendered.description ?? '',
      ...hint === undefined ? {} : { input: { hint } },
      handler: invocation => dispatchCommandPrompt(invocation, rendered.body ?? ''),
    }
    // Claude Code exposes plugin commands as `plugin:command`; register that
    // namespaced form first (primary), then a bare alias for discoverability.
    // A rejected alias (name already taken) only skips the alias; a rejected
    // primary fails this command, never the whole plugin mount.
    const names = options.manifest.name === entry.name
      ? [entry.name]
      : [`${options.manifest.name}:${entry.name}`, entry.name]
    let loaded = false
    for (const [index, name] of names.entries()) {
      try {
        disposers.push(options.commands.register({ ...definition, name }))
        if (index === 0) loaded = true
      } catch (error) {
        if (index === 0) {
          tally.addFailed(`command "${entry.name}": ${String(error)}`)
          break
        }
        tally.addSkipped(`bare name "${entry.name}" not registered (namespaced form remains): ${String(error)}`)
      }
    }
    if (loaded) tally.addLoaded()
  }
  return { disposers, tally }
}

/**
 * Scan `commands/*.md` when the manifest omitted `commands`. Nested
 * subdirectories are skipped with a reason (no silent drop, no colon names).
 */
function defaultCommandEntries(pluginRoot: string, tally: ComponentTally): CcCommand[] {
  const dir = join(pluginRoot, STANDARD_COMMANDS_DIR)
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: CcCommand[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      tally.addSkipped(`skipped nested commands directory "${entry.name}"`)
      continue
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    if (!entry.name.endsWith('.md')) continue
    found.push({ name: basename(entry.name, '.md'), source: join(STANDARD_COMMANDS_DIR, entry.name) })
  }
  return found
}

/** Resolve a command entry to consumable content, or a failure reason. */
function renderCommand(pluginRoot: string, entry: CcCommand): {
  body?: string
  description?: string
  argumentHint?: string
  error?: string
} {
  if (entry.content !== undefined) {
    return { body: entry.content }
  }
  if (entry.source !== undefined) {
    const path = resolve(pluginRoot, entry.source)
    try {
      const raw = readFileSync(path, 'utf8')
      const document = parseCcFrontmatterDocument(raw)
      const parsed = parseCcFrontmatter(raw)
      if (document === undefined || parsed === undefined) return { body: raw }
      return {
        body: document.body,
        ...parsed.description === undefined ? {} : { description: parsed.description },
        ...parsed.argumentHint === undefined ? {} : { argumentHint: parsed.argumentHint },
      }
    } catch (error) {
      return { error: `could not read command file "${entry.source}": ${String(error)}` }
    }
  }
  return { error: 'has neither "content" nor a readable "source"' }
}

/**
 * Substitute `$ARGUMENTS` with the invocation's raw input and steer the
 * rendered command body into the conversation as a user message — the same
 * cross-plane seam the upstream `/plan` command uses. Returning success
 * without `text` keeps the command plane from echoing the body back as a
 * status row: the injected message itself is the visible artifact.
 */
function dispatchCommandPrompt(invocation: CommandInvocationLike, body: string): CommandResult {
  const text = body.split('$ARGUMENTS').join(invocation.rawInput)
  try {
    invocation.agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    return { kind: 'success' }
  } catch (error) {
    return { kind: 'error', text: `could not dispatch command prompt: ${String(error)}` }
  }
}
