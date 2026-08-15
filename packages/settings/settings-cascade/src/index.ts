/**
 * Claude Code-style five-level settings cascade Provider for `ctx.settings`.
 * Five sources merge low-to-high — user settings, project settings, local
 * settings, flag settings, policy settings — under a plugin-default base.
 * The merged raw document feeds the user-settings seam, whose namespace
 * resolution layers schema defaults, the registrant `base`, and this user
 * layer in turn. A top-level `env` section is split out and applied in two
 * stages, holding dangerous variables until trust.
 * @module @jianxx/dsh-cc-settings-cascade
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { mergeSettingsSection } from './merge.ts'
import { coerceEnv, type EnvSettings } from './env.ts'

export { mergeValue, mergeSettingsSection, unionDenyPrecedence } from './merge.ts'
export { PermissionsSchema, PERMISSION_MODES, type Permissions, type PermissionMode } from './permissions.ts'
export { applyEnv, applyTrustedEnv, coerceEnv, DANGEROUS_ENV_VARS, type EnvSettings } from './env.ts'

/** All settings sources in merge order, low to high priority. */
export const SETTING_SOURCES = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
] as const

/** One source in the settings cascade. */
export type SettingsSource = (typeof SETTING_SOURCES)[number]

/** Policy sub-sources in first-source-wins priority order. */
export interface CascadePolicyConfig {
  /** Hosted remote settings — the highest-priority policy source. */
  remoteSettings?: unknown
  /** System-level managed settings file. */
  systemPath?: string
  /** User-writable managed settings file. */
  userPath?: string
}

/** Plugin configuration: source file locations and switches. */
export interface Config {
  /** Project root used for the default project/local setting paths. */
  projectDir?: string
  /** Harness home used for the default user settings path. */
  dshHome?: string
  /** User settings file; defaults to `settings.json` under the harness home. */
  userSettingsPath?: string
  /** Project settings file; defaults to `<project>/.claude/settings.json`. */
  projectSettingsPath?: string
  /** Local settings file; defaults to `<project>/.claude/settings.local.json`. */
  localSettingsPath?: string
  /** Command-line `--settings` file; the flag layer's file half. */
  flagSettingsPath?: string
  /** Inline `--settings` content; merged over the flag file. */
  flagSettingsInline?: unknown
  /** Policy sub-sources; the first non-empty one wins. */
  policy?: CascadePolicyConfig
}

/** Fully resolved provider parameters; defaulting happens here, never inline. */
export interface ResolvedSpec {
  sources: {
    userSettings: string | undefined
    projectSettings: string | undefined
    localSettings: string | undefined
    flagSettings: string | undefined
  }
  flagSettingsInline: unknown
  policy: {
    systemPath: string | undefined
    userPath: string | undefined
    remoteSettings: unknown
  }
}

/** Whether a value is a plain data object (not an array, null, or instance). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Whether a filesystem error simply means the file is absent. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Resolve the runtime spec from plugin config: explicit paths win, otherwise
 * the defaults derive from the harness home and the project directory.
 * @param config - raw plugin config.
 * @returns the resolved source locations, inline flag settings, and policy sources.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  const projectDir = resolve(config.projectDir ?? process.cwd())
  const home = resolveDshHome(config.dshHome)
  return {
    sources: {
      userSettings: config.userSettingsPath ?? join(home, 'settings.json'),
      projectSettings: config.projectSettingsPath ?? join(projectDir, '.claude', 'settings.json'),
      localSettings: config.localSettingsPath ?? join(projectDir, '.claude', 'settings.local.json'),
      flagSettings: config.flagSettingsPath,
    },
    flagSettingsInline: config.flagSettingsInline,
    policy: {
      remoteSettings: config.policy?.remoteSettings,
      systemPath: config.policy?.systemPath,
      userPath: config.policy?.userPath,
    },
  }
}

/**
 * Claude Code-style five-level settings cascade Provider. Reads the user,
 * project, local, flag, and policy sources in low-to-high priority, deep-merges
 * them (permission arrays union with `deny` precedence), resolves policy by
 * first-source-wins, splits out the top-level `env` section, and publishes the
 * merged per-namespace document into `ctx.settings`. Read-only: the seam's
 * in-process `update()`/`replace()` paths reject on this provider.
 */
