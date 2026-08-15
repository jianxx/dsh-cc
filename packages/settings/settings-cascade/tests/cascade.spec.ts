import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SettingsCascadeProvider, type Config } from '../src/index.ts'

interface ThemeConfig {
  theme: string
  fontSize: number
}

const ThemeSchema: z<ThemeConfig> = z.object({
  theme: z.string().default('dark'),
  fontSize: z.number().default(14),
})

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cascade-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(config: Config): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(SettingsCascadeProvider, config)
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

/** Write a settings.json and return its path. */
async function writeSettings(dir: string, name: string, doc: unknown): Promise<string> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, JSON.stringify(doc))
  return path
}

/** Resolved `ui-theme` section given a plugin default and a registered default. */
function themeOf(ctx: Context, base?: Partial<ThemeConfig>): ThemeConfig {
  const options: { base?: Partial<ThemeConfig> } = {}
  if (base !== undefined) options.base = base
  return ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema, options)!.get() as ThemeConfig
}

describe('five-level precedence', () => {
  it('applies sources from low to high priority', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { 'ui-theme': { theme: 'user' } })
    const project = await writeSettings(dir, 'project.json', { 'ui-theme': { theme: 'project' } })
    const local = await writeSettings(dir, 'local.json', { 'ui-theme': { theme: 'local' } })
    const flag = await writeSettings(dir, 'flag.json', { 'ui-theme': { theme: 'flag' } })
    const policy = await writeSettings(dir, 'policy.json', { 'ui-theme': { theme: 'policy' } })

    const ctx = await boot({
      userSettingsPath: user,
      projectSettingsPath: project,
      localSettingsPath: local,
      flagSettingsPath: flag,
      policy: { userPath: policy },
    })
    // The namespace key must match the raw section key.
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    expect((scope.get() as ThemeConfig).theme).toBe('policy')
  })

  it('lets a higher source fill a missing key while lower keys survive', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { 'ui-theme': { theme: 'user', fontSize: 12 } })
    const project = await writeSettings(dir, 'project.json', { 'ui-theme': { fontSize: 20 } })
    const ctx = await boot({ userSettingsPath: user, projectSettingsPath: project })
    expect(themeOf(ctx)).toEqual({ theme: 'user', fontSize: 20 })
  })

  it('resolves plugin defaults below every file source', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { 'ui-theme': { theme: 'user' } })
    const ctx = await boot({ userSettingsPath: user })
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema, {
      base: { fontSize: 18 },
    })
    expect(scope.get()).toEqual({ theme: 'user', fontSize: 18 })
  })

  it('resolves only defaults and base when every source is absent', async () => {
    const dir = await tempDir()
    const ctx = await boot({
      userSettingsPath: join(dir, 'missing-user.json'),
      projectSettingsPath: join(dir, 'missing-project.json'),
    })
    expect(themeOf(ctx)).toEqual({ theme: 'dark', fontSize: 14 })
  })
})

describe('flag settings', () => {
  it('merges inline flag settings above the flag file', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { 'ui-theme': { theme: 'user', fontSize: 12 } })
    const flagFile = await writeSettings(dir, 'flag.json', { 'ui-theme': { theme: 'flagfile' } })
    const ctx = await boot({
      userSettingsPath: user,
      flagSettingsPath: flagFile,
      flagSettingsInline: { 'ui-theme': { theme: 'inline' } },
    })
    expect(themeOf(ctx)).toEqual({ theme: 'inline', fontSize: 12 })
  })
})

describe('deny precedence across sources', () => {
  it('unions deny and removes denied rules from allow across sources', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', {
      'ui-theme': { permissions: { allow: ['Bash(a)', 'Bash(b)'], deny: ['Bash(c)'] } },
    })
    const project = await writeSettings(dir, 'project.json', {
      'ui-theme': { permissions: { allow: ['Bash(c)'], deny: ['Bash(a)'] } },
    })
    const ctx = await boot({ userSettingsPath: user, projectSettingsPath: project })
    const value = themeOf(ctx) as ThemeConfig & { permissions: { allow: string[]; deny: string[] } }
    expect(value.permissions.allow).toEqual(['Bash(b)'])
    expect(value.permissions.deny).toEqual(['Bash(c)', 'Bash(a)'])
  })
})

describe('policy first-source-wins', () => {
  it('prefers remote over system over user policy sources', async () => {
    const dir = await tempDir()
    const system = await writeSettings(dir, 'system.json', { 'ui-theme': { theme: 'system' } })
    const user = await writeSettings(dir, 'policy-user.json', { 'ui-theme': { theme: 'policy-user' } })
    const ctx = await boot({
      policy: { remoteSettings: { 'ui-theme': { theme: 'remote' } }, systemPath: system, userPath: user },
    })
    expect(themeOf(ctx)).toEqual({ theme: 'remote', fontSize: 14 })
  })

  it('falls back to system when remote is empty', async () => {
    const dir = await tempDir()
    const system = await writeSettings(dir, 'system.json', { 'ui-theme': { theme: 'system' } })
    const user = await writeSettings(dir, 'policy-user.json', { 'ui-theme': { theme: 'policy-user' } })
    const ctx = await boot({
      policy: { remoteSettings: {}, systemPath: system, userPath: user },
    })
    expect(themeOf(ctx)).toEqual({ theme: 'system', fontSize: 14 })
  })

  it('falls back to user when remote and system are absent', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'policy-user.json', { 'ui-theme': { theme: 'policy-user' } })
    const ctx = await boot({
      policy: { remoteSettings: {}, systemPath: join(dir, 'missing-system.json'), userPath: user },
    })
    expect(themeOf(ctx)).toEqual({ theme: 'policy-user', fontSize: 14 })
  })
})

describe('misconfiguration fails loud', () => {
  it('fails plugin load on an invalid user settings file', async () => {
    const dir = await tempDir()
    const bad = join(dir, 'bad.json')
    await writeFile(bad, '{ not valid json')
    await expect(boot({ userSettingsPath: bad })).rejects.toThrow()
  })

  it('fails plugin load on a non-object settings root', async () => {
    const dir = await tempDir()
    const bad = await writeSettings(dir, 'scalar.json', ['not', 'a', 'map'])
    await expect(boot({ userSettingsPath: bad })).rejects.toThrow()
  })
})
