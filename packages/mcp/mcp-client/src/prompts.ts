/**
 * Prompt bridge: exposes an MCP server's `prompts` capability to the model as
 * discoverable skills on the `ctx.skills` registry, one runtime skill per MCP
 * prompt, when the server declares the capability.
 *
 * The harness's skill registry enforces a lowercase-kebab name grammar
 * (`[a-z0-9]+(?:-[a-z0-9]+)*`), which `mcp__<server>__<prompt>` (with its
 * double underscores) cannot satisfy. Names are therefore mapped to kebab-case
 * (`mcp-<server>-<prompt>`); see {@link promptSkillName}. The body is the
 * prompt's rendered text (or, for prompts that require arguments, the argument
 * contract) — plain prose only. MCP-sourced skills must never embed or invoke
 * shell; the body is always inert text.
 *
 * @module
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  GetPromptRequestSchema,
  ListPromptsResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { Context } from '@deepseek-ai/cordis'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

/** Registered skill disposers for one prompt generation. */
export type PromptDisposers = Map<string, () => void>

/**
 * Map an MCP prompt identity to a registry-valid skill name. The registry's
 * grammar rejects underscores, so the `mcp__<server>__<prompt>` shape becomes
 * lowercase kebab-case: non-alphanumeric runs collapse to single dashes, and a
 * leading `mcp` prefix is guaranteed. Distinct identities may rarely collapse;
 * the first registration wins and later duplicates log a registry warning.
 *
 * @param serverName - MCP server namespace.
 * @param promptName - the MCP prompt's own name.
 * @returns a valid lowercase-kebab skill name.
 */
export function promptSkillName(serverName: string, promptName: string): string {
  const raw = `mcp-${serverName}-${promptName}`
  const kebab = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (kebab.length === 0) return 'mcp'
  return kebab
}

/** Whether an MCP prompt can be fetched without arguments. */
function argumentless(prompt: { arguments?: Array<{ required?: boolean }> }): boolean {
  return (prompt.arguments ?? []).every(a => a.required !== true)
}

/**
 * Render an MCP prompt's messages into plain text. Each message's content block
 * contributes its text; non-text blocks become a short marker. The output is
 * inert prose — never executable code.
 *
 * @param messages - the prompt's message list from `prompts/get`.
 * @returns the joined prompt body.
 */
function renderMessages(messages: unknown): string {
  const list = Array.isArray(messages) ? messages : []
  const parts: string[] = []
  for (const message of list) {
    const record = message as { role?: string; content?: unknown } | null
    const role = record?.role ?? 'user'
    const content = record?.content
    parts.push(renderBlock(content, role))
  }
  return parts.filter(p => p.length > 0).join('\n')
}

/** Render one content block (array or single) to text. */
function renderBlock(content: unknown, role: string): string {
  const blocks = Array.isArray(content) ? content : [content]
  const text: string[] = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') {
      text.push('[unsupported prompt content]')
      continue
    }
    const item = block as { type?: string; text?: string }
    if (item.type === 'text' && item.text !== undefined) text.push(item.text)
    else if (item.type === 'text') text.push('')
    else if (item.type === 'image') text.push('[image content]')
    else text.push(`[${item.type ?? 'unsupported'} content]`)
  }
  const joined = text.join('')
  if (joined.length === 0) return `[${role} message, no text]`
  return `${role === 'user' ? 'User' : 'Assistant'}: ${joined}`
}

type PromptLike = {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

/**
 * Load one MCP prompt body. Argumentless prompts are resolved via `prompts/get`
 * and their rendered text becomes the skill body. Prompts requiring arguments
 * cannot be fetched on demand (there is no prompt-call tool); their body
 * documents the prompt and its argument contract instead, in prose.
 *
 * @param client - connected MCP client.
 * @param prompt - the MCP prompt to load.
 * @returns the skill body text.
 */
async function loadPromptBody(client: Client, prompt: PromptLike): Promise<string> {
  if (argumentless(prompt)) {
    try {
      const result = await client.request(
        { method: 'prompts/get', params: { name: prompt.name } },
        GetPromptRequestSchema,
      )
      return renderMessages((result as { messages?: unknown }).messages)
    } catch {
      // Fall through to the static contract below on a get failure.
    }
  }
  const args = (prompt.arguments ?? []).map((a) => {
    const required = a.required === true ? ' (required)' : ''
    return `- ${a.name}${required}${a.description !== undefined ? ': ' + a.description : ''}`
  })
  const flag = (prompt.arguments ?? []).length > 0
    ? `\n\nThis MCP prompt requires the following arguments:\n${args.join('\n')}`
    : ''
  const description = prompt.description !== undefined && prompt.description.length > 0
    ? `${prompt.description}\n\n`
    : ''
  return `${description}This is an MCP prompt named "${prompt.name}"${flag}. The model should use it to structure its response.`
}

/**
 * Register one skill per MCP prompt for a server on `ctx.skills`. Runs only
 * when the server declared the `prompts` capability. Registering requires the
 * `ctx.skills` service; when it is absent this is a no-op (the harness offers
 * no prompt surface for that server).
 *
 * @param client - connected MCP client used to load prompt bodies.
 * @param ctx - Cordis context; `ctx.skills` is read optionally.
 * @param serverName - server namespace used to derive skill names.
 * @returns disposers for every registered skill (never rejects).
 */
export async function syncPrompts(
  client: Client,
  ctx: Context,
  serverName: string,
): Promise<PromptDisposers> {
  const skills = ctx.get('skills')
  const disposers: PromptDisposers = new Map()
  if (skills === undefined) return disposers

  const prompts: PromptLike[] = []
  let cursor: string | undefined
  try {
    do {
      const page = await client.request(
        { method: 'prompts/list', ...cursor === undefined ? {} : { params: { cursor } } },
        ListPromptsResultSchema,
      )
      prompts.push(...(page as { prompts: typeof prompts }).prompts)
      cursor = (page as { nextCursor?: string }).nextCursor
    } while (cursor !== undefined)
  } catch (error) {
    ctx.logger.warn(`mcp-client(${serverName}): prompts/list failed, no prompts registered: ${String(error)}`)
    return disposers
  }

  for (const prompt of prompts) {
    const name = promptSkillName(serverName, prompt.name)
    if (!isSkillName(name) || disposers.has(name)) continue
    const body = await loadPromptBody(client, prompt)
    if (body.length === 0) continue
    try {
      const definition: SkillRegistration = {
        name,
        description: prompt.description ?? `MCP prompt "${prompt.name}" from server "${serverName}"`,
        source: 'runtime',
        content: body,
      }
      disposers.set(name, skills.register(definition))
    } catch (error) {
      ctx.logger.warn(`mcp-client(${serverName}): could not register prompt skill "${name}": ${String(error)}`)
    }
  }
  return disposers
}
