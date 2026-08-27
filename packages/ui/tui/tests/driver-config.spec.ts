import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDriver } from '@jianxx/dsh-cc-tui/harness/driver.ts'

/**
 * Minimal ctx stub: only the surface `createDriver` touches at boot. Optional
 * seams (tools, userQuestions, llm, commands, …) stay absent so their branches
 * degrade without extra wiring. `agents.create`/`resume` are spies that
 * capture the options and return a no-op handle.
 */
function makeCtx(capture: { create?: unknown; resume?: unknown }): Record<string, unknown> {
  return {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      return undefined
    },
    on: () => () => {},
    agents: {
      create: async (opts: unknown) => {
        capture.create = opts
        return {
          agent: {
            options: {},
            session: { id: 's-test', header: {}, events: [] },
            id: 'a-test',
            followup() {},
            cancel() {},
          },
          dispose: async () => {},
        }
      },
      resume: async (opts: unknown) => {
        capture.resume = opts
        return {
          agent: {
            options: {},
            session: { id: 's-test', header: {}, events: [] },
            id: 'a-test',
            followup() {},
            cancel() {},
          },
          dispose: async () => {},
        }
      },
    },
  }
}

describe('createDriver agentOptions passthrough', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-cfg-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('forwards provider+model as agentOptions on a fresh create', async () => {
    const capture: { create?: { agentOptions?: unknown } } = {}
    await createDriver(makeCtx(capture) as never, {
      provider: 'mock',
      model: 'e2e-1',
    })
    expect(capture.create?.agentOptions).toEqual({ provider: 'mock', model: 'e2e-1' })
  })

  it('omits agentOptions when provider/model are unset', async () => {
    const capture: { create?: { agentOptions?: unknown } } = {}
    await createDriver(makeCtx(capture) as never, {})
    expect(capture.create?.agentOptions).toBeUndefined()
  })

  it('forwards provider+model on a resume (sessionId set)', async () => {
    const capture: { resume?: { agentOptions?: unknown } } = {}
    await createDriver(makeCtx(capture) as never, {
      sessionId: 'prior-session',
      provider: 'mock',
      model: 'e2e-1',
    })
    expect(capture.resume?.agentOptions).toEqual({ provider: 'mock', model: 'e2e-1' })
  })

  it('does not forward when only one of provider/model is set', async () => {
    const capture: { create?: { agentOptions?: unknown } } = {}
    await createDriver(makeCtx(capture) as never, { provider: 'mock' })
    expect(capture.create?.agentOptions).toBeUndefined()
  })
})
