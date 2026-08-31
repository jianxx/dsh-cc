/**
 * Realm-boundary gate: plan-mode owns plan state inside the cc preset's
 * entry-local isolate realm, so `ctx.get('planMode')` resolves undefined for
 * every context outside that subtree — the root cause of the Shift+Tab
 * "plan mode is not mounted in this composition" bug. Switching goes through
 * the `/plan` command channel only (docs/plan-mode-command-channel.md).
 * This gate fails the suite if any dsh-cc surface reaches for the service
 * directly again.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const SCAN_DIRS = [
  'packages/ui/tui/src',
  'packages/interaction/command-permissions/src',
]
const NEEDLE = "get('planMode')"

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) yield path
  }
}

describe('plan command-channel boundary', () => {
  it("no dsh-cc surface reads ctx.get('planMode')", () => {
    const offenders: string[] = []
    for (const dir of SCAN_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
          if (line.includes(NEEDLE)) offenders.push(`${relative(ROOT, file)}:${index + 1}`)
        })
      }
    }
    expect(offenders).toEqual([])
  })
})
