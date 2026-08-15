/**
 * Claude Code skill frontmatter parsing.
 *
 * This module owns the full Claude Code `SKILL.md` frontmatter spec: it reads
 * every known field, tolerates unknown fields, and throws for known fields with
 * invalid values. Parsing keeps frontmatter independent of body loading so
 * discovery can estimate tokens and build summaries without reading the body.
 *
 * @module
 */

import { parse as parseYaml } from 'yaml'

/** Parsed named arguments from the `arguments` field. */
export type ParsedCcArguments = readonly string[]

/** A complete parse of Claude Code skill frontmatter into harness-facing fields. */
export interface ParsedCcFrontmatter {
  /** Kebab-case skill name from `name`; validated by the provider against the registry grammar. */
  readonly name: string | undefined
  /** Routing description from `description`. */
  readonly description: string
  /** Optional routing guidance from `when_to_use`. */
  readonly whenToUse: string | undefined
  /** Allowed tool allow-list from `allowed-tools`, as parsed names. */
  readonly allowedTools: readonly string[]
  /** Optional argument usage hint from `argument-hint`. */
  readonly argumentHint: string | undefined
  /** Named argument placeholders from `arguments`. */
  readonly arguments: ParsedCcArguments
  /** Optional semantic version from `version`. */
  readonly version: string | undefined
  /** Resolved model from `model`; `inherit` yields undefined. */
  readonly model: string | undefined
  /** Whether a human may invoke the skill from `user-invocable`. */
  readonly userInvocable: boolean
  /** Whether the model catalog hides the skill from `disable-model-invocation`. */
  readonly disableModelInvocation: boolean
  /** `context: fork` selects subagent execution; otherwise inline. */
  readonly executionContext: 'fork' | undefined
  /** Optional target agent persona from `agent`. */
  readonly agent: string | undefined
  /** Optional effort level from `effort`. */
  readonly effort: string | undefined
  /** Inline-shell toggle from `shell` (false disables `` !`...` `` execution). */
  readonly shell: boolean | undefined
  /** Raw validated hooks object from `hooks`, preserved verbatim. */
  readonly hooks: unknown
  /** Gitignore-style activation paths from `paths`, or undefined when match-all. */
  readonly paths: readonly string[] | undefined
  /** Any unrecognized keys, preserved for downstream tolerant consumers. */
  readonly unknown: Readonly<Record<string, unknown>>
}

/** A split frontmatter document: parsed data plus the Markdown body. */
export interface CcFrontmatterDocument {
  /** Parsed frontmatter values, pre-validation. */
  readonly data: Record<string, unknown>
  /** Markdown body after the closing `---`. */
  readonly body: string
}

const TRUE_FORMS = /^(?:true|yes|on|1)$/i
const FALSE_FORMS = /^(?:false|no|off|0)$/i

function booleanValue(key: string, value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') {
    throw new TypeError(`frontmatter field "${key}" must be a boolean`)
  }
  if (TRUE_FORMS.test(value)) return true
  if (FALSE_FORMS.test(value)) return false
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

function stringValue(key: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError(`frontmatter field "${key}" must be a string`)
  }
  return value
}

function optionalString(key: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  return stringValue(key, value)
}

function stringList(key: string, value: unknown): readonly string[] {
  const names = stringValue(key, value).split(',').map(item => item.trim())
  return names.filter((item, index) => item.length > 0 && names.indexOf(item) === index)
}

function parseNamedArguments(value: unknown): ParsedCcArguments {
  if (value === undefined) return []
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\s+/) : null
  if (raw === null) {
    throw new TypeError('frontmatter field "arguments" must be a string or array of strings')
  }
  return raw
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item.length > 0 && !/^\d+$/.test(item))
}

function optionalModel(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const model = stringValue('model', value)
  return model === 'inherit' ? undefined : model
}

function optionalEffort(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const effort = stringValue('effort', value)
  const KNOWN = ['low', 'medium', 'high', 'ultrahigh'] as const
  if (KNOWN.some(level => level === effort)) return effort
  if (/^\d+$/.test(effort)) return effort
  throw new TypeError('frontmatter field "effort" must be a known level or an integer')
}

