/**
 * Mount a Claude Code plugin's settings.
 *
 * Filters the manifest `settings` record to the allowlisted keys (mirroring
 * Claude Code's keep-list) and writes them through the optional `settings`
 * guest seam under a plugin-scoped namespace. When the seam is absent the
 * component is reported skipped, never failed.
 *
 * @module
 */

import type { CcPluginManifest } from './types.ts'
import { ComponentTally } from './seams.ts'

/** Settings keys Claude Code keeps when merging a plugin's settings. */
export const SETTINGS_ALLOWLIST = ['agent'] as const

/** The settings seam: writes one plugin-scoped namespace of values. */
export interface SettingsSeam {
  /**
   * Write a plugin's allowlisted settings.
   * @param name - the plugin-scoped namespace.
   * @param value - the allowlisted settings to merge.
   * @returns the exact disposer that removes the written section.
   */
  set(name: string, value: Record<string, unknown>): () => void
}

/** Options for mounting one plugin's settings. */
export interface MountSettingsOptions {
  /** The parsed manifest, whose `settings` record is written. */
  readonly manifest: CcPluginManifest
  /** The settings seam (probed; `undefined` to skip settings). */
  readonly settings: SettingsSeam | undefined
}

/**
 * Filter and write a plugin's settings through the optional seam.
 * @param options - manifest and the settings seam.
 * @returns mounted disposers and per-component counts.
 */
export function mountSettings(options: MountSettingsOptions): { disposers: (() => void)[]; tally: ComponentTally } {
  const tally = new ComponentTally('settings')
  const disposers: (() => void)[] = []
  if (options.settings === undefined) {
    tally.addSkipped('settings seam "settings" is not mounted')
    return { disposers, tally }
  }
  const allowed = allowlist(options.manifest.settings)
  if (Object.keys(allowed).length === 0) {
    tally.addSkipped('plugin declares no allowlisted settings')
    return { disposers, tally }
  }
  disposers.push(options.settings.set(options.manifest.name, allowed))
  tally.addLoaded()
  return { disposers, tally }
}

/** Keep only the allowlisted keys from a settings section. */
function allowlist(settings: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of SETTINGS_ALLOWLIST) {
    if (settings[key] !== undefined) result[key] = settings[key]
  }
  return result
}
