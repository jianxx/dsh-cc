import { describe, expect, it } from 'vitest'
import {
  PRESETS,
  deriveCredentialRef,
  presetByRoute,
  type ProviderPreset,
} from '../src/provider-presets.ts'

const CURATED_GLM_IDS = [
  'glm-5.3',
  'glm-5v-turbo',
  'glm-5.2',
  'glm-5.1',
  'glm-5-turbo',
  'glm-4.7',
  'glm-4.5-air',
]

const CUSTOM_ROUTES = ['zai-api', 'zhipu-api']

const CATALOG_PROBES: Record<string, { baseURL: string; api: string }> = {
  moonshotai: { baseURL: 'https://api.moonshot.ai/v1', api: 'openai-completions' },
  'moonshotai-cn': { baseURL: 'https://api.moonshot.cn/v1', api: 'openai-completions' },
  zai: { baseURL: 'https://api.z.ai/api/coding/paas/v4', api: 'openai-completions' },
  'zai-coding-cn': { baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', api: 'openai-completions' },
  deepseek: { baseURL: 'https://api.deepseek.com', api: 'openai-completions' },
}

describe('provider presets', () => {
  it('contains exactly the 8 v1 presets', () => {
    expect(PRESETS.map((p) => p.route)).toEqual([
      'kimi-coding',
      'moonshotai',
      'moonshotai-cn',
      'zai',
      'zai-coding-cn',
      'deepseek',
      'zai-api',
      'zhipu-api',
    ])
  })

  it('uses route-key grammar ^[a-z0-9][a-z0-9-]*$ for every route', () => {
    for (const p of PRESETS) expect(p.route).toMatch(/^[a-z0-9][a-z0-9-]*$/)
  })

  it('uses POSIX-identifier-shaped credential refs', () => {
    for (const p of PRESETS) expect(p.credentialRef).toMatch(/^[A-Z_][A-Z0-9_]*$/)
  })

  it('has absolute https docsUrl for every preset', () => {
    for (const p of PRESETS) {
      expect(() => new URL(p.docsUrl)).not.toThrow()
      expect(new URL(p.docsUrl).protocol).toBe('https:')
    }
  })

  it('groups presets into kimi | zhipu-zai | deepseek', () => {
    for (const p of PRESETS) expect(['kimi', 'zhipu-zai', 'deepseek']).toContain(p.group)
  })

  it('gives catalog presets a minimal empty profile', () => {
    for (const p of PRESETS) {
      if (!CUSTOM_ROUTES.includes(p.route)) expect(p.profile).toEqual({})
    }
  })

  it('carries the curated 7-id GLM list on both custom presets', () => {
    for (const route of CUSTOM_ROUTES) {
      const p = presetByRoute(route)!
      expect(p.profile.api).toBe('openai-completions')
      expect(p.profile.models!.map((m: { id: string }) => m.id)).toEqual(CURATED_GLM_IDS)
      for (const m of p.profile.models!) {
        expect(m.name).toBe(m.id.toUpperCase())
      }
    }
    expect(presetByRoute('zai-api')!.profile.baseURL).toBe('https://api.z.ai/api/paas/v4')
    expect(presetByRoute('zhipu-api')!.profile.baseURL).toBe('https://open.bigmodel.cn/api/paas/v4')
  })

  it('probe: null only for kimi-coding (anthropic-messages is not listable)', () => {
    for (const p of PRESETS) {
      if (p.route === 'kimi-coding') expect(p.probe).toBeNull()
      else expect(p.probe).not.toBeNull()
    }
  })

  it('custom presets probe against their own profile endpoints', () => {
    for (const route of CUSTOM_ROUTES) {
      const p = presetByRoute(route)!
      expect(p.probe).toEqual({ baseURL: p.profile.baseURL, api: p.profile.api })
    }
  })

  it('catalog presets probe against the verified C7 catalog endpoints', () => {
    for (const [route, probe] of Object.entries(CATALOG_PROBES)) {
      expect(presetByRoute(route)!.probe).toEqual(probe)
    }
  })

  it('presetByRoute resolves exact routes and returns undefined otherwise', () => {
    expect(presetByRoute('deepseek')!.route).toBe('deepseek')
    expect(presetByRoute('nope')).toBeUndefined()
  })

  it('deriveCredentialRef maps route ids to DSH_PROVIDER_*_API_KEY', () => {
    expect(deriveCredentialRef('my-gw')).toBe('DSH_PROVIDER_MY_GW_API_KEY')
    expect(deriveCredentialRef('gw2')).toBe('DSH_PROVIDER_GW2_API_KEY')
    expect(deriveCredentialRef('my..weird--gw')).toBe('DSH_PROVIDER_MY_WEIRD_GW_API_KEY')
  })

  it('types check: presets satisfy ProviderPreset', () => {
    const typed: ProviderPreset[] = PRESETS
    expect(typed.length).toBe(8)
  })
})
