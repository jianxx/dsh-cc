/**
 * Tests for the Claude Code-style settings migration mechanism
 * (`defineMigration` / `runMigrations` / `readMigrationState`) and the
 * `settings-migrations` plugin's auto-run-on-mount path. Each run targets an
 * isolated mkdtemp home carrying its own settings.json and migration-state file,
 * mirroring the settings-cascade spec's temp-dir discipline.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as SettingsMigrations from '../src/index.ts'
import {
  defineMigration,
  readMigrationState,
  runMigrations,
  type MigrationContext,
} from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** Create an isolated temp home; returns its path. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-migrations-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Convenience settings-path / state-path pair under a temp home. */
function paths(dir: string): { settingsPath: string; statePath: string } {
  return { settingsPath: join(dir, 'settings.json'), statePath: join(dir, 'migrations.json') }
}

/** Map a migration version to a run recording appended into `log`. */
function recorder(version: number, log: string[]): { version: number; name: string; migrate(ctx: MigrationContext): void } {
  return {
    version,
    name: `v${version}`,
    migrate: (ctx) => {
      log.push(`run:${version}`)
      ctx.settings[`applied-${version}`] = true
    },
  }
}

describe('runMigrations in-version-order + write-back', () => {
  it('runs v1..v3 in ascending order, rewrites settings, and advances the version file', async () => {
    const dir = await tempDir()
    const { settingsPath, statePath } = paths(dir)
    await writeFile(settingsPath, JSON.stringify({ 'ui-theme': { theme: 'dark' }, legacyKey: 'x' }))

    const log: string[] = []
    const migrated = await runMigrations([
      recorder(1, log),
      {
        version: 2,
        name: 'rename-field',
        migrate: (ctx) => {
          ctx.settings.theme = ctx.settings['ui-theme']
          delete ctx.settings['ui-theme']
          delete ctx.settings.legacyKey
        },
      },
      recorder(3, log),
    ], { settingsPath, statePath })

    expect(log).toEqual(['run:1', 'run:3'])
    const doc = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>
    expect(doc).toMatchObject({ 'applied-1': true, 'applied-3': true, theme: { theme: 'dark' } })
    expect(doc).not.toHaveProperty('legacyKey')
    expect(doc).not.toHaveProperty('ui-theme')
    expect(await readMigrationState(statePath)).toEqual({ migrationVersion: 3 })
    expect(migrated).toEqual({ migrationVersion: 3 })
  })
})

describe('idempotency', () => {
  it('runs zero migrations on the second call when already at version 3', async () => {
    const dir = await tempDir()
    const { settingsPath, statePath } = paths(dir)
    await writeFile(settingsPath, JSON.stringify({ initial: true }))

    const log: string[] = []
    const migrations = [recorder(1, log), recorder(2, log), recorder(3, log)]

    const first = await runMigrations(migrations, { settingsPath, statePath })
    expect(first).toEqual({ migrationVersion: 3 })
    expect(log).toEqual(['run:1', 'run:2', 'run:3'])

    log.length = 0
    const second = await runMigrations(migrations, { settingsPath, statePath })
    expect(second).toEqual({ migrationVersion: 3 })
    expect(log).toEqual([])
  })
})

describe('failure semantics', () => {
  it('aborts the batch on a v2 throw: v3 not run, version stays at 1, repair resumes v2/v3', async () => {
    const dir = await tempDir()
    const { settingsPath, statePath } = paths(dir)
    await writeFile(settingsPath, JSON.stringify({ initial: true }))
    await writeFile(statePath, JSON.stringify({ migrationVersion: 1 }))

    const log: string[] = []
    let fail = true
    const migrations = [
      recorder(1, log),
      {
        version: 2,
        name: 'flaky',
        migrate: (ctx) => {
          if (fail) throw new Error('boom')
          log.push('run:2')
          ctx.settings.fixed = true
        },
      },
      {
        version: 3,
        name: 'v3',
        migrate: () => { log.push('run:3') },
      },
    ]

    await expect(runMigrations(migrations, { settingsPath, statePath })).rejects.toThrow('boom')
    expect(log).toEqual([])
    expect(await readMigrationState(statePath)).toEqual({ migrationVersion: 1 })
    // Pending survivors did not write their mutations.
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({ initial: true })

    // Repair: rerun applies v2 then v3, advancing to 3.
    fail = false
    const next = await runMigrations(migrations, { settingsPath, statePath })
    expect(next).toEqual({ migrationVersion: 3 })
    expect(log).toEqual(['run:2', 'run:3'])
    expect(await readMigrationState(statePath)).toEqual({ migrationVersion: 3 })
  })
})

