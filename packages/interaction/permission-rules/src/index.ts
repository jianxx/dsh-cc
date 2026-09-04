/**
 * Claude Code-compatible permission-rule engine. Owns a source-labelled rule
 * set (Config `rules` merged with the optional `permissions` settings section),
 * a `tools/pre-execute` listener that folds a mode-aware decision, and the
 * monotonic guard layer that enforces bypass-immune content rules so neither a
 * mode switch nor `bypassPermissions` can override them. A risk-classifier
 * escalation stage hard-denies catastrophic commands and asks on protected or
 * out-of-scope file writes before the normal waterfall. Rules fail loud at
 * load; settings hot-reloads by rebuilding merged state and re-registering
 * guards.
 *
 * @module @jianxx/dsh-cc-permission-rules
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { foldPlanMode } from '@deepseek-ai/dsh-plan-mode'
import { effectiveSandboxMode, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { PreToolDecision, ToolExecution } from '@jianxx/dsh-cc-tools'
import { foldSessionCwd } from '@jianxx/dsh-cc-session-cwd'
import { installSettingsSection, settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
// Side-effect type import: declaration-merges `ctx.shell` (the capability fact
// `sandboxMode` this plugin reads for the sandboxed-bash exemption). No value
// dependency on the seam.
import type {} from '@deepseek-ai/dsh-shell'
import { parseRule, ruleString } from './parser.ts'
import { mergeRuleSets } from './evaluate.ts'
import { decideCall, type DecideDeps } from './decide.ts'
import {
  PERMISSION_MODES,
  SOURCE_PRIORITY,
  type PermissionMode,
  type PermissionRule,
  type PermissionRuleSet,
  type PermissionRuleSource,
} from './types.ts'
import {
  foldPermissionMode,
  setPermissionMode,
  switchSessionPermissionMode,
} from './mode.ts'
import { ruleMatches, subjectOf } from './matchers.ts'
import { SessionAllowlist, foldSessionAllows } from './session-allowlist.ts'
import { createSandboxApprovalListener } from './approval-listener.ts'

export {
  SESSION_ALLOW_EVENT,
  SessionAllowlist,
  appendSessionAllow,
  foldSessionAllows,
  type SessionAllowEventData,
} from './session-allowlist.ts'
export {
  createSandboxApprovalListener,
  isSandboxEscalation,
  type SandboxApprovalListenerConfig,
} from './approval-listener.ts'

export {
  foldPermissionMode,
  foldResumeSandbox,
  setPermissionMode,
  PERMISSION_MODE_EVENT,
} from './mode.ts'
export {
  PERMISSION_MODES,
  SWITCHABLE_PERMISSION_MODES,
  PLAN_READONLY_REASON,
  type PermissionMode,
  type SwitchablePermissionMode,
} from './types.ts'
export {
  parseRuleString,
  ruleString,
  contentMatches,
} from './parser.ts'
export { canonicalizeHostname, isWebFetchRuleTool } from './domain.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The mounted permission-rule engine, when this plugin is composed. */
    permissionRules: PermissionRulesService
  }
}

/** The settings namespace carrying `permissions.allow/deny/ask/defaultMode`. */
export const PERMISSION_SETTINGS_NAMESPACE: SettingsNamespace = settingsNamespace('permissions')

/** The settings section resolved from the settings document. */
export interface PermissionSettings {
  /** Whole-tool or content rules that allow matching calls. */
  allow?: string[]
  /** Whole-tool or content rules that deny matching calls. */
  deny?: string[]
  /** Whole-tool or content rules that route matching calls to approval. */
  ask?: string[]
  /** Default permission mode for sessions without a recorded override. */
  defaultMode?: PermissionMode
  /** `'disable'` turns off the ability to switch to `bypassPermissions`. */
  disableBypassPermissionsMode?: 'disable'
  /** Additional directories included in the permission scope (escape-check base). */
  additionalDirectories?: string[]
  /** Protected file wildcard patterns — writes to them are high risk. */
  protectedFiles?: string[]
  /** Raw dangerous-command regex sources replacing the curated defaults. */
  dangerousPatterns?: string[]
}