export class SettingsCascadeProvider extends SettingsProvider {
  static Config: z<Config> = z.object({
    projectDir: z.string(),
    dshHome: z.string(),
    userSettingsPath: z.string(),
    projectSettingsPath: z.string(),
    localSettingsPath: z.string(),
    flagSettingsPath: z.string(),
    flagSettingsInline: z.any(),
    policy: z.object({
      remoteSettings: z.any(),
      systemPath: z.string(),
      userPath: z.string(),
    }),
  })

  private readonly spec: ResolvedSpec
  /** The top-level `env` section split out of the merged document, string-valued. */
  private env: EnvSettings = {}

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Programmatic construction may bypass Schemastery normalization; resolve
    // the same defaults in one explicit step either way.
    this.spec = resolveSpec(config)
  }

  /** The cascade is a read-only composition; namespaces write through their leaf provider. */
  get writable(): boolean {
    return false
  }

  /**
   * Refuse any write: the seam rejects writes on a read-only provider before
   * reaching this method, so it never runs; it exists to satisfy the abstract
   * contract and fails loud if a subclass ever routes a write through it.
   * @param ns - the namespace being written.
   * @param section - the section whose persistence was attempted.
   */
  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    void ns
    void section
    throw new Error('settings-cascade: the cascade provider is read-only and cannot persist')
  }

  /**
   * Read the merged top-level `env` section. Values are already coerced to
   * strings. Pass the result to {@link applyEnv} / {@link applyTrustedEnv} for
   * the untrusted and trusted application stages.
   * @returns the detached `env` section (empty object when none is configured).
   */
  getEnv(): EnvSettings {
    return structuredClone(this.env)
  }

  /**
   * Merge all five sources low-to-high and publish the per-namespace document,
   * splitting the top-level `env` section into {@link getEnv}. A present-but-
   * invalid source file fails load loud; absent sources contribute nothing.
   * @returns the merged document minus its top-level `env` key.
   */
  protected async load(): Promise<Record<string, unknown>> {
    const user = await this.readOptional(this.spec.sources.userSettings)
    const project = await this.readOptional(this.spec.sources.projectSettings)
    const local = await this.readOptional(this.spec.sources.localSettings)
    const flag = await this.resolveFlag()
    const policy = await this.resolvePolicy()

    const merged = [user, project, local, flag, policy]
      .reduce<Record<string, unknown>>(
        (acc, layer) => (Object.keys(layer).length === 0
          ? acc
          : mergeSettingsSection(acc, layer)),
        {},
      )

    const { env, ...document } = merged
    this.env = this.coerceEnvSection(env)
    return document
  }

  /** Read a source file into raw settings, skipping absence and failing loud on invalidity. */
  private async readOptional(path: string | undefined): Promise<Record<string, unknown>> {
    if (path === undefined) return {}
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (isENOENT(error)) return {}
      throw error
    }
    return this.parse(path, text)
  }

  /** Parse one settings document, throwing loud on a non-object root or invalid JSON. */
  private parse(path: string, text: string): Record<string, unknown> {
    let root: unknown
    try {
      root = text.trim().length === 0 ? {} : JSON.parse(text)
    } catch (error) {
      throw new Error(`settings-cascade: invalid settings document at ${path}: ${(error as Error).message}`, { cause: error })
    }
    if (!isPlainObject(root)) {
      throw new TypeError(`settings-cascade: ${path} must be a JSON object of namespace sections`)
    }
    return root
  }

  /** Merge the flag file and inline content, inline last (highest within the flag layer). */
  private async resolveFlag(): Promise<Record<string, unknown>> {
    const file = await this.readOptional(this.spec.sources.flagSettings)
    if (!isPlainObject(this.spec.flagSettingsInline)) return file
    return mergeSettingsSection(file, this.spec.flagSettingsInline)
  }

  /** Resolve policy by first-source-wins: remote, then system file, then user file. */
  private async resolvePolicy(): Promise<Record<string, unknown>> {
    const { remoteSettings, systemPath, userPath } = this.spec.policy
    if (isPlainObject(remoteSettings) && Object.keys(remoteSettings).length > 0) {
      return remoteSettings
    }
    for (const path of [systemPath, userPath]) {
      if (path === undefined) continue
      const settings = await this.readOptional(path)
      if (Object.keys(settings).length > 0) return settings
    }
    return {}
  }

  /** Coerce every `env` value to its string process-environment form. */
  private coerceEnvSection(value: unknown): EnvSettings {
    if (!isPlainObject(value)) return {}
    const out: EnvSettings = {}
    for (const [name, raw] of Object.entries(value)) {
      out[name] = coerceEnv(raw)
    }
    return out
  }
}

export default SettingsCascadeProvider
