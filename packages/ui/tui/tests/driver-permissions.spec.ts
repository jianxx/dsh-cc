import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PERMISSION_MODE_OPTIONS } from '@jianxx/dsh-cc-command-permissions'
import { createDriver } from '@jianxx/dsh-cc-tui/harness/driver.ts'

/**
 * Driver-level contract tests for the TUI `/permissions` picker: bare
 * invocation opens the overlay (does not execute the host command), argued
 * `/permissions <mode>` stays scriptable through `commands.execute`, submit
 * closes then writes `/permissions ${id}` through the host command, and
 * bypassPermissions requires an in-overlay confirmation first.
 */

interface ExecuteCall {
  line: string
}

function makeCtx(opts: {
  execute?: (line: string) => Promise<{ result?: { kind: string; text?: string } } | undefined>
  events?: unknown[]
} = {}): {
  ctx: Record<string, unknown>
  executed: ExecuteCall[]
} {
  const executed: ExecuteCall[] = []
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      if (key === 'commands') {
        return {
          list: () => [
            { name: 'permissions', description: 'show or switch the permission mode', input: { hint: '[mode]' } },
          ],
          execute: async (_agent: unknown, line: string) => {
            executed.push({ line })
            if (opts.execute !== undefined) return opts.execute(line)
            if (line === '/permissions') {
              return { result: { kind: 'success', text: 'Permission rules (read-only)' } }
            }
            const match = /^\/permissions\s+(\S+)$/.exec(line)
            if (match !== null) {
              return { result: { kind: 'success', text: `Permission mode is now "${match[1]}".` } }
            }
            return { result: { kind: 'error', text: 'unknown command' } }
          },
        }
      }
      return undefined
    },
    on: () => () => {},
    agents: {
      create: async () => ({
        agent: {
          options: {},
          session: { id: 's-perm', header: {}, events: opts.events ?? [] },
          id: 'a-perm',
          status: 'idle',
          followup() {},
          cancel() {},
        },
        dispose: async () => {},
      }),
    },
  }
  return { ctx, executed }
}

function statusTexts(driver: { state: { rows: readonly { kind: string; text?: string }[] } }): string[] {
  return driver.state.rows.filter(row => row.kind === 'status').map(row => row.text ?? '')
}

describe('createDriver /permissions picker overlay', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-perm-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('bare /permissions opens the picker and does not execute the host command', async () => {
    const { ctx, executed } = makeCtx()
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/permissions')
    const picker = driver.state.permissionPicker
    expect(picker).toBeDefined()
    expect(picker!.entries.map(entry => entry.id)).toEqual(PERMISSION_MODE_OPTIONS.map(option => option.id))
    expect(picker!.current).toBe('default')
    expect(picker!.focused).toBe(0)
    expect(picker!.confirmingBypass).toBeUndefined()
    expect(executed).toEqual([])
    expect(statusTexts(driver).some(text => text.includes('Permission rules'))).toBe(false)
  })

  it('bare /PERMISSIONS (case-insensitive) also opens the picker', async () => {
    const { ctx, executed } = makeCtx()
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/PERMISSIONS')
    expect(driver.state.permissionPicker).toBeDefined()
    expect(executed).toEqual([])
  })

  it('opens focused on the live permission mode', async () => {
    const { ctx } = makeCtx({
      events: [{ type: 'permission/mode', data: { mode: 'auto' } }],
    })
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/permissions')
    const picker = driver.state.permissionPicker
    expect(picker?.current).toBe('auto')
    expect(picker?.focused).toBe(PERMISSION_MODE_OPTIONS.findIndex(option => option.id === 'auto'))
  })

  it('/permissions <mode> bypasses the overlay and executes the host command', async () => {
    const { ctx, executed } = makeCtx()
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/permissions acceptEdits')
    expect(driver.state.permissionPicker).toBeUndefined()
    expect(executed).toEqual([{ line: '/permissions acceptEdits' }])
    expect(statusTexts(driver).at(-1)).toBe('Permission mode is now "acceptEdits".')
  })

  it('move clamps at the bounds (no wrap)', async () => {
    const { ctx } = makeCtx()
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/permissions')
    driver.permissionPickerMove(-1)
    expect(driver.state.permissionPicker?.focused).toBe(0)
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    expect(driver.state.permissionPicker?.focused).toBe(4)
    driver.permissionPickerMove(1)
    expect(driver.state.permissionPicker?.focused).toBe(4)
  })

  it('submit closes synchronously, then executes /permissions ${id} through the host command', async () => {
    const { ctx, executed } = makeCtx()
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/permissions')
    driver.permissionPickerMove(1) // acceptEdits
    const pending = driver.permissionPickerSubmit()
    // Overlay is gone before the host-command write settles.
    expect(driver.state.permissionPicker).toBeUndefined()
    await pending
    expect(executed).toEqual([{ line: '/permissions acceptEdits' }])
    expect(statusTexts(driver).at(-1)).toBe('Permission mode is now "acceptEdits".')
  })

  it('cancel closes the overlay without executing', async () => {
    const { ctx, executed } = makeCtx()
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/permissions')
    driver.permissionPickerMove(1)
    driver.permissionPickerCancel()
    expect(driver.state.permissionPicker).toBeUndefined()
    expect(executed).toEqual([])
  })

  it('bypassPermissions requires a confirmation enter before executing', async () => {
    const { ctx, executed } = makeCtx()
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/permissions')
    // default → acceptEdits → plan → auto → bypassPermissions
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    expect(driver.state.permissionPicker?.entries[driver.state.permissionPicker.focused]?.id).toBe('bypassPermissions')

    await driver.permissionPickerSubmit()
    expect(driver.state.permissionPicker?.confirmingBypass).toBe(true)
    expect(executed).toEqual([])

    const pending = driver.permissionPickerSubmit()
    expect(driver.state.permissionPicker).toBeUndefined()
    await pending
    expect(executed).toEqual([{ line: '/permissions bypassPermissions' }])
    expect(statusTexts(driver).at(-1)).toBe('Permission mode is now "bypassPermissions".')
  })

  it('escape while confirming bypass returns to the list without executing', async () => {
    const { ctx, executed } = makeCtx()
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/permissions')
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    await driver.permissionPickerSubmit()
    expect(driver.state.permissionPicker?.confirmingBypass).toBe(true)

    driver.permissionPickerCancel()
    expect(driver.state.permissionPicker).toBeDefined()
    expect(driver.state.permissionPicker?.confirmingBypass).toBeUndefined()
    expect(driver.state.permissionPicker?.focused).toBe(4)
    expect(executed).toEqual([])
  })

  it('moving while confirming bypass clears the confirmation flag', async () => {
    const { ctx } = makeCtx()
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/permissions')
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    await driver.permissionPickerSubmit()
    expect(driver.state.permissionPicker?.confirmingBypass).toBe(true)

    driver.permissionPickerMove(-1)
    expect(driver.state.permissionPicker?.confirmingBypass).toBeUndefined()
    expect(driver.state.permissionPicker?.focused).toBe(3)
  })

  it('surfaces the host command error when execute fails after submit', async () => {
    const { ctx } = makeCtx({
      execute: async () => ({ result: { kind: 'error', text: 'The permission-rules engine is not mounted in this composition.' } }),
    })
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/permissions')
    driver.permissionPickerMove(1)
    await driver.permissionPickerSubmit()
    expect(statusTexts(driver).at(-1)).toBe('The permission-rules engine is not mounted in this composition.')
  })
})
