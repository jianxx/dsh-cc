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

/** Section name for the background-subagent contract. */
export const BACKGROUND_SECTION_NAME = 'cc:subagent-background'

/** Order slot beside the catalog section (tool guidance owns 100–199). */
const BACKGROUND_SECTION_ORDER = 112

export const BACKGROUND_SECTION_TEXT = [
  '## Background subagents',
  '',
  '- Heuristic: if this turn\'s answer to the human depends on the child, omit `run_in_background`',
  '  (foreground — the call waits for the final text). If the human can keep talking while the',
  '  child works, pass `run_in_background: true`: the call returns promptly with a durable',
  '  `agentId` once the child accepts its first turn. Synthesize on the wake; do not poll.',
  '- A definition with `background: true` backgrounds on omit. Pass `run_in_background: false`',
  '  when this turn needs that child\'s result — explicit true/false always win over the pin.',
  '- A background child\'s report — or its finish notice when it ends without reporting — arrives',
  '  as a waking message; do not poll.',
  '- Control the child by that id: `list_agents` for status, `send_message` to continue the same',
  '  conversation (only the agent that started the child may continue it), `interrupt_agent` to',
  '  stop its current turn.',
  '- `subagent_type: "fork"` cannot run in the background (upstream harness issue #2124); use a',
  '  plain background spawn instead.',
  '- Exiting your session drains a background child\'s in-flight turn; its persisted session',
  '  survives and cold-resumes on the next `send_message`.',
].join('\n')

/**
 * Register the static background-loop system-prompt section (same contract the
 * Task tool description teaches, stated once so it survives description
 * trimming). No-op when the system-prompt seam is absent.
 * @param ctx - the plug context.
 * @returns the section disposer, or undefined when the seam is absent.
 */
export function mountBackgroundSection(ctx: Context): (() => void) | undefined {
  const seam = ctx.get('systemPrompt') as {
    section(def: { name: string; order: number; text: string }): () => void
  } | undefined
  if (seam === undefined) return undefined
  return seam.section({
    name: BACKGROUND_SECTION_NAME,
    order: BACKGROUND_SECTION_ORDER,
    text: BACKGROUND_SECTION_TEXT,
  })
}

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
  mountBackgroundSection(ctx)
  mountStripWorkspaceInstructions(ctx)
}
