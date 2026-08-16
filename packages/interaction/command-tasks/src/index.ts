/**
 * Human-facing `/tasks` command: list the caller-visible background jobs (id,
 * kind, status, start time, and producer label). It reads the injected `jobs`
 * service; an empty visible set renders a friendly placeholder. (Todo-style
 * items are out of scope — they live outside the background-job registry.)
 * @module @jianxx/dsh-cc-command-tasks
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { formatJobs, type JobLine } from './tasks.ts'

export const name = 'command-tasks'
export const inject = ['commands', 'jobs']

/** Map a background-job snapshot to the fields this command renders. */
function toLine(job: JobSnapshot): JobLine {
  return {
    id: String(job.id),
    kind: job.kind,
    status: job.status,
    startedAt: job.startedAt,
    ...job.label.length > 0 ? { label: job.label } : {},
  }
}

/** Execute `/tasks`: list the caller-visible background jobs. */
function executeTasks(ctx: Context, invocation: CommandInvocation): CommandResult {
  const jobs = ctx.jobs.list(invocation.agent)
  return { kind: 'success', text: formatJobs(jobs.map(toLine)) }
}

/**
 * Register the `/tasks` command for every composed command adapter.
 * @param ctx - context carrying the command registry and jobs service.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'tasks',
    description: 'list background jobs and their status',
    handler: (invocation: CommandInvocation) => executeTasks(ctx, invocation),
  })
}
