/**
 * Capture stdio MCP server stderr so it cannot inherit the parent TTY.
 * SDK default is `stderr: 'inherit'`; piping is mandatory for a TUI host.
 *
 * @module
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

/** Ring capacity for the in-memory tail used in connection-failure warns. */
export const STDERR_TAIL_CAPACITY = 4 * 1024
/** Max characters of that tail embedded in a single-line `ctx.logger.warn`. */
export const STDERR_WARN_CAPACITY = 1024

const tails = new WeakMap<Transport, BoundedTail>()

/**
 * Append-only ring of the newest `capacity` characters. Used so a noisy
 * server cannot grow memory without bound while still leaving a crash banner
 * for the supervisor's warn line.
 */
export class BoundedTail {
  private buffer = ''
  constructor(private readonly capacity: number) {}

  push(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > this.capacity) {
      this.buffer = this.buffer.slice(this.buffer.length - this.capacity)
    }
  }

  snapshot(): string {
    return this.buffer
  }
}

/**
 * Default directory for captured stdio stderr.
 * `$DSH_HOME/mcp-logs`, falling back to `~/.dsh/mcp-logs`.
 */
function defaultStdioLogDir(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'mcp-logs')
}

/**
 * Last ≤1 KB of a captured tail, newlines collapsed, for a one-line logger.
 * @returns `undefined` when the tail is empty so callers can omit the suffix.
 */
export function formatStdioStderrForWarn(tail: string): string | undefined {
  const collapsed = tail.trim().replace(/\r?\n/g, '⏎')
  if (collapsed.length === 0) return undefined
  return collapsed.length > STDERR_WARN_CAPACITY
    ? collapsed.slice(collapsed.length - STDERR_WARN_CAPACITY)
    : collapsed
}

/** Snapshot of the ring attached to `transport`, or `''` when none. */
export function stdioStderrTail(transport: Transport): string {
  return tails.get(transport)?.snapshot() ?? ''
}

/**
 * Pipe `transport.stderr`, drain into a 4 KB ring, and append raw bytes to
 * `$DSH_HOME/mcp-logs/<serverName>.log` (or `logDir` when given).
 *
 * Must run before `start()`: SDK 1.29 creates the PassThrough in the
 * constructor when `stderr: 'pipe'`. An undrained pipe back-pressures the
 * child until it blocks in `write(2)`.
 *
 * No-ops when `stderr` is missing so `vi.fn()` SDK mocks stay constructible.
 *
 * ponytail: unbounded file growth (`rm` is rotation); concurrent dsh-cc
 * sessions sharing a serverName may interleave (session header marks each
 * generation); WriteStream buffer grows if the disk stalls — log must never
 * block MCP.
 */
export function attachStdioStderrDrain(
  transport: StdioClientTransport,
  serverName: string,
  logDir?: string,
): void {
  const stream = transport.stderr
  if (stream === null || stream === undefined) return
  const tail = new BoundedTail(STDERR_TAIL_CAPACITY)
  tails.set(transport, tail)
  const dir = logDir ?? defaultStdioLogDir()
  let file: WriteStream | undefined
  stream.on('data', (chunk: Buffer | string) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    tail.push(bytes.toString('utf8'))
    file ??= openLogFile(dir, serverName)
    file?.write(bytes)
  })
  // SDK close() does not destroy the PassThrough; the child's stderr `end`
  // does. Keep the data listener through SIGTERM grace so the last crash
  // line lands in both the ring and the file.
  stream.on('end', () => { file?.end(); file = undefined })
}

function openLogFile(logDir: string, serverName: string): WriteStream | undefined {
  try {
    mkdirSync(logDir, { recursive: true })
    const file = createWriteStream(join(logDir, `${serverName}.log`), { flags: 'a' })
    file.on('error', () => { /* disk-full / EACCES must not kill the host */ })
    file.write(`--- dsh-cc pid ${process.pid} ${new Date().toISOString()} ---\n`)
    return file
  } catch {
    return undefined
  }
}
