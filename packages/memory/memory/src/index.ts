/**
 * Claude Code-style file-based memory: the memdir format and parser, the
 * `memory` system-prompt section, and dynamic recall by a forked side-query.
 *
 * All file access goes through the optional `ctx.fs` seam, so a remote or
 * sandboxed backend works unchanged; a providerless host mounts memory as a
 * no-op. Recall needs `ctx.subagents` and a registered one-shot provider;
 * absence of either skips recall without error.
 *
 * @module @jianxx/dsh-cc-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveMemoryHome } from './paths.ts'
import { MemorySection } from './section.ts'
import { MemoryRecall } from './recall.ts'
import { resolveTeamMemoryRoot } from './team.ts'
import { registerMemorySaveTool } from './save.ts'

export { parseMemoryFile } from './parser.ts'
export type { ParsedMemoryFile } from './parser.ts'
export { truncateEntrypointContent, ENTRYPOINT_NAME, MAX_ENTRYPOINT_LINES, MAX_ENTRYPOINT_BYTES } from './truncate.ts'
export type { EntrypointTruncation } from './truncate.ts'
export { MEMORY_TYPES, parseMemoryType } from './types.ts'
export type { MemoryType, MemoryFrontmatter, MemoryIndexEntry } from './types.ts'
export { scanMemoryDirectory } from './scan.ts'
export type { MemoryDirectoryState } from './scan.ts'
export { resolveMemoryHome, resolveProjectMemoryRoot, PROJECT_MEMORY_DIR } from './paths.ts'
export { MemorySection, renderMemorySection, renderTeamMemorySection, saveGuidance, MEMORY_SECTION_NAME, MEMORY_SECTION_ORDER } from './section.ts'
export { MemoryRecall, SubagentMemorySelector, extractSelectedNames, MAX_RECALL_MEMORIES } from './recall.ts'
export type { MemorySelector, RecallCandidate } from './recall.ts'
export { TeamMemoryError, sanitizePathKey, resolveTeamMemoryRoot, validateTeamMemKey, readTeamMemFile, TEAM_MEMORY_DIR, TEAM_ENTRYPOINT_NAME } from './team.ts'
export {
  MEMORY_SAVE_TOOL,
  MemorySaveError,
  pointerLine,
  registerMemorySaveTool,
  renderTopicFile,
  upsertPointer,
} from './save.ts'
export type { MemorySaveArgs } from './save.ts'
export {
  MEMORY_WRITES_SCHEMA,
  WRITEBACK_MAX_FILE_BYTES,
  WRITEBACK_MAX_FILES,
  WRITEBACK_MAX_TOTAL_BYTES,
  memoryWritePolicy,
  validateMemoryWrites,
  writeMemoryFiles,
} from './writeback.ts'
export type { MemoryWrite, MemoryWritePolicy } from './writeback.ts'

export const name = 'memory'
/** Core services required for section registration and event listeners. */
export const inject = ['systemPrompt']

/** Memory plugin configuration. */
export interface Config {
  /** Memory directory root. Defaults to the harness home `memory/`. */
  memoryHome?: string
  /** Whether the `memory` system-prompt section is registered (default true). */
  sectionEnabled?: boolean
  /** Whether dynamic recall runs on pre-step (default true). */
  recallEnabled?: boolean
  /** One-shot subagent provider used by recall (default `fork`). */
  recallProviderName?: string
  /** Optional small-model selection passed to the recall subagent. */
  recallAgentOptions?: unknown
  /**
   * Whether team memory is enabled (default false). Enables a shared
   * per-project team directory (`memoryHome/team`), renders the dual-directory
   * section, and validates all team-memory access. Off by default: onboarding
   * a team directory changes the persisted format and is not safe in
   * multi-tenant or untrusted-writer deployments (see README residual).
   */
  teamEnabled?: boolean
}

export const Config: z<Config> = z.object({
  memoryHome: z.string(),
  sectionEnabled: z.boolean().default(true),
  recallEnabled: z.boolean().default(true),
  recallProviderName: z.string().default('fork'),
  recallAgentOptions: z.any(),
  teamEnabled: z.boolean().default(false),
})

/**
 * Register the `memory` system-prompt section and recall listener.
 * @param ctx - the host context carrying the system-prompt and agent seams.
 * @param config - memory behavior knobs.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // Pass the raw configured root through: resolveMemoryHome appends `memory/`
  // ONLY for undefined/empty — handing it defaultDshHome() here would resolve
  // to the harness home itself and write memory files into its root.
  const dir = resolveMemoryHome(config.memoryHome)
  if (config.sectionEnabled ?? true) {
    const section = new MemorySection(ctx, dir, {
      ...(config.teamEnabled === true ? { teamDir: resolveTeamMemoryRoot(dir) } : {}),
    })
    section.start()
    // The save channel: the memory directory sits outside every session's
    // sandbox writable roots, so direct write/edit always fails; the tool
    // writes host-side instead. No-op on hosts without a tools service.
    registerMemorySaveTool(ctx, dir, section)
    // Re-scan at each turn boundary so host-side writes (memory_save,
    // memory-consolidation's write-back, external edits) surface in the
    // section without a restart; refresh() self-dedupes unchanged content.
    ctx.on('agent/turn-stopping', () => {
      void section.refresh()
    })
  }
  if (config.recallEnabled ?? true) {
    new MemoryRecall(ctx, dir, {
      providerName: config.recallProviderName ?? 'fork',
      enabled: true,
    })
  }
}
