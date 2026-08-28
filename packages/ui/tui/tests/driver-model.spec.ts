import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDriver } from '@jianxx/dsh-cc-tui/harness/driver.ts'

/**
 * Driver-level contract tests for the /model picker overlay: opening the
 * picker parks modelPicker state with the catalog and focused-on-current,
 * move/submit/cancel behave, the arg path (`/model 2`) is unchanged, and an
 * empty catalog falls back to the status-row notice.
 */

interface FakeModel {
  provider: string
  id: string
  name: string
}

function makeModelCtx(models: FakeModel[]): Record<string, unknown> {
  return {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      if (key === 'llm') {
        return {
          listProviders: () => {
            const seen = new Set<string>()
            const providers: { id: string }[] = []
            for (const m of models) {
              if (!seen.has(m.provider)) {
                seen.add(m.provider)
                providers.push({ id: m.provider })
              }
            }
            return providers
          },
          listModels: async (provider: string) =>
            models.filter(m => m.provider === provider),
        }
      }
      return undefined
    },
    on: () => () => {},
    agents: {
      create: async (opts: unknown) => {
        const agentOpts = (opts as { agentOptions?: Record<string, unknown> })?.agentOptions ?? {}
        return {
          agent: {
            options: agentOpts,
            session: { id: 's-test', header: {}, events: [] },
            id: 'a-test',
            status: 'idle',
            followup() {},
            cancel() {},
          },
          dispose: async () => {},
        }
      },
    },
  }
}

const CATALOG: FakeModel[] = [
  { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
]

describe('createDriver /model picker overlay', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-model-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('opens the picker on /model (no args) with entries and focus on the current model', async () => {
    const driver = await createDriver(makeModelCtx(CATALOG) as never, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    })
    await driver.submit('/model')
    const picker = driver.state.modelPicker
    expect(picker).toBeDefined()
    expect(picker!.entries).toHaveLength(3)
    expect(picker!.entries.map(e => `${e.provider}/${e.id}`)).toEqual([
      'deepseek-official/deepseek-v4-flash',
      'deepseek-official/deepseek-v4-pro',
      'openai/gpt-5',
    ])
    // Current selection sits at index 1.
    expect(picker!.focused).toBe(1)
    expect(picker!.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  })

  it('focuses index 0 when no current model is set', async () => {
    const driver = await createDriver(makeModelCtx(CATALOG) as never, {})
    await driver.submit('/model')
    expect(driver.state.modelPicker?.focused).toBe(0)
    expect(driver.state.modelPicker?.current).toBeUndefined()
  })

  it('move clamps at the bounds (no wrap)', async () => {
    const driver = await createDriver(makeModelCtx(CATALOG) as never, {})
    await driver.submit('/model')
    driver.modelPickerMove(-1) // clamp at top
    expect(driver.state.modelPicker?.focused).toBe(0)
    driver.modelPickerMove(1)
    driver.modelPickerMove(1)
    expect(driver.state.modelPicker?.focused).toBe(2)
    driver.modelPickerMove(1) // clamp at bottom
    expect(driver.state.modelPicker?.focused).toBe(2)
  })

  it('submit sets selection.current, closes the overlay, and emits the status row', async () => {
    const driver = await createDriver(makeModelCtx(CATALOG) as never, {})
    await driver.submit('/model')
    driver.modelPickerMove(1) // focus 'deepseek-v4-pro'
    driver.modelPickerSubmit()
    expect(driver.state.modelPicker).toBeUndefined()
    const last = driver.state.rows.at(-1)
    expect(last?.kind).toBe('status')
    expect((last as { text: string }).text).toBe('Model is now deepseek-official/deepseek-v4-pro.')
  })

  it('cancel closes the overlay without changing the selection', async () => {
    const driver = await createDriver(makeModelCtx(CATALOG) as never, {
      provider: 'openai',
      model: 'gpt-5',
    })
    await driver.submit('/model')
    driver.modelPickerMove(1)
    driver.modelPickerCancel()
    expect(driver.state.modelPicker).toBeUndefined()
    // No "Model is now ..." status row appended on cancel.
    const last = driver.state.rows.at(-1)
    expect((last as { text: string })?.text).not.toMatch(/Model is now/)
  })

  it('/model <n> text path still works (regression — sets selection without opening the overlay)', async () => {
    const driver = await createDriver(makeModelCtx(CATALOG) as never, {})
    await driver.submit('/model 2')
    // No overlay opened on the arg path.
    expect(driver.state.modelPicker).toBeUndefined()
    const last = driver.state.rows.at(-1)
    expect(last?.kind).toBe('status')
    expect((last as { text: string }).text).toBe('Model is now deepseek-official/deepseek-v4-pro.')
  })

  it('/model provider/id text path still works (regression)', async () => {
    const driver = await createDriver(makeModelCtx(CATALOG) as never, {})
    await driver.submit('/model openai/gpt-5')
    expect(driver.state.modelPicker).toBeUndefined()
    const last = driver.state.rows.at(-1)
    expect((last as { text: string }).text).toBe('Model is now openai/gpt-5.')
  })

  it('empty catalog falls back to the status-row notice and opens no overlay', async () => {
    const driver = await createDriver(makeModelCtx([]) as never, {})
    await driver.submit('/model')
    expect(driver.state.modelPicker).toBeUndefined()
    const last = driver.state.rows.at(-1)
    expect(last?.kind).toBe('status')
    expect((last as { text: string }).text).toMatch(/No models are advertised/)
  })

  it('loadModelCatalog exposes the live catalog for argument completion', async () => {
    const driver = await createDriver(makeModelCtx(CATALOG) as never, {})
    const catalog = await driver.loadModelCatalog()
    expect(catalog.map(e => `${e.provider}/${e.id}`)).toEqual([
      'deepseek-official/deepseek-v4-flash',
      'deepseek-official/deepseek-v4-pro',
      'openai/gpt-5',
    ])
  })
})
