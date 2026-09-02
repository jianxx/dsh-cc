import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createTransport } from '@jianxx/dsh-cc-mcp-client/src/transport.ts'
import {
  BoundedTail,
  STDERR_WARN_CAPACITY,
  attachStdioStderrDrain,
  formatStdioStderrForWarn,
  stdioStderrTail,
} from '@jianxx/dsh-cc-mcp-client/src/stdio-stderr.ts'
import type { Config } from '@jianxx/dsh-cc-mcp-client'

function stdioConfig(): Config {
  return {
    transport: 'stdio',
    serverName: 'srv',
    command: process.execPath,
    args: ['-e', 'process.stderr.write("banner-line\\n")'],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
  }
}

describe('BoundedTail', () => {
  it('drops the oldest characters past capacity', () => {
    const tail = new BoundedTail(4)
    tail.push('abc')
    tail.push('def')
    expect(tail.snapshot()).toBe('cdef')
  })
})

describe('formatStdioStderrForWarn', () => {
  it('returns undefined for empty or whitespace tails', () => {
    expect(formatStdioStderrForWarn('')).toBeUndefined()
    expect(formatStdioStderrForWarn('  \n  ')).toBeUndefined()
  })

  it('collapses newlines and keeps at most 1 KB', () => {
    expect(formatStdioStderrForWarn('a\nb\r\nc')).toBe('a⏎b⏎c')
    const long = `${'x'.repeat(STDERR_WARN_CAPACITY)}y`
    expect(formatStdioStderrForWarn(long)).toBe(`${'x'.repeat(STDERR_WARN_CAPACITY - 1)}y`)
  })
})

describe('stdioStderrTail', () => {
  it('returns empty string for transports with no attached drain', () => {
    expect(stdioStderrTail({} as Transport)).toBe('')
  })

  it('does not throw when the SDK mock has no stderr stream', () => {
    expect(() => attachStdioStderrDrain({} as never, 'srv')).not.toThrow()
  })
})

describe('createTransport stdio stderr capture', () => {
  let logDir = ''

  afterEach(() => {
    if (logDir !== '') rmSync(logDir, { recursive: true, force: true })
    logDir = ''
  })

  it('does not create the log file before start (lazy open on first chunk)', () => {
    logDir = mkdtempSync(join(tmpdir(), 'dsh-mcp-stderr-'))
    createTransport(stdioConfig(), { logDir })
    expect(existsSync(join(logDir, 'srv.log'))).toBe(false)
  })

  it('drains piped stderr into the ring and an append-only log file', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'dsh-mcp-stderr-'))
    const transport = createTransport(stdioConfig(), { logDir })
    expect((transport as { stderr: unknown }).stderr).not.toBeNull()
    await transport.start()
    try {
      await viWaitForLog(join(logDir, 'srv.log'), 'banner-line')
      expect(stdioStderrTail(transport)).toContain('banner-line')
      const log = readFileSync(join(logDir, 'srv.log'), 'utf8')
      expect(log).toContain(`--- dsh-cc pid ${process.pid}`)
      expect(log).toContain('banner-line')
    } finally {
      await transport.close()
    }
  })

  it('appends a second session header across sequential generations', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'dsh-mcp-stderr-'))
    const first = createTransport(stdioConfig(), { logDir })
    await first.start()
    await viWaitForLog(join(logDir, 'srv.log'), 'banner-line')
    await first.close()

    const second = createTransport(stdioConfig(), { logDir })
    await second.start()
    try {
      // Two generations → two headers proves flags: 'a' (never 'w').
      await viWaitForCondition(() => countHeaders() >= 2)
      expect(countHeaders()).toBe(2)
    } finally {
      await second.close()
    }
  })

  /** Count session headers currently flushed to the log file (missing file → 0). */
  function countHeaders(): number {
    try {
      return readFileSync(join(logDir, 'srv.log'), 'utf8')
        .split(`--- dsh-cc pid ${process.pid}`).length - 1
    } catch {
      return 0
    }
  }
})

async function viWaitForCondition(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
  }
  throw new Error('timed out waiting for condition')
}

async function viWaitForLog(path: string, needle: string): Promise<void> {
  const deadline = Date.now() + 5_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      expect(readFileSync(path, 'utf8')).toContain(needle)
      return
    } catch (error) {
      lastError = error
      await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    }
  }
  throw lastError ?? new Error(`timed out waiting for ${needle} in ${path}`)
}
