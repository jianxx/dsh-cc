/**
 * Claude Code-compatible Task tool and per-workspace subagent catalog for the
 * DeepSeek Harness. Mounts:
 * - the `subagent_fork` tool (CC display name `Task`) with `subagent_type`
 *   dispatch over the session workspace's `.claude/agents` definitions;
 * - the `Available subagents` system-prompt section rendered per workspace;
 * - the reserved tool names that keep disabled harness rows restrictable;
 * - a pre-step strip listener that removes the harness `agent-instructions`
 *   workspace baseline from delegated children so each child keeps its own
 *   persona instead of also loading the parent's CLAUDE.md / AGENTS.md.
 *
 * The `ccModelRoutes` service (from `@jianxx/dsh-cc-model-aliases`) supplies
 * the spawn-time alias resolver; when absent, every child inherits its
 * parent's route (the builtin fallback).
 *
 * @module @jianxx/dsh-cc-subagent-task
 */

import type { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from './registry.ts'
import { registerTaskTool } from './tool.ts'
import { mountAgentCatalog } from './catalog.ts'
import { mountStripWorkspaceInstructions } from './strip-instructions.ts'

export { AgentRegistry } from './registry.ts'
export { registerTaskTool, TASK_TOOL } from './tool.ts'
export { mountAgentCatalog } from './catalog.ts'
export {
  mountStripWorkspaceInstructions,
  isDelegated,
  isAgentInstructions,
} from './strip-instructions.ts'

/** Cordis plugin id. */
export const name = 'cc-subagent-task'

/**
 * Mount the Task tool, the agents catalog, and the workspace-instruction
 * strip. Safe when either the tools or the system-prompt seam is absent
 * (the corresponding mount skips); the pre-step listener only needs
 * `ctx.on`, so it mounts regardless.
 * @param ctx - the plug context.
 */
export function apply(ctx: Context): void {
  const registry = new AgentRegistry()
  registerTaskTool(ctx, registry)
  mountAgentCatalog(ctx, registry)
  mountStripWorkspaceInstructions(ctx)
}
