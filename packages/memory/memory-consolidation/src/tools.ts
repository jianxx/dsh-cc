/**
 * Model-facing tool restrictions for memory subagents.
 *
 * Extraction and dream forks may READ/review broadly, may WRITE only files in
 * the memory directory, and must not run arbitrary computation. `ctx.tools.restrict`
 * works by tool name, so the allow-list is the set of read/search tools plus
 * the memory-writing file tools; path-scoping of Write/Edit is enforced by the
 * prompt contract and the targeted review task, not by the name-level gate.
 * @module @jianxx/dsh-cc-memory-consolidation/tools
 */

/** Tool names a memory subagent may exercise. */
export const MEMORY_AGENT_TOOLS: readonly string[] = [
  'Read',
  'Grep',
  'Glob',
  'Write',
  'Edit',
]

/** A `toolFilter` value usable as a subagent-start request restriction. */
export const MEMORY_TOOL_FILTER: { allow: readonly string[] } = {
  allow: MEMORY_AGENT_TOOLS,
}