/** The Config-provided rule set: strings parsed as source-`config` rules. */
export interface ConfigRules {
  /** Allow rules. */
  allow?: string[]
  /** Deny rules. */
  deny?: string[]
  /** Ask rules. */
  ask?: string[]
  /**
   * Bypass-immune deny rules (e.g. `.git` internals, shell-config paths):
   * enforced through the monotonic guard layer, never overridable by a mode
   * switch or `bypassPermissions`.
   */
  bypassImmune?: string[]
}

/** Plugin config. All optional; the schema applies the defaults shown. */
export interface Config {
  /**
   * The rule set provided directly by composition, parsed with source
   * `config`. Merged with the optional settings section by source priority
   * (settings rules win).
   */
  rules?: ConfigRules
  /** Settings namespace holding allow/deny/ask/defaultMode; defaults to `permissions`. */
  settingsNamespace?: string
  /**
   * The source label applied to settings-resolved rules; defaults to
   * `userSettings`. Lets a deployment attribute settings rules to a different
   * settings layer (project/local/…).
   */
  settingsSource?: PermissionRuleSource
  /** Default mode for sessions without an in-memory mode override; defaults to `default`. */
  defaultMode?: PermissionMode
  /** Tool name treated as the shell-command tool for content extraction; defaults to `Bash`. */
  bashToolName?: string
  /** File-edit tool names auto-allowed under `acceptEdits` mode. */
  fileEditTools?: string[]
  /** Read-only tool names auto-allowed under `plan` mode. */
  readOnlyTools?: string[]
  /**
   * Skip a whole-tool `ask` for a sandboxed (confining, non-full-access)
   * `Bash` call — allow instead. Defaults to `false`.
   */
  exemptSandboxedBashFromToolAsk?: boolean
  /** Whether `bypassPermissions` mode is disabled (falls back to `default`). */
  disableBypassPermissionsMode?: boolean
  /**
   * Whether the risk-classifier escalation stage runs inside the decision
   * flow (catastrophic commands hard-deny; protected/out-of-scope file writes
   * ask unless under `bypassPermissions`). Defaults to `true`.
   */
  classifierEnabled?: boolean
}

/** The standard file-edit tool set, applied when {@link Config.fileEditTools} is omitted. */
const DEFAULT_FILE_EDIT_TOOLS = ['edit', 'write', 'multi_edit', 'notebook_edit', 'str_replace_editor']

/** The standard read-only tool set, applied when {@link Config.readOnlyTools} is omitted. */
const DEFAULT_READ_ONLY_TOOLS = ['read', 'glob', 'grep', 'search', 'web_fetch', 'web_search']

/** One short model-facing sentence per permission mode for the prompt context. */
const MODE_SENTENCE: Record<PermissionMode, string> = {
  default: 'Permission mode: default. Tool calls follow allow/deny/ask rules; unmatched calls pass through.',
  acceptEdits: 'Permission mode: acceptEdits. File edits are auto-allowed; other calls follow the rules.',
  plan: 'Permission mode: plan. Only read-only tools may run; submit the plan via exit_plan_mode.',
  auto: 'Permission mode: auto. Low-risk approval prompts are auto-allowed; medium-risk prompts still ask the user.',
  bypassPermissions: 'Permission mode: bypassPermissions. Permission prompts are skipped and the sandbox is full access, except bypass-immune and catastrophic commands which remain denied.',
}

/** The shared settings schema (Config-facing and settings-provider-facing). */
function permissionSettingsSchema(): z<PermissionSettings> {
  return z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
    ask: z.array(z.string()),
    defaultMode: z.union(PERMISSION_MODES as PermissionMode[]),
    disableBypassPermissionsMode: z.union(['disable'] as const),
    additionalDirectories: z.array(z.string()),
    protectedFiles: z.array(z.string()),
    dangerousPatterns: z.array(z.string()),
  })
}

