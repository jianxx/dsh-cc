/** Built-in `/provider` presets — pure data (design doc §4.5, docs/plans/2026-09-05-provider-management.md). */

export type PresetGroup = 'kimi' | 'zhipu-zai' | 'deepseek'

export interface CuratedModel {
  id: string
  name: string
}

export interface ProviderPreset {
  /** Settings dict key under `llm-pi-ai.providers.<route>`. */
  route: string
  displayName: string
  group: PresetGroup
  /** Credential store ref for the preset's API key. */
  credentialRef: string
  /** Public vendor docs URL. */
  docsUrl: string
  /** Minimal profile payload written into `llm-pi-ai.providers.<route>` (empty = catalog-complete, C7). */
  profile: {
    api?: string
    baseURL?: string
    models?: CuratedModel[]
  }
  /** Draft-form discovery probe endpoint (C5); null when the protocol is not listable. */
  probe: { baseURL: string; api: string } | null
}

/** Curated GLM list (§4.5), seeded from ids proven against these very endpoints. */
const GLM_MODELS: CuratedModel[] = [
  { id: 'glm-5.3', name: 'GLM-5.3' },
  { id: 'glm-5v-turbo', name: 'GLM-5V-TURBO' },
  { id: 'glm-5.2', name: 'GLM-5.2' },
  { id: 'glm-5.1', name: 'GLM-5.1' },
  { id: 'glm-5-turbo', name: 'GLM-5-TURBO' },
  { id: 'glm-4.7', name: 'GLM-4.7' },
  { id: 'glm-4.5-air', name: 'GLM-4.5-AIR' },
]

export const PRESETS: ProviderPreset[] = [
  {
    route: 'kimi-coding',
    displayName: 'Kimi Coding Plan',
    group: 'kimi',
    credentialRef: 'KIMI_API_KEY',
    docsUrl: 'https://platform.moonshot.ai/docs/guide/kimi-coding',
    profile: {},
    probe: null, // anthropic-messages is not listable (§2/C5)
  },
  {
    route: 'moonshotai',
    displayName: 'Kimi API (global)',
    group: 'kimi',
    credentialRef: 'MOONSHOT_API_KEY',
    docsUrl: 'https://platform.moonshot.ai/docs',
    profile: {},
    probe: { baseURL: 'https://api.moonshot.ai/v1', api: 'openai-completions' },
  },
  {
    route: 'moonshotai-cn',
    displayName: 'Kimi API (CN)',
    group: 'kimi',
    credentialRef: 'MOONSHOT_API_KEY',
    docsUrl: 'https://platform.moonshot.cn/docs',
    profile: {},
    probe: { baseURL: 'https://api.moonshot.cn/v1', api: 'openai-completions' },
  },
  {
    route: 'zai',
    displayName: 'Z.AI Coding Plan (global)',
    group: 'zhipu-zai',
    credentialRef: 'ZAI_API_KEY',
    docsUrl: 'https://docs.z.ai/',
    profile: {},
    probe: { baseURL: 'https://api.z.ai/api/coding/paas/v4', api: 'openai-completions' },
  },
  {
    route: 'zai-coding-cn',
    displayName: 'Zhipu Coding Plan (CN)',
    group: 'zhipu-zai',
    credentialRef: 'ZAI_CODING_CN_API_KEY',
    docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan',
    profile: {},
    probe: { baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', api: 'openai-completions' },
  },
  {
    route: 'deepseek',
    displayName: 'DeepSeek API',
    group: 'deepseek',
    credentialRef: 'DEEPSEEK_API_KEY',
    docsUrl: 'https://api-docs.deepseek.com/',
    profile: {},
    probe: { baseURL: 'https://api.deepseek.com', api: 'openai-completions' },
  },
  {
    route: 'zai-api',
    displayName: 'Z.AI API (global, pay-as-you-go)',
    group: 'zhipu-zai',
    credentialRef: 'ZAI_API_KEY',
    docsUrl: 'https://docs.z.ai/guides/overview/pricing',
    profile: {
      api: 'openai-completions',
      baseURL: 'https://api.z.ai/api/paas/v4',
      models: GLM_MODELS,
    },
    probe: { baseURL: 'https://api.z.ai/api/paas/v4', api: 'openai-completions' },
  },
  {
    route: 'zhipu-api',
    displayName: 'Zhipu API (CN, pay-as-you-go)',
    group: 'zhipu-zai',
    credentialRef: 'ZHIPU_API_KEY',
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/start/pricing',
    profile: {
      api: 'openai-completions',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      models: GLM_MODELS,
    },
    probe: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions' },
  },
]

export function presetByRoute(route: string): ProviderPreset | undefined {
  return PRESETS.find((p) => p.route === route)
}

/** Custom-provider default credential ref: `DSH_PROVIDER_` + uppercased route with non-alphanumerics mapped to `_`. */
export function deriveCredentialRef(routeId: string): string {
  const suffix = routeId
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_')
    .replace(/_{2,}/g, '_')
  return `DSH_PROVIDER_${suffix}_API_KEY`
}
