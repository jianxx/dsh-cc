/**
 * Claude Code-compatible permission-rule engine. Owns a source-labelled rule
 * set (Config `rules` merged with the optional `permissions` settings section),
 * a `tools/pre-execute` listener that folds a mode-aware decision, and the
 * monotonic guard layer that enforces bypass-immune content rules so neither a
 * mode switch nor `bypassPermissions` can override them. A risk-classifier
 * escalation stage hard-denies catastrophic commands and asks on protected or
 * out-of-scope file writes before the normal waterfall. Rules fail loud at
 * load; settings hot-reloads by rebuilding merged state and re-registering
 * guards. Session mode overrides are recorded durably as `permission/mode`
 * events, surviving resume.
 *
 * @module @jianxx/dsh-cc-permission-rules
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { foldPlanMode } from '@deepseek-ai/dsh-plan-mode'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { PreToolDecision, ToolExecution } from '@jianxx/dsh-cc-tools'
import { installSettingsSection, settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
// Side-effect type import: declaration-merges `ctx.shell` (the capability fact
// `sandboxMode` this plugin reads for the sandboxed-bash exemption). No value
// dependency on the seam.
import type {} from '@deepseek-ai/dsh-shell'
import { parseRule, ruleString, contentMatches } from './parser.ts'
import { evaluatePermission, mergeRuleSets } from './evaluate.ts'
import { assessBashCommand, assessFilePath, type RiskAssessment } from './classifier.ts'
import {
  PERMISSION_MODES,
  SOURCE_PRIORITY,
  foldPermissionMode,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRule,
  type PermissionRuleSet,
  type PermissionRuleSource,
} from './types.ts'

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

/** The shared settings schema (Config-facing and settings-provider-facing). */
function permissionSettingsSchema(): z<PermissionSettings> {
  return z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
    ask: z.array(z.string()),
    defaultMode: z.union(PERMISSION_MODES as PermissionMode[]),
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

    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      const decision = this.decide(exec)
      if (decision.kind === 'allow') return { kind: 'allow' }
      if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason }
      if (decision.kind === 'ask') return { kind: 'ask', ...decision.reason === undefined ? {} : { reason: decision.reason } }
      return next()
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
        const subject = this.subjectOf(exec)
        if (subject === undefined || !this.ruleMatches(rule, exec.name, subject)) return undefined
        return `denied by permission rule ${ruleString(rule.toolName, rule.content)} [${rule.source}] (bypass-immune)`
      }),
    )
  }

  /** Whether a rule's tool name and content (when present) match a call. */
  private ruleMatches(rule: PermissionRule, toolName: string, subject: string): boolean {
    if (rule.toolName !== toolName) return false
    if (rule.content === undefined || rule.matcher === undefined) return false
    return contentMatches(rule.matcher, subject)
  }

  /** Extract the call subject for content matching (shell command or file path). */
  private subjectOf(exec: ToolExecution): string | undefined {
    const args = exec.arguments as Record<string, unknown>
    if (exec.name === this.bashToolName && typeof args.command === 'string') return args.command
    if (typeof args.file_path === 'string') return args.file_path
    return undefined
  }

  /** The effective mode for one call: plan overlays, else the session override. */
  private effectiveMode(exec: ToolExecution): PermissionMode {
    const agent = exec.agent
    if (agent !== undefined && foldPlanMode(agent.session.events)) return 'plan'
    return (agent === undefined ? undefined : foldPermissionMode(agent.session.events)) ?? this.state.defaultMode
  }

  /** Whether a call is sandboxed bash for the whole-tool-ask exemption. */
  private sandboxedBash(exec: ToolExecution): boolean {
    if (!this.config.exemptSandboxedBashFromToolAsk) return false
    if (exec.name !== this.bashToolName) return false
    const mode = this.ctx.get('shell')?.sandboxMode as SandboxMode | undefined
    return mode !== undefined && mode !== 'danger-full-access'
  }

  /**
   * Classify the risk of one call for the escalation stage. Bash-like tools
   * classify their command; file-edit tools classify their target path; other
   * tools are LOW. Skipped entirely when `classifierEnabled` is false.
   */
  private classify(exec: ToolExecution): RiskAssessment {
    if (this.config.classifierEnabled === false) return { level: 'LOW', reasons: [] }
    const args = exec.arguments as Record<string, unknown>
    const session = exec.agent?.session
    if (exec.name === this.bashToolName && typeof args.command === 'string') {
      return assessBashCommand(args.command, this.settingsSection().dangerousPatterns)
    }
    if (this.fileEditTools.has(exec.name) && typeof args.file_path === 'string') {
      const settings = this.settingsSection()
      return assessFilePath(args.file_path, {
        cwd: session?.header?.cwd ?? '',
        ...settings.additionalDirectories === undefined ? {} : { additionalDirectories: settings.additionalDirectories },
        ...settings.protectedFiles === undefined ? {} : { protectedFiles: settings.protectedFiles },
      })
    }
    return { level: 'LOW', reasons: [] }
  }

  /**
   * Fold the engine decision for one call. Bypass-immune matches fall to the
   * guard layer, not here. The risk-classifier escalation runs first (a
   * hard-deny HIGH in every mode; an ask MEDIUM outside bypassPermissions),
   * then the normal waterfall proceeds unchanged.
   */
  private decide(exec: ToolExecution): PermissionDecision {
    const risk = this.classify(exec)
    if (risk.level === 'HIGH') {
      return { kind: 'deny', reason: `blocked by risk classifier: ${risk.reasons.join('; ')}` }
    }
    if (risk.level === 'MEDIUM') {
      if (this.effectiveMode(exec) === 'bypassPermissions') return { kind: 'allow' }
      return { kind: 'ask', reason: `requires approval by risk classifier: ${risk.reasons.join('; ')}` }
    }
    const subject = this.subjectOf(exec)
    return evaluatePermission({
      toolName: exec.name,
      ...subject === undefined ? {} : { subject },
      // Bypass-immune rules are enforced by the monotonic guard layer, not the
      // waterfall — pass an empty bypassImmune so the guard is authoritative.
      rules: { ...this.state.rules, bypassImmune: [] },
      mode: this.effectiveMode(exec),
      ...this.config.disableBypassPermissionsMode === true ? { bypassDisabled: true } : {},
      isFileEdit: this.fileEditTools.has(exec.name),
      isReadOnly: this.readOnlyTools.has(exec.name),
      sandboxedBashExempt: this.sandboxedBash(exec),
    })
  }

  /**
   * Record a session's permission-mode override durably by appending a
   * `permission/mode` event to the session log, so the override survives a
   * resume. Plan activation, when active, still overlays at call time.
   * @param agent - the live agent whose mode is changing.
   * @param mode - the new permission mode; unknown modes throw.
   */
  setMode(agent: Agent, mode: PermissionMode): void {
    if (!PERMISSION_MODES.includes(mode)) {
      throw new TypeError(`permission mode must be one of ${PERMISSION_MODES.join(', ')}`)
    }
    agent.session.append('permission/mode', { mode })
  }

  /** The currently merged rule set (for introspection and host preview). */
  get ruleSet(): PermissionRuleSet {
    return this.state.rules
  }
}

export default PermissionRulesService
export { foldPermissionMode } from './types.ts'
