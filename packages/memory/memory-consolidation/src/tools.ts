/**
 * Model-facing tool restrictions for memory subagents.
 *
 * Extraction and dream forks may read/review broadly, may write only files in
 * the memory directory, and must not run arbitrary computation. `ctx.tools.restrict`
 * works by tool name, and validates against the harness-registered names, so this
 * allow-list holds those harness tool names plus the memory-writing file tools;
 * path-scoping of write/edit is enforced by the prompt contract and the targeted
 * review task, not by the name-level gate.
 *
 * `read_image` pairs with `read` to mirror Claude Code's `Read`, which covers both
 * text and images (the harness splits image reading into its own tool).
 * @module @jianxx/dsh-cc-memory-consolidation/tools
 */

/** Harness tool names a memory subagent may exercise. */
export const MEMORY_AGENT_TOOLS: readonly string[] = [
  'read',
  'read_image',
  'grep',
  'glob',
  'write',
  'edit',
]

/** A `toolFilter` value usable as a subagent-start request restriction. */
export const MEMORY_TOOL_FILTER: { allow: readonly string[] } = {
  allow: MEMORY_AGENT_TOOLS,
}
