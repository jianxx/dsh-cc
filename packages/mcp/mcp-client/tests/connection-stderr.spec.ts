/**
 * Supervisor-level stderr-tail contract, driven against a REAL stdio child
 * (no SDK mocks): a crashing server's stderr banner must reach the existing
 * "connection attempt failed" warn as a one-line `; stderr:` suffix, and the
 * full stream must land in `$DSH_HOME/mcp-logs/<serverName>.log`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@jianxx/dsh-cc-tools'
import { apply } from '@jianxx/dsh-cc-mcp-client/src/index.ts'
import type { Config } from '@jianxx/dsh-cc-mcp-client'

function crashConfig(): Config {
  return {
    transport: 'stdio',
    serverName: 'crashy',
    command: process.execPath,
    args: ['-e', 'process.stderr.write("crash-banner\\n"); process.exit(1)'],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    reconnect: { enabled: false },
  }
}

function captureWarns(ctx: Context): { warns: string[] } {
  const warns: string[] = []
  ctx.logger.warn = ((message: unknown) => { warns.push(String(message)) }) as typeof ctx.logger.warn
  return { warns }
}

describe('supervisor warn carries the stdio stderr tail (real child)', () => {
  let isolatedHome = ''
  let previousDshHome: string | undefined

  beforeEach(() => {
    isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-mcp-conn-stderr-'))
    previousDshHome = process.env.DSH_HOME
    process.env.DSH_HOME = isolatedHome
  })

  afterEach(() => {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    rmSync(isolatedHome, { recursive: true, force: true })
  })

  it('attaches the crash banner to the connection-failed warn', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const { warns } = captureWarns(ctx)

    await apply(ctx, crashConfig())

    const failed = warns.filter(line => line.includes('connection attempt failed'))
    expect(failed.length).toBeGreaterThanOrEqual(1)
    expect(failed.some(line => line.includes('stderr:') && line.includes('crash-banner'))).toBe(true)
    // One-line sink: the collapsed tail must not contain raw newlines.
    for (const line of failed) expect(line).not.toMatch(/\n/)

    // Full stream (header + banner) is on disk under the isolated DSH_HOME.
    const logPath = join(isolatedHome, 'mcp-logs', 'crashy.log')
    expect(existsSync(logPath)).toBe(true)
    const log = readFileSync(logPath, 'utf8')
    expect(log).toContain(`--- dsh-cc pid ${process.pid}`)
    expect(log).toContain('crash-banner')
  }, 20_000)
})
