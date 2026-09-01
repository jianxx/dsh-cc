/**
 * Plugin-mount registry for the cc-shell glue plugin.
 *
 * Tracks every Claude Code plugin directory the glue mounts (keyed by plugin
 * root) and exposes a `ccPlugins` service so host plugins — slash commands such
 * as `/plugin`, `/reload-plugins`, `/mcp` — can enumerate what is mounted and
 * rescan the on-disk discovery roots live. Rescan disposes all tracked mounts
 * in reverse mount order (the innermost/last-mounted tear down first) and then
 * re-runs the same best-effort discovery the glue performs at activation,
 * collecting per-plugin failures without aborting the rest.
 *
 * @module
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import {
  discoverCcPluginRoots,
  mountCcPlugin,
  type DiscoveredCcPlugin,
  type PluginLoadReport,
  type ResolveModel,
} from '@jianxx/dsh-cc-plugin-loader'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The mounted Claude Code plugin registry, when cc-shell-glue is composed. */
    ccPlugins: CcPluginsService
  }
}

/** Constructor options for the plugin-mount registry. */
export interface CcPluginsServiceOptions {
  /**
   * Explicit discovery roots. `undefined` uses installed ∩ enabled; `[]` or
   * `null` disables discovery; a non-empty list flattens those dirs.
   */
  readonly pluginDirs?: readonly string[] | null
  /** Spawn-time model resolver threaded into every mounted agent. */
  readonly resolveModel?: ResolveModel
  /** Claude config home; defaults to `$CLAUDE_CONFIG_DIR` / `~/.claude`. */
  readonly claudeHome?: string
  /** Workspace used for project/local `enabledPlugins`; defaults to `process.cwd()`. */
  readonly cwd?: string
}

/** A tracked plugin mount's public summary. */
export interface CcPluginSummary {
  /** The plugin's manifest name. */
  name: string
  /** The plugin root directory holding `plugin.json`. */
  root: string
  /** Per-component load outcome. */
  components: PluginLoadReport['components']
}

/** One failure (or dispose error) surfaced from a rescan, keyed by plugin root. */
export interface CcPluginRescanError {
  /** The plugin root that failed to mount (or whose mount failed to dispose). */
  root: string
  /** The manifest name, when a mount was disposed and the manifest was known. */
  name?: string
  /** The error message. */
  error: string
}

/** Live per-root mount bookkeeping. */
interface TrackedMount {
  root: string
  name: string
  dispose(): void
  report: PluginLoadReport
}

type MountResult = { ok: true } | { ok: false; error: string }

/**
 * The `ccPlugins` service: enumerate and rescan the mounted Claude Code plugins.
 */
export class CcPluginsService extends Service {
  /** Live mounts keyed by plugin root directory. */
  private readonly mounts = new Map<string, TrackedMount>()

  constructor(
    ctx: Context,
    private readonly options: CcPluginsServiceOptions = {},
  ) {
    super(ctx, 'ccPlugins')
  }

  /** Recompute discovery from the stored options (so rescan re-reads the cascade). */
  private discover(): DiscoveredCcPlugin[] {
    return discoverCcPluginRoots({
      ...this.options.pluginDirs !== undefined ? { pluginDirs: this.options.pluginDirs } : {},
      ...this.options.claudeHome !== undefined ? { claudeHome: this.options.claudeHome } : {},
      ...this.options.cwd !== undefined ? { cwd: this.options.cwd } : {},
      log: this.ctx.logger,
    })
  }

  /** Mount one plugin root and track it; never throws (failures are logged). */
  private async mountOne(plugin: DiscoveredCcPlugin): Promise<MountResult> {
    try {
      const mounted = await mountCcPlugin(this.ctx, {
        root: plugin.root,
        nameHint: plugin.nameHint,
        ...this.options.resolveModel !== undefined ? { resolveModel: this.options.resolveModel } : {},
      })
      this.mounts.set(plugin.root, {
        root: plugin.root,
        name: mounted.report.name,
        dispose: mounted.dispose,
        report: mounted.report,
      })
      return { ok: true }
    } catch (error) {
      const message = String(error)
      this.ctx.logger.warn(`cc-shell-glue: failed to mount CC plugin at ${plugin.root}: ${message}`)
      return { ok: false, error: message }
    }
  }

  /**
   * Discover and mount every configured plugin root. Returns per-plugin
   * failures without halting the remaining roots.
   */
  async mountAll(): Promise<CcPluginRescanError[]> {
    const errors: CcPluginRescanError[] = []
    for (const plugin of this.discover()) {
      const result = await this.mountOne(plugin)
      if (!result.ok) errors.push({ root: plugin.root, error: result.error })
    }
    return errors
  }

  /** Enumerate the currently mounted plugins. */
  list(): CcPluginSummary[] {
    return Array.from(this.mounts.values()).map(mount => ({
      name: mount.name,
      root: mount.root,
      components: mount.report.components,
    }))
  }

  /**
   * Dispose all tracked mounts in reverse mount order, then re-run discovery
   * and mount from the same roots. Individual failures are collected and the
   * remaining plugins still mount.
   */
  async rescan(): Promise<CcPluginRescanError[]> {
    const errors: CcPluginRescanError[] = []
    const tracked = Array.from(this.mounts.values()).reverse()
    this.mounts.clear()
    for (const mount of tracked) {
      try {
        mount.dispose()
      } catch (error) {
        errors.push({ root: mount.root, name: mount.name, error: String(error) })
      }
    }
    for (const plugin of this.discover()) {
      const result = await this.mountOne(plugin)
      if (!result.ok) errors.push({ root: plugin.root, error: result.error })
    }
    return errors
  }
}
