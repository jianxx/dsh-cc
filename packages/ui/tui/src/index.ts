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
}

export const Config: Schema<Config> = Schema.object({
  cwd: Schema.string(),
  agentPreset: Schema.string(),
  sessionId: Schema.string(),
  provider: Schema.string(),
  model: Schema.string(),
  allowNoTty: Schema.boolean(),
})

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
  await mountTui(ctx, config)
}
