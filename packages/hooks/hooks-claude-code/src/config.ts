/**
 * Parse Claude Code's event-to-matcher-group hook format into shared {@link MatcherGroup}s,
 * accepting all four executor kinds (`command`, `prompt`, `http`, `agent`). A hook with no
 * `type` is a command (CC's default). Plugin-root and project-directory substitutions are
 * applied to `command` strings at parse time.
 * @module @jianxx/dsh-cc-hooks-claude-code/config
 */

import {
  matcherDiagnostic,
  type AgentHook,
  type CommandHook,
  type HookCommand,
  type HttpHook,
  type MatcherGroup,
  type PromptHook,
} from '@jianxx/dsh-cc-hook-protocol'

const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStart',
  'SubagentStop',
] as const

/** A parsed CC config: event name → its matcher groups (any executor kind). */
export type ClaudeCodeHookConfig = Record<string, MatcherGroup[]>

/** A skipped non-command hook, surfaced so the bridge can warn about it. */
export interface SkippedHook {
  event: string
  type: string
}

/** The outcome of parsing one config file: the runnable groups + what was skipped. */
export interface ParsedClaudeConfig {
  config: ClaudeCodeHookConfig
  skipped: SkippedHook[]
}

/** Substitution variables applied to each `command` string at parse time. */
export interface SubstitutionVars {
  /** Replaces `${CLAUDE_PLUGIN_ROOT}` — the plugin's root dir. */
  pluginRoot?: string
  /** Replaces `${CLAUDE_PROJECT_DIR}` — the project root. */
  projectDir?: string
}

/** A plain (non-null, non-array) object, else undefined. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** A positive integer timeout in seconds, else undefined. */
function timeoutSecOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Apply `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}` substitution to a command string.
 * @param command - the raw command from config.
 * @param vars - the substitution values; a token whose variable is unset stays verbatim.
 * @returns the command with every occurrence of each set token replaced.
 */
export function substituteCommand(command: string, vars: SubstitutionVars): string {
  let out = command
  if (vars.pluginRoot !== undefined) out = out.split('${CLAUDE_PLUGIN_ROOT}').join(vars.pluginRoot)
  if (vars.projectDir !== undefined) out = out.split('${CLAUDE_PROJECT_DIR}').join(vars.projectDir)
  return out
}

/**
 * Parse one hook object into the matching {@link HookCommand}. Unknown `type`
 * values and malformed entries return `undefined` (dropped, not fatal). The
 * `command` kind applies substitution; the other (non-shell) kinds carry only
 * their wire fields plus a shared `timeoutSec`.
 * @param raw - the hook object from config.
 * @param vars - substitution values applied to a `command` value.
 * @returns the parsed hook, or `undefined` if malformed.
 */
function parseHook(raw: unknown, vars: SubstitutionVars): HookCommand | undefined {
  const hook = asObject(raw)
  if (!hook) return undefined
  const type = typeof hook.type === 'string' ? hook.type : 'command'
  const timeoutSec = timeoutSecOf(hook.timeout)
  if (type === 'command') {
    if (typeof hook.command !== 'string') return undefined
    const command: CommandHook = { command: substituteCommand(hook.command, vars) }
    if (timeoutSec !== undefined) command.timeoutSec = timeoutSec
    return command
  }
  if (type === 'prompt') {
    const prompt: PromptHook = { type: 'prompt', prompt: typeof hook.prompt === 'string' ? hook.prompt : '' }
    if (typeof hook.model === 'string') prompt.model = hook.model
    if (timeoutSec !== undefined) prompt.timeoutSec = timeoutSec
    return prompt
  }
  if (type === 'http') {
    if (typeof hook.url !== 'string') return undefined
    const http: HttpHook = { type: 'http', url: hook.url }
    if (typeof hook.headers === 'object' && hook.headers !== null && !Array.isArray(hook.headers)) {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(hook.headers)) if (typeof v === 'string') headers[k] = v
      if (Object.keys(headers).length > 0) http.headers = headers
    }
    if (Array.isArray(hook.allowedEnvVars)) {
      const names = hook.allowedEnvVars.filter((v): v is string => typeof v === 'string')
      if (names.length > 0) http.allowedEnvVars = names
    }
    if (timeoutSec !== undefined) http.timeoutSec = timeoutSec
    return http
  }
  if (type === 'agent') {
    const agent: AgentHook = { type: 'agent', prompt: typeof hook.prompt === 'string' ? hook.prompt : '' }
    if (typeof hook.model === 'string') agent.model = hook.model
    if (timeoutSec !== undefined) agent.timeoutSec = timeoutSec
    return agent
  }
  return undefined
}

/**
 * Parse either a settings `hooks` value or a bare `hooks.json` event map. Malformed entries are
 * ignored rather than failing boot; unsupported events are ignored before their groups are parsed,
 * and substitutions are applied to every surviving `command`. Matcher fields on UserPromptSubmit
 * and Stop are discarded because those events have no matcher subject. A matcher-bearing supported
 * runnable group with an invalid regex throws a `SyntaxError`, allowing the bridge to reject the
 * complete config before listener registration.
 *
 * @param raw - the parsed JSON config: a settings object with a `hooks` key, or the bare
 *   event map.
 * @param vars - substitution values applied to every surviving `command` (defaults to
 *   none).
 * @returns the runnable per-event groups plus the skipped non-command hooks.
 */
export function parseClaudeCodeConfig(raw: unknown, vars: SubstitutionVars = {}): ParsedClaudeConfig {
  const config: ClaudeCodeHookConfig = {}
  const skipped: SkippedHook[] = []
  // Accept either `{ hooks: { … } }` (a settings file) or the bare event map.
  const root = asObject(raw)
  const hooksMap = root ? asObject(root.hooks) ?? root : undefined
  if (!hooksMap) return { config, skipped }

  for (const event of CLAUDE_EVENTS) {
    const rawGroups = hooksMap[event]
    if (!Array.isArray(rawGroups)) continue
    const groups: MatcherGroup[] = []
    for (const rawGroup of rawGroups) {
      const group = asObject(rawGroup)
      if (!group || !Array.isArray(group.hooks)) continue
      const hooks: MatcherGroup['hooks'] = []
      for (const rawHook of group.hooks) {
        const hook = parseHook(rawHook, vars)
        if (hook === undefined) {
          const h = asObject(rawHook)
          const type = h && typeof h.type === 'string' ? h.type : 'command'
          if (type !== 'command') skipped.push({ event, type })
          continue
        }
        hooks.push(hook)
      }
      if (hooks.length === 0) continue
      const matcher = event === 'UserPromptSubmit' || event === 'Stop'
        ? undefined
        : typeof group.matcher === 'string' ? group.matcher : undefined
      const diagnostic = matcherDiagnostic(matcher, 'claude-code')
      if (diagnostic !== undefined) throw new SyntaxError(`${diagnostic} on event ${JSON.stringify(event)}`)
      groups.push({
        ...matcher !== undefined ? { matcher } : {},
        hooks,
      })
    }
    if (groups.length > 0) config[event] = groups
  }

  return { config, skipped }
}