/** Build a settings-resolved rule set from a settings section. */
function settingsRuleSet(settings: PermissionSettings, source: PermissionRuleSource): PermissionRuleSet {
  return {
    allow: (settings.allow ?? []).map(raw => parseRule(raw, 'allow', source)),
    deny: (settings.deny ?? []).map(raw => parseRule(raw, 'deny', source)),
    ask: (settings.ask ?? []).map(raw => parseRule(raw, 'ask', source)),
    bypassImmune: [],
  }
}

/** The engine's Service Definition plus the mode/rule write and read surface. */
export class PermissionRulesService extends Service {
  static Config: z<Config> = z.object({
    rules: z.object({
      allow: z.array(z.string()),
      deny: z.array(z.string()),
      ask: z.array(z.string()),
      bypassImmune: z.array(z.string()),
    }),
    settingsNamespace: z.string().default('permissions'),
    settingsSource: z.union(SOURCE_PRIORITY as PermissionRuleSource[]).default('userSettings'),
    defaultMode: z.union(PERMISSION_MODES as PermissionMode[]).default('default'),
    bashToolName: z.string().default('Bash'),
    fileEditTools: z.array(z.string()).default(DEFAULT_FILE_EDIT_TOOLS),
    readOnlyTools: z.array(z.string()).default(DEFAULT_READ_ONLY_TOOLS),
    exemptSandboxedBashFromToolAsk: z.boolean().default(false),
    disableBypassPermissionsMode: z.boolean().default(false),
    classifierEnabled: z.boolean().default(true),
  })

  static inject = ['tools']

