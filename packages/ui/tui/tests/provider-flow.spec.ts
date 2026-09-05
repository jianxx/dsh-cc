import { describe, expect, it } from 'vitest'
import {
  buildProviderRows,
  materializeCustomProfile,
  materializeProfile,
  normalizeRouteId,
  parseModelList,
  routeCollision,
  verifyProbeFor,
  type CredentialState,
  type DirectoryEntry,
} from '../src/provider-flow.ts'
import { PRESETS, presetByRoute } from '../src/provider-presets.ts'

const DIRECTORY: DirectoryEntry[] = [
  { provider: 'github-copilot', displayName: 'GitHub Copilot' },
  { provider: 'openrouter', displayName: 'OpenRouter' },
  { provider: 'deepseek', displayName: 'DeepSeek (directory)' }, // configured → dropped
  { provider: 'moonshotai', displayName: 'Moonshot (directory)' }, // preset-covered → dropped
]

const ALL_MANAGED: Record<string, CredentialState> = Object.fromEntries(
  PRESETS.map((p) => [p.credentialRef, { configured: true, source: 'managed', writable: true }]),
)

function state(partial: Record<string, CredentialState> = {}, configured: Record<string, unknown> = {}) {
  const refs = new Set<string>()
  for (const route of Object.keys(configured)) {
    const preset = presetByRoute(route)
    refs.add(preset ? preset.credentialRef : `DSH_PROVIDER_${route.toUpperCase()}_API_KEY`)
  }
  for (const ref of Object.keys(partial)) refs.add(ref)
  const credentialStates: Record<string, CredentialState> = {}
  for (const ref of refs) credentialStates[ref] = partial[ref] ?? { configured: true, source: 'managed', writable: true }
  return { credentialStates, configured }
}

describe('buildProviderRows — §4.2 merge rule', () => {
  it('configured section follows the configured dict verbatim in document order', () => {
    const { configured } = state({}, { deepseek: {}, 'kimi-coding': { models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } })
    const rows = buildProviderRows({
      configured,
      directory: DIRECTORY,
      presets: PRESETS,
      credentialStates: ALL_MANAGED,
      currentProvider: 'deepseek',
    })
    expect(rows.configured.map((r) => r.route)).toEqual(['deepseek', 'kimi-coding'])
    expect(rows.configured[0].isCurrent).toBe(true)
    expect(rows.configured[1].isCurrent).toBe(false)
    expect(rows.configured[1].modelCount).toBe(3)
  })

  it('configured route also in directory never appears in Available / More', () => {
    const { configured, credentialStates } = state({}, { deepseek: {} })
    const rows = buildProviderRows({ configured, directory: DIRECTORY, presets: PRESETS, credentialStates })
    expect(rows.available.some((r) => r.route === 'deepseek')).toBe(false)
    expect(rows.more.some((r) => r.provider === 'deepseek')).toBe(false)
    // moonshotai preset exists but is not configured → still in Available
    expect(rows.available.some((r) => r.route === 'moonshotai')).toBe(true)
  })

  it('available presets exclude configured routes and keep preset display order', () => {
    const { configured, credentialStates } = state({}, { moonshotai: {} })
    const rows = buildProviderRows({ configured, directory: [], presets: PRESETS, credentialStates })
    expect(rows.available.map((r) => r.route)).toEqual(PRESETS.filter((p) => p.route !== 'moonshotai').map((p) => p.route))
  })

  it('directory-only entries collapse into the More tail, dropping configured + preset-covered routes', () => {
    const { configured, credentialStates } = state({}, { deepseek: {} })
    const rows = buildProviderRows({ configured, directory: DIRECTORY, presets: PRESETS, credentialStates })
    expect(rows.more.map((r) => r.provider)).toEqual(['github-copilot', 'openrouter'])
  })

  it('badge matrix: managed / env / missing with warning when models exist but key missing', () => {
    const configured = {
      deepseek: { models: [{ id: 'a' }, { id: 'b' }] },
      moonshotai: { models: [{ id: 'a' }] },
      'kimi-coding': {},
    }
    const credentialStates: Record<string, CredentialState> = {
      DEEPSEEK_API_KEY: { configured: true, source: 'env', writable: false },
      MOONSHOT_API_KEY: { configured: false },
      KIMI_API_KEY: { configured: true, source: 'managed', writable: true },
    }
    const rows = buildProviderRows({ configured, directory: [], presets: PRESETS, credentialStates })
    const byRoute = Object.fromEntries(rows.configured.map((r) => [r.route, r]))
    expect(byRoute.deepseek.credential).toMatchObject({ badge: 'env', writable: false, warning: false })
    expect(byRoute.moonshotai.credential).toMatchObject({ badge: 'missing', warning: true })
    expect(byRoute['kimi-coding'].credential).toMatchObject({ badge: 'managed', warning: false })
    // models present + key missing → ⚠; kimi-coding has no models → no warning even with key ok
    expect(byRoute['kimi-coding'].modelCount).toBe(0)
  })

  it('uses the derived credential ref for non-preset (custom) configured routes', () => {
    const configured = { 'my-gateway': { models: [{ id: 'a' }] } }
    const credentialStates: Record<string, CredentialState> = {
      DSH_PROVIDER_MY_GATEWAY_API_KEY: { configured: true, source: 'managed', writable: true },
    }
    const rows = buildProviderRows({ configured, directory: [], presets: PRESETS, credentialStates })
    expect(rows.configured[0].credential).toMatchObject({ badge: 'managed' })
  })

  it('custom route shows displayName from the preset table only when preset-backed', () => {
    const configured = { 'my-gateway': {} }
    const rows = buildProviderRows({ configured, directory: [], presets: PRESETS, credentialStates: {} })
    expect(rows.configured[0].displayName).toBe('my-gateway')
  })
})

