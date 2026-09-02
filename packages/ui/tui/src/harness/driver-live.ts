/**
 * Live session folds shared by the driver factory and its sections: the
 * effective permission mode (plan overlay, else the durable override) and the
 * LIVE session working directory (the session-cwd plugin's durable
 * `worktree/entered` fold, then the boot-time header cwd).
 *
 * @module @jianxx/dsh-cc-tui/harness/driver-live
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { foldPlanMode } from '@deepseek-ai/dsh-plan-mode'
import { foldPermissionMode } from '@jianxx/dsh-cc-permission-rules'
import { foldSessionCwd } from '@jianxx/dsh-cc-session-cwd'

export function liveMode(agent: Agent, fallback: string): string {
  if (foldPlanMode(agent.session.events)) return 'plan'
  return foldPermissionMode(agent.session.events) ?? fallback
}

/**
 * The LIVE session working directory: the session-cwd plugin's durable
 * `worktree/entered` fold first (authoritative across EnterWorktree/
 * ExitWorktree moves), then the boot-time header cwd.
 */
export function liveSessionCwd(agent: Agent, fallback: string): string {
  return foldSessionCwd(agent.session.events) ?? agent.session.header.cwd ?? fallback
}
