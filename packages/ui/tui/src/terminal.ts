/**
 * Terminal-owning-surface hygiene: restore raw mode, mouse, paste, and
 * alternate screen on every exit path. Matches the harness app-boot contract.
 * @module @jianxx/dsh-cc-tui/terminal
 */

const RESET = [
  '\x1b[?1000l',
  '\x1b[?1002l',
  '\x1b[?1003l',
  '\x1b[?1006l',
  '\x1b[?2004l',
  '\x1b[?25h',
].join('')

const EXIT_ALT = '\x1b[?1049l'

/**
 * Write the DEC-mode reset sequence. Synchronous on purpose: `process.on('exit')`
 * cannot await.
 * @param stdout - the owning stream (defaults to process.stdout).
 * @param fullscreen - when true, also leave the alternate screen.
 */
export function resetTerminalModes(
  stdout: NodeJS.WriteStream = process.stdout,
  fullscreen = false,
): void {
  const payload = fullscreen ? RESET + EXIT_ALT : RESET
  try {
    stdout.write(payload)
  } catch {
    // Best-effort: a closed fd must not throw out of an exit handler.
  }
}

/**
 * Install signal and `exit` handlers that restore the terminal. Returns a
 * disposer that removes the handlers (does not itself reset).
 * @param options.fullscreen - leave the alternate screen on teardown.
 * @param options.onSignal - extra work before exit (dispose agent, unmount Ink).
 */
export function setupGracefulExit(options: {
  fullscreen?: boolean
  onSignal?: (signal: NodeJS.Signals) => void
} = {}): () => void {
  const fullscreen = options.fullscreen === true
  const onExit = (): void => {
    resetTerminalModes(process.stdout, fullscreen)
  }
  const onSignal = (signal: NodeJS.Signals): void => {
    try {
      options.onSignal?.(signal)
    } finally {
      resetTerminalModes(process.stdout, fullscreen)
    }
  }
  process.on('exit', onExit)
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  return () => {
    process.off('exit', onExit)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}