  private readonly bashToolName: string
  private readonly fileEditTools: ReadonlySet<string>
  private readonly readOnlyTools: ReadonlySet<string>
  private readonly settingsSource: PermissionRuleSource
  private readonly rulesConfig: ConfigRules
  private readonly bypassImmuneRules: readonly PermissionRule[]
  /** Reads the currently authoritative settings section (swapped by the settings hook). */
  private settingsRead: () => PermissionSettings = () => ({})
  /** Live merged state; rebuilt on settings change so listeners read a fresh snapshot. */
  private state: { rules: PermissionRuleSet; defaultMode: PermissionMode }
  /** Disposers for the currently registered monotonic guards. */
  private guardDisposers: (() => void)[] = []
  /** Session-scoped approval memory (WS4-PR-B): rules granted via the UI's "Allow for this session". */
  private readonly sessionAllowlist = new SessionAllowlist()
  /** Session ids already seeded from their log's `permission/session-allow` audit events. */
  private readonly allowlistSeeded = new Set<string>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'permissionRules')
    // The schema applied the defaults, so these are non-optional at runtime.
    this.bashToolName = config.bashToolName as string
    this.fileEditTools = new Set(config.fileEditTools)
    this.readOnlyTools = new Set(config.readOnlyTools)
    this.settingsSource = config.settingsSource as PermissionRuleSource
    this.rulesConfig = config.rules as ConfigRules | undefined ?? {}
    this.bypassImmuneRules = (this.rulesConfig.bypassImmune ?? []).map(raw => parseRule(raw, 'deny', 'config'))
    this.state = { rules: this.configRuleSet(), defaultMode: config.defaultMode as PermissionMode }

    // Monotonic guard layer for bypass-immune rules: never overridable.
    this.registerGuards()

    // Optional settings inject: absent `ctx.settings` leaves only the Config
    // rules in force, exactly as the fallback contract requires. A stored
    // change re-enters reload() to rebuild merged state and the guards.
    installSettingsSection(ctx, PERMISSION_SETTINGS_NAMESPACE, permissionSettingsSchema(), {}, {
      setSource: (current) => { this.settingsRead = current },
      onChange: () => this.reload(),
      validate: value => this.validateSettings(value),
    })

    // The decision waterfall lives in ./decide.ts as pure functions over this
    // structural dependency face; the closures read live fields so a settings
    // reload is observed on the next call.
    const decideDeps: DecideDeps = {
      classifierEnabled: config.classifierEnabled !== false,
      exemptSandboxedBashFromToolAsk: config.exemptSandboxedBashFromToolAsk === true,
      bashToolName: this.bashToolName,
      fileEditTools: this.fileEditTools,
      readOnlyTools: this.readOnlyTools,
      settings: () => this.settingsSection(),
      defaultMode: () => this.state.defaultMode,
      rules: () => this.state.rules,
      bypassDisabled: () => this.bypassDisabled(),
      sessionAllowMatches: (exec) => this.sessionAllowMatches(exec),
      shellMode: () => this.ctx.get('shell')?.sandboxMode as SandboxMode | undefined,
    }

    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      const decision = decideCall(decideDeps, exec)
      if (decision.kind === 'allow') return { kind: 'allow' }
      if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason }
      if (decision.kind === 'ask') return { kind: 'ask', ...decision.reason === undefined ? {} : { reason: decision.reason } }
      return next()
    })

    // WS3 sandbox integration: the approval-seam listener auto-approves
    // sandbox escalations in `auto` mode when the session has a resolvable
    // workspace root. Registered ahead of any UI provider so an eligible
    // escalation never reaches the modal queue; every auto-approval is
    // audit-logged to the session log (`scope: 'sandbox-auto'`).
    ctx.on('approval/request', createSandboxApprovalListener({
      modeOf: (agent) => {
        if (foldPlanMode(agent.session.events)) return 'plan'
        return foldPermissionMode(agent.session.events) ?? this.state.defaultMode
      },
      workspaceOf: (agent) => this.sessionWorkspaceOf(agent),
    }))

    // Pin sessions created while the deployment default is a sandbox-affecting or
    // plan mode so a fresh session inherits the default durably.
    ctx.on('session/created', (session) => {
      if (foldPermissionMode(session.events) !== undefined) return
      if (foldPlanMode(session.events)) return
      const mode = this.state.defaultMode
      if (mode === 'bypassPermissions') {
        if (this.bypassDisabled()) return
        const resume = effectiveSandboxMode(session.events)
          ?? (this.ctx.get('shell')?.sandboxMode as SandboxMode | undefined)
        setPermissionMode(session, 'bypassPermissions', resume)
        if ((effectiveSandboxMode(session.events) ?? (this.ctx.get('shell')?.sandboxMode as SandboxMode | undefined)) !== 'danger-full-access') {
          setSandboxMode(session, 'danger-full-access')
        }
        return
      }
      if (mode === 'plan') {
        session.append('plan/mode', { active: true })
      }
    })

    // Optional model-facing mode sentence. Injected via ctx.inject so a missing
    // system-prompt seam is a silent no-op rather than a required dependency.
    ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.context({
        name: 'permission:mode',
        order: 116,
        text: (context) => {
          const agent = context.agent
          if (agent === undefined) return ''
          const mode = foldPlanMode(agent.session.events)
            ? 'plan'
            : (foldPermissionMode(agent.session.events) ?? this.state.defaultMode)
          return MODE_SENTENCE[mode]
        },
      })
    })
  }

  /** The current settings-resolved section, defaulting to the schema default. */
  private settingsSection(): PermissionSettings {
    return this.settingsRead()
  }

  /** Reject a settings section the engine could not act on — fail loud at the settings boundary. */
  private validateSettings(value: PermissionSettings): void {
    for (const raw of [...value.allow ?? [], ...value.deny ?? [], ...value.ask ?? []]) {
      parseRule(raw, 'allow', this.settingsSource)
    }
    if (value.defaultMode !== undefined && !PERMISSION_MODES.includes(value.defaultMode)) {
      throw new Error(`permission: unknown defaultMode ${JSON.stringify(value.defaultMode)}`)
    }
  }

  /** Rebuild merged state and re-register guards (mount and settings change). */
  private reload(): void {
    const settings = this.settingsSection()
    this.state = {
      rules: mergeRuleSets(settingsRuleSet(settings, this.settingsSource), this.configRuleSet()),
      defaultMode: settings.defaultMode ?? this.config.defaultMode ?? 'default',
    }
    this.registerGuards()
  }

  /** Parse the Config `rules` block into a source-`config` rule set. */
  private configRuleSet(): PermissionRuleSet {
    const { allow = [], deny = [], ask = [] } = this.rulesConfig
    return {
      allow: allow.map(raw => parseRule(raw, 'allow', 'config')),
      deny: deny.map(raw => parseRule(raw, 'deny', 'config')),
      ask: ask.map(raw => parseRule(raw, 'ask', 'config')),
      bypassImmune: this.bypassImmuneRules,
    }
  }

  /** (Re)register monotonic guards for the bypass-immune rules, idempotent. */
  private registerGuards(): void {
    for (const dispose of this.guardDisposers) dispose()
    this.guardDisposers = this.bypassImmuneRules.map(rule =>
      this.ctx.tools.guard((exec) => {
        const subject = subjectOf(exec, this.bashToolName)
        if (subject === undefined || !ruleMatches(rule, exec.name, subject)) return undefined
        return `denied by permission rule ${ruleString(rule.toolName, rule.content)} [${rule.source}] (bypass-immune)`
      }),
    )
  }

  /**
   * Whether the session-scoped allowlist matches this call. The session's
   * rules are seeded once from its log's `permission/session-allow` audit
   * events, so a resumed session keeps its grants. Agent-less calls never
   * match (there is no session to scope to).
   */
  private sessionAllowMatches(exec: ToolExecution): boolean {
    const agent = exec.agent
    if (agent === undefined) return false
    const id = String(agent.session.id)
    if (!this.allowlistSeeded.has(id)) {
      this.allowlistSeeded.add(id)
      this.sessionAllowlist.seed(id, foldSessionAllows(agent.session.events))
    }
    return this.sessionAllowlist.matches(id, exec.name, subjectOf(exec, this.bashToolName))
  }

  /**
   * The session's workspace root: the durable `worktree/entered` fold
   * (session-cwd, WS1), falling back to the session header cwd. Undefined
   * when the session never recorded a cwd — the sandbox listener then cannot
   * verify an escalation is in-scope and falls through to the normal ask.
   */
  private sessionWorkspaceOf(agent: Agent): string | undefined {
    return foldSessionCwd(agent.session.events) ?? agent.session.header?.cwd
  }

  /**
   * Grant a session-scoped allow rule on the agent's session: in-memory match
   * for the rest of this session plus a `permission/session-allow` audit
   * event. Never touches the `permissions` settings namespace.
   * @param agent - the agent whose session is granted the rule.
   * @param rule - the rule string (e.g. `Bash(npm )` or a whole-tool name).
   */
  addSessionAllow(agent: Agent, rule: string): void {
    this.sessionAllowlist.add(agent.session, rule)
  }

  /**
   * Drop every session-scoped rule for the agent's session (audited clear
   * record in the session log).
   */
  clearSessionAllows(agent: Agent): void {
    this.sessionAllowlist.clear(agent.session)
  }

  /**
   * Whether switching to `bypassPermissions` is disabled by Config or the
   * settings section.
   */
  private bypassDisabled(): boolean {
    return this.config.disableBypassPermissionsMode === true
      || this.settingsSection().disableBypassPermissionsMode === 'disable'
  }

  /**
   * Switch a session's permission mode durably. Semantics live in
   * `switchSessionPermissionMode` (./mode.ts): `plan` is owned by plan-mode
   * and throws; entering `bypassPermissions` pins the session sandbox to
   * `danger-full-access` and records the prior mode for restore; unknown or
   * disabled modes throw.
   * @param agent - the live agent whose session mode is changing.
   * @param mode - the new permission mode.
   */
  setMode(agent: Agent, mode: PermissionMode): void {
    switchSessionPermissionMode({
      agent,
      mode,
      defaultMode: this.state.defaultMode,
      bypassDisabled: this.bypassDisabled(),
      shellMode: this.ctx.get('shell')?.sandboxMode as SandboxMode | undefined,
    })
  }

  /** The currently merged rule set (for introspection and host preview). */
  get ruleSet(): PermissionRuleSet {
    return this.state.rules
  }
}

export default PermissionRulesService
