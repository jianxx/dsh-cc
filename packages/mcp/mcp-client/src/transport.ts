/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing); Streamable HTTP and SSE connect to a URL, optionally through the
 * credentials-backed OAuth provider.
 *
 * @module
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Context } from '@deepseek-ai/cordis'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './index.ts'
import { CredentialsOAuthClientProvider } from './auth.ts'
import type { OAuthConfig } from './auth.ts'

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
 * actual spawn, so this transport shares the scrub definition rather than the
 * spawn path.
 */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/**
 * Build the credentials-backed OAuth provider for a network transport.
 * @param ctx - Cordis context carrying the `credentials` service.
 * @param serverName - server namespace used to derive credential references.
 * @param oauth - resolved OAuth configuration.
 * @returns the MCP SDK `OAuthClientProvider` implementation.
 */
export function buildAuthProvider(ctx: Context, serverName: string, oauth: OAuthConfig): CredentialsOAuthClientProvider {
  return new CredentialsOAuthClientProvider(ctx, serverName, oauth)
}

/** Optional transport construction inputs. */
export interface TransportContext {
  /** Cordis context used to build the credentials-backed OAuth provider. */
  ctx?: Context
  /** A pre-built OAuth provider; takes precedence over `ctx` for network configs. */
  authProvider?: CredentialsOAuthClientProvider
}

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @param transportCtx - Optional context and pre-built OAuth provider for
 *   network transports; omit both to skip OAuth wiring.
 * @returns A connected-ready MCP Transport (stdio, Streamable HTTP, or SSE).
 */
export function createTransport(config: Config, transportCtx?: TransportContext): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    case 'streamable-http':
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        transportOptions(config, transportCtx),
      ) as Transport
    case 'sse':
      /* oxlint-disable-next-line no-deprecated -- SSE support is a required
         Claude Code parity surface; the SDK deprecates it only because
         Streamable HTTP is preferred for new servers. */
      return new SSEClientTransport(
        new URL(config.url),
        transportOptions(config, transportCtx),
      )
  }
}

/** Build the SDK transport options, wiring OAuth when configured. */
function transportOptions(config: Extract<Config, { transport: 'streamable-http' | 'sse' }>, transportCtx: TransportContext | undefined) {
  const opts: { requestInit: RequestInit; authProvider?: OAuthClientProvider } = {
    requestInit: { headers: config.headers },
  }
  if (config.oauth !== undefined) {
    const provider = transportCtx?.authProvider
      ?? (transportCtx?.ctx !== undefined ? buildAuthProvider(transportCtx.ctx, config.serverName, config.oauth) : undefined)
    if (provider === undefined) {
      throw new Error(`mcp-client(${config.serverName}): oauth requires the credentials service to be available`)
    }
    opts.authProvider = provider
  }
  return opts
}
