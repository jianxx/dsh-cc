/**
 * Boot wiring: packaged CC preset, TTY restore, driver, Ink mount.
 * @module @jianxx/dsh-cc-tui/plugin
 */

import { createElement } from 'react'
import { render } from 'ink'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './index.ts'
import { createDriver } from './harness/driver.ts'
import { ensurePackagedPreset } from './packaged-preset.ts'
import { setupGracefulExit } from './terminal.ts'
import { App } from './ui.tsx'

/**
 * Start the TUI inside a dsh process.
 */
export async function mountTui(ctx: Context, config: Config): Promise<void> {
  const packaged = ensurePackagedPreset()
  if (packaged.status === 'conflict') {
    ctx.logger.warn(
      'dsh-cc-tui: ~/.dsh/.agent-presets/cc exists and is not managed by this package; leaving it in place',
    )
  } else if (packaged.status === 'missing-source') {
    ctx.logger.warn(
      'dsh-cc-tui: packaged CC preset files were not found next to the plugin; '
        + 'ensure ~/.dsh/.agent-presets/cc exists (dsh-cc or scripts/sync-cc-preset.sh)',
    )
  }

  const driver = await createDriver(ctx, {
    ...config.cwd === undefined ? {} : { cwd: config.cwd },
    ...config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset },
    ...config.sessionId === undefined || config.sessionId.length === 0
      ? {}
      : { sessionId: config.sessionId },
  })

  const instance = render(createElement(App, { driver }))
  const releaseExit = setupGracefulExit({
    onSignal: () => {
      void driver.dispose()
      instance.unmount()
    },
  })

  // apply() must settle so the Loader fiber activates. Ink holds the process
  // via stdin; teardown is the fiber disposer (and the signal handlers).
  ctx.effect(() => () => {
    releaseExit()
    instance.unmount()
    void driver.dispose()
  })
}
