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

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { mountCcPlugin, type PluginLoadReport, type ResolveModel } from '@jianxx/dsh-cc-plugin-loader'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The mounted Claude Code plugin registry, when cc-shell-glue is composed. */
    ccPlugins: CcPluginsService
  }
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
    private readonly pluginDirs: readonly string[],
    private readonly resolveModel?: ResolveModel,
  ) {
    super(ctx, 'ccPlugins')
  }

  /** The discovered plugin roots for every configured discovery root. */
  private discover(): string[] {
    const roots: string[] = []
    for (const root of this.pluginDirs) {
      if (!existsSync(root)) continue
      if (existsSync(join(root, 'plugin.json'))) {
        roots.push(root)
        continue
      }
      try {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (entry.isDirectory() && existsSync(join(root, entry.name, 'plugin.json'))) {
            roots.push(join(root, entry.name))
          }
        }
      } catch {
        // Best-effort discovery: an unreadable discovery root mounts nothing.
      }
    }
    return roots
  }

  /** Mount one plugin root and track it; never throws (failures are logged). */
  private async mountOne(dir: string): Promise<MountResult> {
    try {
      const mounted = await mountCcPlugin(this.ctx, {
        root: dir,
        ...this.resolveModel !== undefined ? { resolveModel: this.resolveModel } : {},
      })
      this.mounts.set(dir, {
        root: dir,
        name: mounted.report.name,
        dispose: mounted.dispose,
        report: mounted.report,
      })
      return { ok: true }
    } catch (error) {
      const message = String(error)
      this.ctx.logger.warn(`cc-shell-glue: failed to mount CC plugin at ${dir}: ${message}`)
      return { ok: false, error: message }
    }
  }

  /**
   * Discover and mount every configured plugin root. Returns per-plugin
   * failures without halting the remaining roots.
   */
  async mountAll(): Promise<CcPluginRescanError[]> {
    const errors: CcPluginRescanError[] = []
    for (const dir of this.discover()) {
      const result = await this.mountOne(dir)
      if (!result.ok) errors.push({ root: dir, error: result.error })
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
    for (const dir of this.discover()) {
      const result = await this.mountOne(dir)
      if (!result.ok) errors.push({ root: dir, error: result.error })
    }
    return errors
  }
}
