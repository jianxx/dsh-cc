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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ccToolAliases } from '@jianxx/dsh-cc-tools'
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
  SWITCHABLE_PERMISSION_MODES,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRule,
  type PermissionRuleSet,
  type PermissionRuleSource,
} from './types.ts'
import {
  foldPermissionMode,
  foldResumeSandbox,
  setPermissionMode,
} from './mode.ts'

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
        const subject = this.subjectOf(exec)
        if (subject === undefined || !this.ruleMatches(rule, exec.name, subject)) return undefined
        return `denied by permission rule ${ruleString(rule.toolName, rule.content)} [${rule.source}] (bypass-immune)`
      }),
    )
  }

  /** Whether a rule's tool name and content (when present) match a call. */
  private ruleMatches(rule: PermissionRule, toolName: string, subject: string): boolean {
    if (!this.ruleMatchesTool(rule, toolName)) return false
    if (rule.content === undefined || rule.matcher === undefined) return false
    return contentMatches(rule.matcher, subject)
  }

  /** Whether an authored rule's tool name answers to a harness call's tool name. */
  private ruleMatchesTool(rule: PermissionRule, toolName: string): boolean {
    // The harness exec.name is lowercase; the rule preserves its authored CC
    // spelling, so compare through the CC↔harness alias map.
    return ccToolAliases(toolName).includes(rule.toolName)
  }

  /** Whether a harness call name counts as the configured bash tool. */
  private isBashToolName(name: string): boolean {
    return name === this.bashToolName || ccToolAliases(name).includes(this.bashToolName)
  }

  /** Extract the call subject for content matching (shell command or file path). */
  private subjectOf(exec: ToolExecution): string | undefined {
    const args = exec.arguments as Record<string, unknown>
    if (this.isBashToolName(exec.name) && typeof args.command === 'string') return args.command
    if (typeof args.file_path === 'string') return args.file_path
    return undefined
  }

  /** The effective mode for one call: plan overlays, else the session override. */
  private effectiveMode(exec: ToolExecution): PermissionMode {
    const agent = exec.agent
    if (agent !== undefined && foldPlanMode(agent.session.events)) return 'plan'
    const recorded = agent === undefined ? undefined : foldPermissionMode(agent.session.events)
    return recorded ?? this.state.defaultMode
  }

  /** Whether a call is sandboxed bash for the whole-tool-ask exemption. */
  private sandboxedBash(exec: ToolExecution): boolean {
    if (!this.config.exemptSandboxedBashFromToolAsk) return false
    if (!this.isBashToolName(exec.name)) return false
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
    if (this.isBashToolName(exec.name) && typeof args.command === 'string') {
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
   * then the normal waterfall proceeds unchanged. Under `auto`, a classifier-LOW
   * call whose waterfall decision is `ask` is auto-allowed (the classifier
   * proxies the prompt); MEDIUM/HIGH already returned above.
   */
  private decide(exec: ToolExecution): PermissionDecision {
    const risk = this.classify(exec)
    if (risk.level === 'HIGH') {
      return { kind: 'deny', reason: `blocked by risk classifier: ${risk.reasons.join('; ')}` }
    }
    const mode = this.effectiveMode(exec)
    if (risk.level === 'MEDIUM') {
      if (mode === 'bypassPermissions') return { kind: 'allow' }
      return { kind: 'ask', reason: `requires approval by risk classifier: ${risk.reasons.join('; ')}` }
    }
    const subject = this.subjectOf(exec)
    const decision = evaluatePermission({
      toolName: exec.name,
      ...subject === undefined ? {} : { subject },
      // Bypass-immune rules are enforced by the monotonic guard layer, not the
      // waterfall — pass an empty bypassImmune so the guard is authoritative.
      rules: { ...this.state.rules, bypassImmune: [] },
      mode,
      ...this.bypassDisabled() ? { bypassDisabled: true } : {},
      isFileEdit: this.fileEditTools.has(exec.name),
      isReadOnly: this.readOnlyTools.has(exec.name),
      sandboxedBashExempt: this.sandboxedBash(exec),
    })
    // auto proxies every ask: at this point the call is classifier-LOW (MEDIUM
    // and HIGH returned above), so low-risk asks auto-allow.
    if (mode === 'auto' && decision.kind === 'ask') {
      return { kind: 'allow' }
    }
    return decision
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
   * Switch a session's permission mode durably. `plan` is owned by plan-mode and
   * throws here (enter on the same session via plan-mode's `/plan`). Entering
   * `bypassPermissions` pins the session sandbox to `danger-full-access` and
   * records the prior mode for restore; leaving restores the recorded (or
   * fallback `workspace-write`) confinement. Unknown or disabled modes throw.
   * @param agent - the live agent whose session mode is changing.
   * @param mode - the new permission mode.
   */
  setMode(agent: Agent, mode: PermissionMode): void {
    if (mode === 'plan') {
      throw new TypeError('permission mode "plan" is owned by plan-mode; use /plan or /permissions plan')
    }
    if (!SWITCHABLE_PERMISSION_MODES.includes(mode)) {
      throw new TypeError(`permission mode must be one of ${[...SWITCHABLE_PERMISSION_MODES, 'plan'].join(', ')}`)
    }
    if (mode === 'bypassPermissions' && this.bypassDisabled()) {
      throw new Error('bypassPermissions is disabled by disableBypassPermissionsMode')
    }
    const session = agent.session
    const current = foldPermissionMode(session.events) ?? this.state.defaultMode
    if (current === mode) return

    const wasBypass = current === 'bypassPermissions'
    const enteringBypass = mode === 'bypassPermissions'

    if (enteringBypass) {
      const resume = effectiveSandboxMode(session.events)
        ?? (this.ctx.get('shell')?.sandboxMode as SandboxMode | undefined)
      const alreadyFull = (effectiveSandboxMode(session.events) ?? (this.ctx.get('shell')?.sandboxMode as SandboxMode | undefined)) === 'danger-full-access'
      setPermissionMode(session, mode, resume)
      if (!alreadyFull) setSandboxMode(session, 'danger-full-access')
    } else {
      setPermissionMode(session, mode)
      if (wasBypass) {
        const restore = foldResumeSandbox(session.events)
          ?? (this.ctx.get('shell')?.sandboxMode as SandboxMode | undefined)
          ?? 'workspace-write'
        if ((effectiveSandboxMode(session.events) ?? (this.ctx.get('shell')?.sandboxMode as SandboxMode | undefined)) !== restore) {
          setSandboxMode(session, restore)
        }
      }
    }

    try {
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: `The permission mode changed to "${mode}" (changed by the user).` }],
        source: { kind: 'plugin', plugin: 'permission-rules' },
      }))
    } catch {
      // Tests and headless agents may omit inject; mode is already durable.
    }
  }

  /** The currently merged rule set (for introspection and host preview). */
  get ruleSet(): PermissionRuleSet {
    return this.state.rules
  }
}

export default PermissionRulesService