describe('normalizeRouteId', () => {
  const table: [string, string | null][] = [
    ['My Gateway', 'my-gateway'],
    ['  Foo_Bar  ', 'foo-bar'],
    ['UPPER--case', 'upper-case'],
    ['9lives', '9lives'],
    ['-lead-', 'lead'],
    ['!!!', null],
    ['', null],
    ['   ', null],
    ['a', 'a'],
  ]
  for (const [input, expected] of table) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(normalizeRouteId(input)).toBe(expected)
    })
  }
})

describe('routeCollision', () => {
  const configured = { deepseek: {} }
  it('configured wins', () => {
    expect(routeCollision('deepseek', { configured, presets: PRESETS, directory: DIRECTORY })).toBe('configured')
  })
  it('preset', () => {
    expect(routeCollision('zai-api', { configured, presets: PRESETS, directory: DIRECTORY })).toBe('preset')
  })
  it('directory', () => {
    expect(routeCollision('openrouter', { configured, presets: PRESETS, directory: DIRECTORY })).toBe('directory')
  })
  it('null when free', () => {
    expect(routeCollision('my-gateway', { configured, presets: PRESETS, directory: DIRECTORY })).toBeNull()
  })
})

describe('materializeProfile', () => {
  it('catalog-complete presets write an empty payload', () => {
    expect(materializeProfile(presetByRoute('deepseek')!)).toEqual({})
  })
  it('deviating presets carry exactly their deltas, deep-copied', () => {
    const profile = materializeProfile(presetByRoute('zai-api')!)
    expect(profile).toEqual(presetByRoute('zai-api')!.profile)
    expect(profile).not.toBe(presetByRoute('zai-api')!.profile)
    expect(profile.models![0]).not.toBe(presetByRoute('zai-api')!.profile.models![0])
  })
  it('custom profiles carry api/baseURL/models', () => {
    expect(
      materializeCustomProfile({
        routeId: 'my-gateway',
        displayName: 'My Gateway',
        baseURL: 'https://gw.example.com/v1',
        api: 'openai-completions',
        models: [{ id: 'm1', name: 'Model One', contextWindow: 128000 }],
      }),
    ).toEqual({
      api: 'openai-completions',
      baseURL: 'https://gw.example.com/v1',
      models: [{ id: 'm1', name: 'Model One', contextWindow: 128000 }],
    })
  })
  it('rejects non-absolute or non-http(s) baseURL', () => {
    expect(() => materializeCustomProfile({ routeId: 'x', displayName: 'X', baseURL: 'ftp://x', api: 'openai-completions' })).toThrow()
    expect(() => materializeCustomProfile({ routeId: 'x', displayName: 'X', baseURL: 'not a url', api: 'openai-completions' })).toThrow()
    expect(() => materializeCustomProfile({ routeId: 'x', displayName: 'X', baseURL: '', api: 'openai-completions' })).toThrow()
  })
})

describe('parseModelList', () => {
  it('happy: newline and comma separators, all field arities', () => {
    const { models, errors } = parseModelList('m1, m2 | Model Two\nm3 | M3 | 262144 | 32768\n')
    expect(errors).toEqual([])
    expect(models).toEqual([
      { id: 'm1' },
      { id: 'm2', name: 'Model Two' },
      { id: 'm3', name: 'M3', contextWindow: 262144, maxTokens: 32768 },
    ])
  })
  it('errors: blank id, whitespace in id, bad numbers, too many fields', () => {
    const { errors } = parseModelList('\n  |Named\nbad id|X\nm1|X|abc\nm2|X|1|2|3')
    expect(errors).toHaveLength(4)
    expect(errors[0]).toContain('empty')
    expect(errors[1]).toContain('whitespace')
    expect(errors[2]).toContain('contextWindow')
    expect(errors[3]).toContain('fields')
  })
  it('empty input yields no models and no errors', () => {
    expect(parseModelList('')).toEqual({ models: [], errors: [] })
    expect(parseModelList(' , \n ').models).toEqual([])
  })
})

describe('verifyProbeFor — §4.3 step 2 (C5 draft form)', () => {
  it('null for anthropic-messages (not listable)', () => {
    expect(verifyProbeFor(presetByRoute('kimi-coding')!)).toBeNull()
  })
  it('draft form for listable presets: baseURL + api, never provider', () => {
    const probe = verifyProbeFor(presetByRoute('moonshotai')!)
    expect(probe).toEqual({ baseURL: 'https://api.moonshot.ai/v1', api: 'openai-completions' })
    expect(probe).not.toHaveProperty('provider')
    expect(Object.keys(probe!).sort()).toEqual(['api', 'baseURL'])
  })
  it('accepts wizard answers, carries an optional apiKey, drops provider input', () => {
    expect(
      verifyProbeFor({ baseURL: 'https://gw.example.com/v1', api: 'openai-responses', apiKey: 'sk-123', provider: 'openrouter' }),
    ).toEqual({ baseURL: 'https://gw.example.com/v1', api: 'openai-responses', apiKey: 'sk-123' })
  })
  it('null when baseURL unknown', () => {
    expect(verifyProbeFor({ api: 'openai-completions' })).toBeNull()
    expect(verifyProbeFor({ baseURL: 'https://x', api: 'anthropic-messages' })).toBeNull()
  })
})
