/**
 * Standalone helpers extracted from the root mount: OS URL opening and
 * active-task text capping. Deliberately a leaf — must not import root.ts.
 * @module @jianxx/dsh-cc-tui/components/root-utils
 */

import { spawn } from 'node:child_process'

/** Cap the active-task text shown in the todo strip (ellipsis past the cap). */
const TODO_ACTIVE_CAP = 60

export function truncateActive(content: string): string {
	return content.length > TODO_ACTIVE_CAP ? `${content.slice(0, TODO_ACTIVE_CAP - 1)}…` : content
}

/**
 * Open an OSC 8 hyperlink with the OS handler. Fullscreen mouse capture takes
 * over the terminal's native link activation, so clicks are routed here.
 */
export function openSystemUrl(url: string): void {
	const child = process.platform === 'win32'
		? spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', detached: true })
		: spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true })
	child.on('error', () => {})
	child.unref()
}
