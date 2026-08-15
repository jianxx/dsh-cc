/**
 * OAuth support: a `ctx.credentials`-backed `OAuthClientProvider` for the MCP
 * SDK's streamable-HTTP and SSE transports.
 *
 * The SDK implements RFC 9728 → RFC 8414 metadata discovery, PKCE, dynamic
 * client registration, and token refresh behind its `OAuthClientProvider`
 * interface (driven by the transport's `authProvider` option). This module
 * supplies the durable half of that seam: OAuth tokens, registered-client
 * information, the PKCE code verifier, and discovery state are persisted through
 * the `ctx.credentials` reference capability — values are stored under
 * server-derived credential references rather than inline, so configuration
 * surfaces never see the secret material.
 *
 * 401 handling: the transport auto-refreshes an expired access token against a
 * stored refresh token before a request; a mid-session `401` surfaces as an
 * `UnauthorizedError`, which the tool bridge retries once after invalidating
 * and re-running the token flow ({@link retryUnauthorizedOnce}).
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'

/** Config selecting an interactive OAuth flow for a network transport. */
export interface OAuthConfig {
  /** Redirect URL the user agent returns to after authorizing. */
  redirectUrl?: string
  /** Stable OAuth client name reported to the authorization server. */
  clientName?: string
  /**
   * Credential-reference prefix (defaults to `MCP_OAUTH_<SERVER>`); the provider
   * derives `_TOKENS`, `_CLIENT`, `_VERIFIER`, and `_DISCOVERY` refs from it.
   */
  credentialPrefix?: string
}

/** Deterministic credential ref for one OAuth artifact, derived per server. */
function oauthRef(prefix: string, kind: string): CredentialRef {
  const safe = prefix.toUpperCase().replace(/[^A-Za-z0-9_]/g, '_')
  return credentialRef(`${safe}_${kind}`)
}

/**
 * `ctx.credentials`-backed {@link OAuthClientProvider}. Every artifact is a
 * JSON value persisted under a derived credential reference; absent refs mean
 * "no state" (unconfigured), and an empty stored value counts as unset.
 */
export class CredentialsOAuthClientProvider implements OAuthClientProvider {
  private readonly tokensRef: CredentialRef
  private readonly clientRef: CredentialRef
  private readonly verifierRef: CredentialRef
  private readonly discoveryRef: CredentialRef
  private readonly redirectUrlValue: string | undefined

  constructor(
    private readonly ctx: Context,
    serverName: string,
    config: OAuthConfig,
  ) {
    const prefix = config.credentialPrefix ?? `MCP_OAUTH_${serverName}`
    this.tokensRef = oauthRef(prefix, 'TOKENS')
    this.clientRef = oauthRef(prefix, 'CLIENT')
    this.verifierRef = oauthRef(prefix, 'VERIFIER')
    this.discoveryRef = oauthRef(prefix, 'DISCOVERY')
    this.redirectUrlValue = config.redirectUrl
    void config.clientName // reserved for client metadata naming
  }

  get redirectUrl(): string | URL | undefined {
    return this.redirectUrlValue
  }

  get clientMetadata(): OAuthClientMetadata {
    const redirectUris = this.redirectUrlValue !== undefined ? [this.redirectUrlValue] : []
    return {
      client_name: 'dsh-mcp-client',
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    }
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const value = await this.read(this.clientRef)
    return value === undefined ? undefined : (JSON.parse(value) as OAuthClientInformationMixed)
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.write(this.clientRef, JSON.stringify(clientInformation))
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const value = await this.read(this.tokensRef)
    return value === undefined ? undefined : (JSON.parse(value) as OAuthTokens)
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.write(this.tokensRef, JSON.stringify(tokens))
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // Headless host: there is no browser to drive. Log the URL so an operator
    // can complete the flow; the transport raises an UnauthorizedError until
    // then, which the tool bridge surfaces (retrying once after a refresh).
    this.ctx.logger.info(`mcp-client oauth: open ${String(authorizationUrl)} to authorize`)
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.write(this.verifierRef, codeVerifier)
  }

  async codeVerifier(): Promise<string> {
    const value = await this.read(this.verifierRef)
    return value ?? ''
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.write(this.discoveryRef, JSON.stringify(state))
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const value = await this.read(this.discoveryRef)
    return value === undefined ? undefined : (JSON.parse(value) as OAuthDiscoveryState)
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    const refs = scope === 'all'
      ? [this.tokensRef, this.clientRef, this.verifierRef, this.discoveryRef]
      : scope === 'client'
        ? [this.clientRef]
        : scope === 'tokens'
          ? [this.tokensRef]
          : scope === 'verifier'
            ? [this.verifierRef]
            : [this.discoveryRef]
    await Promise.all(refs.map(ref => this.ctx.credentials.unset(ref)))
  }

  /** Read a credential value, treating an empty value as unset. */
  private async read(ref: CredentialRef): Promise<string | undefined> {
    const resolved = await this.ctx.credentials.resolve(ref)
    return resolved?.value ?? undefined
  }

  /** Persist a value; an empty value is removed rather than stored. */
  private async write(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) {
      await this.ctx.credentials.unset(ref)
      return
    }
    await this.ctx.credentials.set(ref, value)
  }
}