describe('guard', () => {
  it('skips a guard=false migration but does not block later versions', async () => {
    const dir = await tempDir()
    const { settingsPath, statePath } = paths(dir)
    await writeFile(settingsPath, JSON.stringify({ initial: true }))

    const log: string[] = []
    const migrations = [
      {
        version: 1,
        name: 'skip-me',
        guard: () => false,
        migrate: () => { log.push('run:1') },
      },
      recorder(2, log),
    ]

    const result = await runMigrations(migrations, { settingsPath, statePath })
    expect(result).toEqual({ migrationVersion: 2 })
    expect(log).toEqual(['run:2'])
  })

  it('runs the migration when guard returns true', async () => {
    const dir = await tempDir()
    const { settingsPath, statePath } = paths(dir)
    await writeFile(settingsPath, JSON.stringify({ initial: true }))

    const log: string[] = []
    const migrations = [
      { version: 1, name: 'gated', guard: () => true, migrate: () => { log.push('run:1') } },
      recorder(2, log),
    ]
    await runMigrations(migrations, { settingsPath, statePath })
    expect(log).toEqual(['run:1', 'run:2'])
  })
})

describe('plugin auto-run-on-mount', () => {
  it('runs pending registered migrations at mount with autoRunOnMount default true', async () => {
    const dir = await tempDir()
    const { settingsPath, statePath } = paths(dir)
    await writeFile(settingsPath, JSON.stringify({ initial: true }))

    defineMigration({ version: 90, name: 'smoke', migrate: (ctx) => { ctx.settings.migrated = 90 } })

    const ctx = new Context()
    const fiber = ctx.plugin(SettingsMigrations, { settingsPath, statePath })
    cleanups.push(async () => { await fiber.dispose() })
    await fiber

    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toMatchObject({ migrated: 90 })
    expect(await readMigrationState(statePath)).toEqual({ migrationVersion: 90 })

    // Mounting again is a no-op (already at version 90) — idempotent.
    const again = new Context()
    const fiber2 = again.plugin(SettingsMigrations, { settingsPath, statePath })
    cleanups.push(async () => { await fiber2.dispose() })
    await fiber2
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toMatchObject({ migrated: 90 })
  })

  it('does not run when autoRunOnMount is false', async () => {
    const dir = await tempDir()
    const { settingsPath, statePath } = paths(dir)
    await writeFile(settingsPath, JSON.stringify({ initial: true }))

    const ctx = new Context()
    const fiber = ctx.plugin(SettingsMigrations, { settingsPath, statePath, autoRunOnMount: false })
    cleanups.push(async () => { await fiber.dispose() })
    await fiber

    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({ initial: true })
    expect(await readMigrationState(statePath)).toEqual({ migrationVersion: 0 })
  })

  it('warns and retains the version when a migration throws, without crashing the host', async () => {
    const dir = await tempDir()
    const { settingsPath, statePath } = paths(dir)
    await writeFile(settingsPath, JSON.stringify({ initial: true }))

    defineMigration({ version: 91, name: 'boom', migrate: () => { throw new Error('migrate boom') } })

    const ctx = new Context()
    const fiber = ctx.plugin(SettingsMigrations, { settingsPath, statePath })
    cleanups.push(async () => { await fiber.dispose() })
    await fiber

    // Plugin mount resolved (did not crash); version retained.
    expect(await readMigrationState(statePath)).toEqual({ migrationVersion: 0 })
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({ initial: true })
  })
})

describe('atomic write path', () => {
  it('leaves no temp-file residue and writes both documents atomically', async () => {
    const dir = await tempDir()
    const { settingsPath, statePath } = paths(dir)
    await writeFile(settingsPath, JSON.stringify({ initial: true }))

    await runMigrations([recorder(1, [])], { settingsPath, statePath })

    const entries = await readdir(dir)
    expect(entries).toEqual(expect.arrayContaining(['settings.json', 'migrations.json']))
    for (const entry of entries) {
      expect(entry.endsWith('.tmp')).toBe(false)
    }
    expect(entries).toHaveLength(2)
  })

  it('creates the settings document and the state file in a fresh home', async () => {
    const dir = await tempDir()
    const { settingsPath, statePath } = paths(dir)
    await runMigrations([recorder(1, [])], { settingsPath, statePath })
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toMatchObject({ 'applied-1': true })
    expect(await readMigrationState(statePath)).toEqual({ migrationVersion: 1 })
  })
})
