/**
 * CC-style `web_fetch` replacement with an optional `prompt`. The stock
 * harness tool returns the raw converted page; this one adds a model-facing
 * `prompt` parameter and, when the cheap lane (`haiku` alias) is configured,
 * one-shot summarizes the fetched document against that instruction. Without
 * a configured route the tool degrades gracefully: the converted page comes
 * back prefixed by a NOTICE so the caller knows the prompt was ignored.
 * @module @jianxx/dsh-cc-tool-web-fetch
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { fetchMetaFromValue, formatFetchOutput, parseFetchArgs, presentFetchCall, presentFetchResult } from '@deepseek-ai/dsh-tool-web'
import { toOneShotRoute } from '@jianxx/dsh-cc-model-aliases'
import { defineTool } from '@jianxx/dsh-cc-tools'
import type { ToolRunContext } from '@jianxx/dsh-cc-tools'

export const name = 'tool-web-fetch'
export const inject = ['tools', 'web', 'systemPrompt', 'llm']

/** Runtime configuration for the WebFetch tool. */
export interface Config {
  /** Cooperative tool-call timeout budget (ms), attached as the tool's `timeoutMs`. */
  fetchTimeoutMs?: number
  /** Cap on the complete rendered `web_fetch` output characters. */
  fetchMaxOutputChars?: number
  /** Token budget for the one-shot summarize call. */
  maxSummaryTokens?: number
  /** Character cap on the document converted and fed to the summarize call. */
  maxSummaryInputChars?: number
}

/** Runtime configuration schema. */
export const Config: z<Config> = z.object({
  fetchTimeoutMs: z.number(),
  fetchMaxOutputChars: z.number(),
  maxSummaryTokens: z.number(),
  maxSummaryInputChars: z.number(),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Defaults applied by the config schema. */
const DEFAULTS: ResolvedConfig = {
  fetchTimeoutMs: 30_000,
  fetchMaxOutputChars: 200_000,
  maxSummaryTokens: 2048,
  maxSummaryInputChars: 32_000,
}

/** Shown when a `prompt` was given but the cheap lane is unconfigured. */
const NOTICE = '(prompt ignored: configure the haiku model alias to summarize WebFetch results)'

/** Model-visible failure (maps to an isError tool result). */
class WebFetchError extends Error {}

export function apply(ctx: Context, config: Config = {}): void {
  const resolved: ResolvedConfig = {
    ...DEFAULTS,
    ...Object.fromEntries(
      Object.entries(config).filter(([, value]) => value !== undefined),
    ) as Partial<ResolvedConfig>,
  }

  ctx.systemPrompt.section({
    name: 'tool:web_fetch',
    order: 111,
    text: 'Use the web_fetch tool to retrieve the content of a specific HTTP(S) URL (for example a result from web_search). '
      + 'The optional prompt parameter extracts or summarizes the page against that instruction; when the haiku model alias is configured '
      + 'the summarization runs on that cheap lane. Omit prompt to receive the raw page text. Cite the URL as a markdown link when you use its content.',
  })

  // The harness presenters/format helpers carry harness `dsh-tools` lib types,
  // which are structurally compatible at runtime but nominal-incompatible with
  // the cc-tools `ToolDefinition` under `exactOptionalPropertyTypes` — the
  // established seam cast (see memory/hooks tests).
  const tool = defineTool({
    name: 'web_fetch',
    description: 'Fetch the content of a specific HTTP(S) URL and return it decoded to text. '
      + 'The optional prompt, when set and the haiku alias is configured, extracts/summarizes the page against that instruction '
      + 'instead of returning the full raw text.',
    parameters: {
      url: { type: 'string', required: true, description: 'The HTTP(S) URL to fetch.' },
      prompt: {
        type: 'string',
        description: 'If set, extract/summarize the page against this instruction. Omit to receive the raw page text.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          statusCode: { type: 'integer', required: true },
          body: {
            required: true,
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'html' },
                  content: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'text' },
                  content: { type: 'string', required: true },
                },
              },
            ],
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatFetchOutput(value, resolved.fetchMaxOutputChars) }],
      presentationMeta: (_args, value) => fetchMetaFromValue(value, resolved.fetchMaxOutputChars),
    },
    timeoutMs: resolved.fetchTimeoutMs,
    // Provider reads do not mutate parent-agent state.
    isConcurrencySafe: () => true,
    presentCall: presentFetchCall,
    presentResult: presentFetchResult,
    async execute(args: { url: string; prompt?: string }, exec: ToolRunContext): Promise<{
      url: string
      statusCode: number
      body: { kind: 'html' | 'text'; content: string }
      truncated: boolean
    }> {
      const input = parseFetchArgs({ url: args.url })
      const result = await ctx.web.fetch({ url: input.url }, exec.signal)
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''

      if (prompt.length === 0) {
        return {
          url: result.url,
          statusCode: result.statusCode,
          body: { kind: result.body.kind as 'html' | 'text', content: result.body.content },
          truncated: result.truncated,
        }
      }

      // Lazy by contract: the row lives in cc-services, but unit tests that
      // only provide a fake seam must be able to load this plugin.
      const routes = ctx.get('ccModelRoutes') as
        | { resolve(model: string | undefined): { provider?: string; model?: string } | undefined }
        | undefined
      // The calling agent's logged request header fills the provider for a
      // string-form (model-only) haiku alias; absent a calling agent the
      // pair cannot be completed and the tool degrades to the NOTICE.
      const parent = exec.agent?.session.requestHeader()?.config as
        | { provider?: string; model?: string }
        | undefined
      const filled = toOneShotRoute(routes?.resolve('haiku'), parent)
      const converted = formatFetchOutput(result, resolved.maxSummaryInputChars)

      if (filled === undefined) {
        return {
          url: result.url,
          statusCode: result.statusCode,
          body: { kind: 'text', content: `${NOTICE}\n\n${converted}` },
          truncated: result.truncated,
        }
      }

      // One-shot summarize on the cheap lane. `purpose` is omitted on
      // purpose: the harness GenerateOptions purpose union is closed
      // ('compaction' | 'session-title') and does not admit a fetch reason.
      const options = {
        provider: filled.provider,
        model: filled.model,
        maxTokens: resolved.maxSummaryTokens,
        system: 'Extract/summarize the fetched document to answer the user prompt. Return only the extraction. Cite the URL as a markdown link.',
        messages: [createUserMessage({
          content: [{ type: 'text', text: `Prompt:\n${prompt}\n\nDocument:\n${converted}` }],
          source: { kind: 'plugin', plugin: name },
        })],
        signal: exec.signal,
      }
      const assembler = new BlockAssembler()
      for await (const chunk of ctx.llm.stream(options) as AsyncIterable<StreamChunk>) {
        assembler.push(chunk)
      }
      // Terminal finish kinds agree with block inspection: either signals a
      // misbehaving summary model.
      if (assembler.finish?.kind === 'tool-calls') {
        throw new WebFetchError('web_fetch: summary model unexpectedly requested a tool')
      }
      if (assembler.blocks().some(block => block.type === 'tool-call')) {
        throw new WebFetchError('web_fetch: summary model unexpectedly requested a tool')
      }
      const text = assembler.blocks()
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join(' ')
        .trim()
      if (text.length === 0) throw new WebFetchError('web_fetch: summary model produced no text')
      return {
        url: result.url,
        statusCode: result.statusCode,
        body: { kind: 'text', content: text },
        truncated: result.truncated,
      }
    },
  })
  ctx.tools.register(tool as unknown as Parameters<typeof ctx.tools.register>[0])
}
