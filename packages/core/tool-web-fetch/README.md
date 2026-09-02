# @jianxx/dsh-cc-tool-web-fetch

CC-style `web_fetch` replacement with an optional `prompt`. This package replaces the
stock `@deepseek-ai/dsh-tool-web` `web_fetch` when the CC preset sets `tool-web` to
`fetch: false` and mounts this row in `cc-services` instead.

## Behavior

- **Without `prompt`** (or with a blank/whitespace one): identical to the stock tool —
  the raw converted page text is returned.
- **With `prompt`** and a configured `haiku` model alias (`ccModelRoutes.resolve('haiku')`):
  the fetched document is converted and passed, together with the prompt, to a one-shot
  summarize call on that cheap lane. The tool returns only the extraction. A string-form
  alias (`haiku: deepseek-v4-flash`, model only) inherits the missing provider from the
  calling agent's request-header; with no calling agent (hence no parent provider) the
  prompt is ignored (NOTICE).
- **With `prompt`** but the `haiku` alias unconfigured (no `ccModelRoutes` service or the
  resolver returns nothing): the summarize call is skipped. The tool degrades to the
  converted page prefixed by
  `(prompt ignored: configure the haiku model alias to summarize WebFetch results)`.

The summarize call never carries a `purpose` field: the harness `GenerateOptions.purpose`
union is closed (`'compaction' | 'session-title'`). A summary model that requests a tool
or produces no text fails the call as an `isError` tool result.

## Provider requirement

Stock dsh deployments mount **no fetch provider**: `ctx.web.fetch` throws
`WEB_PROVIDER_UNAVAILABLE` at execute time until a deployment composes a provider
(e.g. `web-fetch-http`, which remains unshipped through 0.1.1-rc.2). This package does
not mount one. Tests fake `ctx.web.fetch`.

## Prompt guidance interplay

Setting `tool-web` `fetch: false` also drops the stock "Follow up with web_fetch" clause
from the `web_search` system-prompt section. This package re-registers the
`tool:web_fetch` prompt section (order 111) covering fetch guidance.

## Known limits

- No host allowlist: a mounted provider reaches any URL the process can reach. Enable
  only on egress-restricted deployments. Upstream SSRF allowlist remains a follow-up.
