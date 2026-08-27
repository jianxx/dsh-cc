/**
 * Cordis plugin surface for the CC-mode TUI. Heavy wiring lives behind a
 * dynamic import so a boot failure is a plugin error, not a module-load crash.
 * @module @jianxx/dsh-cc-tui
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-cc-tui'
export const inject = ['agents']

export interface Config {
  cwd?: string
  agentPreset?: string
  sessionId?: string
  provider?: string
  model?: string
  allowNoTty?: boolean
  /**
   * Terminal surface mode. 'regular' renders inline into the main screen
   * scrollback; 'fullscreen' takes over the alternate screen on start with a
   * docked layout. Plugin-level default is 'regular' — the
   * cc-tui bundle profile pins 'fullscreen' for fullscreen-on-entry.
   */
  uiMode?: 'regular' | 'fullscreen'
  /**
   * Fullscreen-only: capture the mouse for viewport scrolling and
   * application-owned text selection (OSC 52 copy). Default true.
   */
  mouse?: boolean
}

export const Config: Schema<Config> = Schema.object({
  cwd: Schema.string(),
  agentPreset: Schema.string(),
  sessionId: Schema.string(),
  provider: Schema.string(),
  model: Schema.string(),
  allowNoTty: Schema.boolean(),
  uiMode: Schema.union([Schema.const('regular'), Schema.const('fullscreen')]),
  mouse: Schema.boolean(),
})

/**
 * Effective UI mode. Precedence: the DSH_CCTUI_UI_MODE env beats plugin
 * config, config beats the 'regular' default. The env is the instant escape
 * hatch when a profile pins fullscreen and the terminal cannot cope.
 */
export function resolveUiMode(config: Config): 'regular' | 'fullscreen' {
  const env = process.env.DSH_CCTUI_UI_MODE
  if (env === 'fullscreen' || env === 'regular') return env
  return config.uiMode === 'fullscreen' ? 'fullscreen' : 'regular'
}

/**
 * Mount the terminal surface. Requires a TTY unless `allowNoTty`.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const allowNoTty = config.allowNoTty === true || process.env.DSH_CCTUI_ALLOW_NO_TTY === '1'
  if (!allowNoTty && !process.stdout.isTTY) {
    throw new Error('dsh-cc-tui requires an interactive terminal (stdout must be a TTY).')
  }
  process.env.NODE_ENV ??= 'production'
  const { mountTui } = await import('./plugin.ts')
  await mountTui(ctx, { ...config, uiMode: resolveUiMode(config) })
}
