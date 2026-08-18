/**
 * The `memory` system-prompt section: save-channel guidance, entrypoint
 * content (truncated), an index of topic files by frontmatter, and grep
 * search guidance. When `teamEnabled` is set, a combined section surfaces
 * both the private and the team directory. The section text is assembled
 * synchronously, so a background scan through `ctx.fs` caches the rendered
 * text and emits `system-prompt/change` to re-assemble once the entrypoint
 * and index are read. The section always renders (a memoryless session shows
 * a placeholder) so the save guidance never disappears.
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
  private readonly teamDir: string | undefined

  /**
   * Create a cache holder bounded to a memory directory.
   * @param ctx - the host context whose `fs` seam and `system-prompt/change`
   *   channel drive refresh.
   * @param dir - the memory directory to scan for the entrypoint and index.
   * @param options - when `teamDir` is set, render the combined private + team
   *   section and scan both directories.
   */
  constructor(
    private readonly ctx: Context,
    private readonly dir: string,
    options: { teamDir?: string } = {},
  ) {
    this.teamDir = options.teamDir
  }

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
    if (this.teamDir === undefined) {
      const state = await scanMemoryDirectory(fileSystem, this.dir)
      const rendered = renderMemorySection(this.dir, state)
      if (rendered === this.cached) return
      this.cached = rendered
      this.ctx.emit('system-prompt/change')
      return
    }
    const [privateState, teamState] = await Promise.all([
      scanMemoryDirectory(fileSystem, this.dir),
      scanMemoryDirectory(fileSystem, this.teamDir),
    ])
    const rendered = renderTeamMemorySection(this.dir, this.teamDir, privateState, teamState)
    if (rendered === this.cached) return
    this.cached = rendered
    this.ctx.emit('system-prompt/change')
  }
}

/**
 * The save-channel guidance every memory section carries. It names the ONLY
 * working save path: direct write/edit calls under the memory directory are
 * fenced by the fs sandbox (the directory lives outside every session
 * workspace), so the model must call `memory_save` instead. Without this
 * line a memoryless session presents no guidance at all and the model falls
 * back to its Claude Code prior (`~/.claude/projects/<slug>/memory/`), whose
 * writes fail the same fence.
 * @param dir - the private memory directory surfaced for saves.
 * @returns the guidance lines.
 */
export function saveGuidance(dir: string): string[] {
  return [
    `To save a durable fact, call the \`memory_save\` tool — it writes the topic file and updates ${ENTRYPOINT_NAME} for you. Never write or edit files under \`${dir}\` directly: the sandbox fences writes outside the session workspace, so direct writes always fail.`,
  ]
}

/**
 * Render the memory section text from an observed directory state. The
 * section is ALWAYS present (even with no memories) so the save guidance is
 * stable model-visible context; an empty directory renders a placeholder
 * entrypoint body.
 * @param dir - the memory directory, surfaced to the model for writes.
 * @param state - the scanned entrypoint and topic index.
 * @returns the rendered section.
 */
export function renderMemorySection(dir: string, state: MemoryDirectoryState): string {
  const entrypoint = state.entrypoint?.trim()
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
    ...saveGuidance(dir),
    '',
    `## ${ENTRYPOINT_NAME}`,
    '',
    entrypoint !== undefined && entrypoint.length > 0 ? truncateEntrypointContent(entrypoint).content : '(no memories yet)',
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

/**
 * Render the combined team-memory section text from both observed directory
 * states. Surfaces the dual-directory (private + team) scope guidance, the
 * save-channel guidance, both entrypoints, a scope-tagged topic index, and
 * grep search guidance. Always renders (placeholders when empty) so the save
 * guidance never disappears.
 * @param privateDir - the private memory directory, surfaced for writes.
 * @param teamDir - the shared team memory directory.
 * @param privateState - the scanned private entrypoint and topic index.
 * @param teamState - the scanned team entrypoint and topic index.
 * @returns the combined section.
 */
export function renderTeamMemorySection(
  privateDir: string,
  teamDir: string,
  privateState: MemoryDirectoryState,
  teamState: MemoryDirectoryState,
): string {
  const privateEntry = privateState.entrypoint?.trim()
  const teamEntry = teamState.entrypoint?.trim()
  const lines = [
    '# Memory',
    '',
    `You have a persistent, file-based memory system with two directories: a private directory at \`${privateDir}\` and a shared team directory at \`${teamDir}\`.`,
    '',
    'There are two scope levels:',
    `- private: memories private between you and the current user, stored at the root \`${privateDir}\`.`,
    `- team: memories shared with and contributed by all users of this project, stored at \`${teamDir}\`.`,
    '',
    'Each directory keeps its own index and topic files. Save each memory to the directory matching its scope; never write memory content directly into a MEMORY.md.',
    '',
    ...saveGuidance(privateDir),
    '',
    `## ${ENTRYPOINT_NAME} (private)`,
    '',
    privateEntry !== undefined && privateEntry.length > 0 ? renderEntrypointBody(privateEntry) : '(empty)',
    '',
    `## ${ENTRYPOINT_NAME} (team)`,
    '',
    teamEntry !== undefined && teamEntry.length > 0 ? renderEntrypointBody(teamEntry) : '(empty)',
  ]
  const index = renderCombinedIndex(privateState.topics, teamState.topics)
  if (index.length > 0) lines.push(...index)
  const search = topLevelSearch(privateDir, teamDir, privateState.topics, teamState.topics)
  if (search.length > 0) lines.push(...search)
  return lines.join('\n')
}

function renderEntrypointBody(entrypoint: string): string {
  return truncateEntrypointContent(entrypoint).content
}

/** A combined topic index with each scope tagged, sorted by filename. */
function renderCombinedIndex(
  privateTopics: readonly MemoryIndexEntry[],
  teamTopics: readonly MemoryIndexEntry[],
): string[] {
  const combined = [
    ...privateTopics.map(topic => ({ ...topic, scope: 'private' as const })),
    ...teamTopics.map(topic => ({ ...topic, scope: 'team' as const })),
  ]
  if (combined.length === 0) return []
  combined.sort((a, b) => a.filename.localeCompare(b.filename))
  const lines = combined.map((topic) => {
    const type = topic.frontmatter.type === undefined ? '' : ` [${topic.frontmatter.type}]`
    return `- [${escapeLinkText(topic.frontmatter.name)}](${topic.filename}) — ${topic.frontmatter.description} (${topic.scope})${type}`
  })
  return ['', '## Memory index (private + team)', '', ...lines]
}

function topLevelSearch(
  privateDir: string,
  teamDir: string,
  privateTopics: readonly MemoryIndexEntry[],
  teamTopics: readonly MemoryIndexEntry[],
): string[] {
  if (privateTopics.length === 0 && teamTopics.length === 0) return []
  return [
    '',
    '## Searching past context',
    'When a MEMORY.md entry is not enough, search topic files and the transcript log with narrow terms (error messages, file paths, function names):',
    '```',
    `grep -rn "<search term>" ${privateDir}/ ${teamDir}/ --include="*.md"`,
    '```',
  ]
}

function escapeLinkText(name: string): string {
  return name.replace(/[\\[\]]/g, '\\$&')
}
