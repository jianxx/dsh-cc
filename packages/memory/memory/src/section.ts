/**
 * The `memory` system-prompt section: entrypoint content (truncated), an
 * index of topic files by frontmatter, and grep search guidance. The section
 * text is assembled synchronously, so a background scan through `ctx.fs`
 * caches the rendered text and emits `system-prompt/change` to re-assemble
 * once the entrypoint and index are read. When MEMORY.md is absent the
 * section renders empty (no error).
 * @module @jianxx/dsh-cc-memory/section
 */

import type { Context } from '@deepseek-ai/cordis'
import { ENTRYPOINT_NAME, truncateEntrypointContent } from './truncate.ts'
import { scanMemoryDirectory } from './scan.ts'
import type { MemoryDirectoryState } from './scan.ts'
import type { MemoryIndexEntry } from './types.ts'

/** Default order slot for the memory section (before tool guidance). */
export const MEMORY_SECTION_ORDER = 90

/** The section's unique name. */
export const MEMORY_SECTION_NAME = 'memory'

/**
 * Owner of the cached `memory` section text. Holds the rendered string so the
 * synchronous section provider can read it, and refreshes it from disk.
 */
export class MemorySection {
  private cached = ''
  private refresher: Promise<void> | undefined

  /**
   * Create a cache holder bounded to a memory directory.
   * @param ctx - the host context whose `fs` seam and `system-prompt/change`
   *   channel drive refresh.
   * @param dir - the memory directory to scan for the entrypoint and index.
   */
  constructor(
    private readonly ctx: Context,
    private readonly dir: string,
  ) {}

  /** Register the `memory` section and start the first background scan. */
  start(): void {
    this.ctx.systemPrompt.section({
      name: MEMORY_SECTION_NAME,
      order: MEMORY_SECTION_ORDER,
      text: (): string => this.cached,
    })
    void this.refresh()
  }

  /**
   * Rebuild the cached section text. Safe to call again while a scan is in
   * flight (overlapping scans share one background promise). Emits
   * `system-prompt/change` only when the rendered text actually changed, so an
   * unchanged disk does not churn reassembly.
   */
  refresh(): Promise<void> {
    const previous = this.refresher
    if (previous === undefined) {
      const current = this.run()
      this.refresher = current
      void current.finally(() => {
        if (this.refresher === current) this.refresher = undefined
      })
      return current
    }
    previous.catch(() => {})
    return previous
  }

  /** The last rendered section text (empty until the first scan resolves). */
  text(): string {
    return this.cached
  }

  private async run(): Promise<void> {
    const fileSystem = this.ctx.get('fs')
    if (fileSystem === undefined) return
    const state = await scanMemoryDirectory(fileSystem, this.dir)
    const rendered = renderMemorySection(this.dir, state)
    if (rendered === this.cached) return
    this.cached = rendered
    this.ctx.emit('system-prompt/change')
  }
}

/**
 * Render the memory section text from an observed directory state. Returns
 * empty when there is no entrypoint content, so a memoryless session presents
 * no memory section.
 * @param dir - the memory directory, surfaced to the model for writes.
 * @param state - the scanned entrypoint and topic index.
 * @returns the rendered section, or `''` when the entrypoint is empty.
 */
export function renderMemorySection(dir: string, state: MemoryDirectoryState): string {
  const entrypoint = state.entrypoint?.trim()
  if (entrypoint === undefined || entrypoint.length === 0) return ''
  const t = truncateEntrypointContent(entrypoint)
  const index = renderIndex(state.topics)
  const search = state.topics.length > 0
    ? [
      '',
      '## Searching past context',
      'When a MEMORY.md entry is not enough, search topic files and the transcript log with narrow terms (error messages, file paths, function names):',
      '```',
      `grep -rn "<search term>" ${dir}/ --include="*.md"`,
      '```',
    ]
    : []
  return [
    '# Memory',
    '',
    `You have a persistent, file-based memory system at \`${dir}\`. Use it to recall context across conversations and to save durable facts.`,
    '',
    `## ${ENTRYPOINT_NAME}`,
    '',
    t.content,
    ...index,
    ...search,
  ].join('\n')
}

function renderIndex(topics: readonly MemoryIndexEntry[]): string[] {
  if (topics.length === 0) return []
  const lines = topics.map((topic) => {
    const type = topic.frontmatter.type === undefined ? '' : ` [${topic.frontmatter.type}]`
    return `- [${escapeLinkText(topic.frontmatter.name)}](${topic.filename}) — ${topic.frontmatter.description}${type}`
  })
  return ['', '## Memory index', '', ...lines]
}

function escapeLinkText(name: string): string {
  return name.replace(/[\\[\]]/g, '\\$&')
}