function optionalShell(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  return booleanValue('shell', value)
}

function parseContext(value: unknown): 'fork' | undefined {
  if (value === undefined) return undefined
  const context = stringValue('context', value)
  if (context === 'fork') return 'fork'
  throw new TypeError('frontmatter field "context" only supports "fork"')
}

function optionalPaths(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined
  const raw = Array.isArray(value) ? value : [value]
  const patterns = raw
    .filter((item): item is string => typeof item === 'string')
    // `ignore` treats "path" as matching both the path and everything inside it,
    // so a trailing `/**` is redundant and collapses to that directory.
    .map(pattern => (pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern))
    .map(String)
    .filter(pattern => pattern.length > 0)
  if (patterns.length === 0 || patterns.every(pattern => pattern === '**')) return undefined
  return [...new Set(patterns)]
}

const KNOWN_KEYS = new Set([
  'name',
  'description',
  'when_to_use',
  'allowed-tools',
  'argument-hint',
  'arguments',
  'version',
  'model',
  'user-invocable',
  'disable-model-invocation',
  'context',
  'agent',
  'effort',
  'shell',
  'hooks',
  'paths',
])

/**
 * Parse the complete Claude Code frontmatter from a raw `SKILL.md` document.
 * Unknown keys are preserved in `unknown`; a known key with an invalid value
 * throws so a malformed skill fails loudly instead of silently mis-activating.
 * @param raw - the full `SKILL.md` text.
 * @returns the parsed fields, or `undefined` when the document has no frontmatter.
 */
export function parseCcFrontmatter(raw: string): ParsedCcFrontmatter | undefined {
  const document = parseCcFrontmatterDocument(raw)
  if (document === undefined) return undefined
  const { data } = document
  const unknown: Record<string, unknown> = {}
  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.has(key)) unknown[key] = data[key]
  }
  const fields = {
    name: optionalString('name', data.name),
    description: stringValue('description', data.description),
    whenToUse: optionalString('when_to_use', data.when_to_use),
    allowedTools: stringList('allowed-tools', data['allowed-tools'] ?? ''),
    argumentHint: optionalString('argument-hint', data['argument-hint']),
    arguments: parseNamedArguments(data.arguments),
    version: optionalString('version', data.version),
    model: optionalModel(data.model),
    userInvocable: data['user-invocable'] === undefined ? true : booleanValue('user-invocable', data['user-invocable']),
    disableModelInvocation: data['disable-model-invocation'] === undefined
      ? false
      : booleanValue('disable-model-invocation', data['disable-model-invocation']),
    executionContext: parseContext(data.context),
    agent: optionalString('agent', data.agent),
    effort: optionalEffort(data.effort),
    shell: optionalShell(data.shell),
    hooks: data.hooks,
    paths: optionalPaths(data.paths),
    unknown,
  }
  return fields
}

/**
 * Split a raw `SKILL.md` into its frontmatter YAML payload and Markdown body.
 * Returns `undefined` when the document does not begin with a `---` fence.
 * @param raw - the full `SKILL.md` text.
 * @returns the parsed YAML object and trailing body, or `undefined`.
 */
export function parseCcFrontmatterDocument(raw: string): CcFrontmatterDocument | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '')
  if (firstLine !== '---') return undefined
  const start = firstLineEnd + 1
  const closingStart = findClosingFence(raw, start)
  if (closingStart === undefined) return undefined
  const yaml = raw.slice(start, closingStart)
  const parsed = parseYaml(yaml) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return {
    data: parsed as Record<string, unknown>,
    body: raw.slice(closingFenceBodyStart(raw, closingStart)).replace(/^[ \t]*\r?\n/, '').replace(/\r\n$/, '\n'),
  }
}

function findClosingFence(raw: string, start: number): number | undefined {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') return lineStart
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

function closingFenceBodyStart(raw: string, closingStart: number): number {
  const nextNewline = raw.indexOf('\n', closingStart)
  return nextNewline < 0 ? raw.length : nextNewline + 1
}
