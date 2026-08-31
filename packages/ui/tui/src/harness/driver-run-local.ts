/**
 * /export-md, /copy, local slash-command (runLocal) and host-command
 * (runHarness) pipeline of the in-process protocol driver.
 *
 * Moved out of harness/driver.ts's createDriver factory so the factory stays
 * under the line budget. All shared state arrives on `rt` (DriverRunLocalCtx)
 * and is read through getters / by-reference holders — never a stale snapshot —
 * because createDriver rebinds `state` on every emit.
 *
 * @module @jianxx/dsh-cc-tui/harness/driver-run-local
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { rowsToMarkdown } from '../export-markdown.ts'
import { defaultExportDir, exportStamp } from './shell-output.ts'
import {
  breakdownOf,
  formatCostReport,
  occupancyOf,
  totalsOf,
  usageViewOf,
} from './usage-view.ts'
import { parseModelChoice } from '../model-catalog.ts'
import { parseEffortChoice } from '../effort-catalog.ts'
import { shortenSession } from '../statusline.ts'
import { clearRows, openUsagePanel, upsertRow } from '../store.ts'
import type {
  ContextPressureStateLike,
  TokenUsageStateLike,
} from '../state/driver-types.ts'
import type { DriverRunLocalCtx } from './driver-ctx.ts'

/** Host slash-command registry surface runHarness dispatches through. */
type CommandsLike = {
  execute(
    agent: Agent,
    line: string,
    images: readonly unknown[],
    signal: AbortSignal,
  ): Promise<{ result?: { kind: string; text?: string } } | undefined>
}

/**
 * OSC 52 clipboard-write prefix: `ESC ] 52 ; c ;` + base64 payload, closed
 * with BEL. The sequence is zero-width — writing it inline never disturbs the
 * rendered frame. Only /copy uses it.
 */
const OSC52_PREFIX = '\x1b]52;c;'

export interface RunLocalSection {
  exportTranscript(rawInput: string): void
  copyLatestReply(): void
  runLocal(name: string, rawInput: string): Promise<void>
  runHarness(line: string): Promise<{ kind: string; text?: string } | undefined | null>
}

export function createRunLocalSection(rt: DriverRunLocalCtx): RunLocalSection {
  const { emit, showNotice } = rt

  // --- /export-md: local transcript utilities --------------------------------
  // /export-md serializes the live rows via rowsToMarkdown — an explicit path
  // is resolved against the session cwd; no argument lands under the export
  // dir as <sessionId>-<timestamp>.md. Failures degrade to a notice, never a
  // throw into the composer path.
  const exportTranscript = (rawInput: string): void => {
    const target = rawInput.length > 0
      ? resolve(rt.cwd, rawInput)
      : join(rt.config.exportDir ?? defaultExportDir(), `${String(rt.current.agent.session.id)}-${exportStamp()}.md`)
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, rowsToMarkdown(rt.state().rows))
      showNotice(`Exported to ${target}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      showNotice(`Export failed: ${message}`)
    }
  }

  // /copy re-emits the latest assistant reply through an OSC 52 sequence so
  // the terminal itself owns the clipboard (no child process, no permissions).
  // The write sink is injected; without a sink the command still reports — it
  // just has nowhere to hand the payload.
  const copyLatestReply = (): void => {
    const last = [...rt.state().rows].reverse().find(row => row.kind === 'assistant')
    if (last === undefined || last.kind !== 'assistant' || last.text.trim().length === 0) {
      showNotice('Nothing to copy yet — no assistant reply in the transcript.')
      return
    }
    const payload = Buffer.from(last.text, 'utf8').toString('base64')
    rt.config.copyWrite?.(`${OSC52_PREFIX}${payload}\x07`)
    showNotice('Copied latest reply')
  }

  const runLocal = async (name: string, rawInput: string): Promise<void> => {
    if (name === 'quit' || name === 'exit') {
      if (rt.getMarkedContent()) rt.persistResumeTarget()
      await rt.current.handle.dispose()
      return
    }
    if (name === 'clear') {
      emit(clearRows(rt.state()))
      return
    }
    if (name === 'tui-help') {
      emit(upsertRow(rt.state(), {
        kind: 'status',
        text: 'Shift+Tab cycles permission modes. /permissions opens the mode picker. /model lists adapters. /agents lists subagent activity. /resume lists sessions. /quit exits.',
      }))
      return
    }
    if (name === 'resume') {
      if (rawInput.length > 0) {
        await rt.switchSession(rawInput)
        return
      }
      await rt.openSessionSwitcher()
      return
    }
    if (name === 'model') {
      if (rawInput.length === 0) {
        await rt.openModelPicker()
        return
      }
      const catalog = await rt.loadCatalog()
      const chosen = parseModelChoice(rawInput, catalog)
      if (chosen === undefined) {
        showNotice(`Unknown model "${rawInput}". Try /model for the catalog.`)
        return
      }
      // Validates + preserves a carried effort when possible (never blocks the
      // switch itself — see applyModelSwitch).
      await rt.applyModelSwitch(chosen.provider, chosen.model)
    }
    if (name === 'effort') {
      if (rawInput.length === 0) {
        await rt.openEffortPicker()
        return
      }
      const route = rt.selection.current
      if (route === undefined) {
        emit(upsertRow(rt.state(), { kind: 'status', text: 'No model configured. Use /model first.' }))
        return
      }
      // `default` is a reserved keyword (it wins even over a model effort
      // literally named "default"): reset to the bare pair with ZERO
      // validation and zero adapter calls — the provider default is always
      // legal, even when the llm service is unreachable.
      if (parseEffortChoice(rawInput, [])?.kind === 'default') {
        rt.selection.current = { provider: route.provider, model: route.model }
        emit(upsertRow(rt.state(), { kind: 'status', text: 'Reasoning effort reset to the provider default.' }))
        return
      }
      // Fail closed: resolve before validating — selection must never hold an
      // effort the llm layer would reject.
      const efforts = await rt.resolveEfforts(route.provider, route.model)
      if (efforts === undefined || efforts.length === 0) {
        emit(upsertRow(rt.state(), { kind: 'status', text: `Cannot resolve effort levels for ${route.model}.` }))
        return
      }
      const choice = parseEffortChoice(rawInput, efforts.map(level => level.id))
      // `choice.kind === 'default'` cannot occur here: the reserved keyword
      // already returned above, so anything non-level is unknown.
      if (choice?.kind !== 'level') {
        emit(upsertRow(rt.state(), {
          kind: 'status',
          text: `Unknown effort "${rawInput.trim()}" for ${route.model}. Try /effort.`,
        }))
        return
      }
      const level = efforts.find(candidate => candidate.id === choice.level)!
      // Single branding seam: view layers stay plain strings.
      rt.selection.current = {
        provider: route.provider,
        model: route.model,
        reasoningEffort: ReasoningEffortId(level.id),
      }
      // User-facing text carries the effort NAME, not the raw id.
      emit(upsertRow(rt.state(), { kind: 'status', text: `Reasoning effort is now ${level.name}.` }))
    }
    if (name === 'cost') {
      const totals = rt.projections === undefined
        ? undefined
        : totalsOf(rt.projections.stateOf(rt.current.agent.session, 'tokenUsage') as TokenUsageStateLike | undefined)
      emit(upsertRow(rt.state(), { kind: 'status', text: formatCostReport(totals) }))
      return
    }
    if (name === 'usage') {
      // Seed from the live projections before opening: a resumed session (or
      // one with no projection change since boot) already holds data the
      // change feed has never delivered. From here on the onChanged feed
      // keeps the snapshot fresh, so an open panel refreshes live.
      if (rt.projections !== undefined) {
        rt.applyUsage(usageViewOf(
          totalsOf(rt.projections.stateOf(rt.current.agent.session, 'tokenUsage') as TokenUsageStateLike | undefined),
          occupancyOf(rt.projections.stateOf(rt.current.agent.session, 'contextPressure') as ContextPressureStateLike | undefined),
          breakdownOf(rt.projections.stateOf(rt.current.agent.session, 'contextBreakdown')),
        ))
      }
      emit(openUsagePanel(rt.state()))
      return
    }
    if (name === 'agents') {
      const runs = rt.state().subagents
      if (runs.length === 0) {
        emit(upsertRow(rt.state(), { kind: 'status', text: 'No subagent activity this session.' }))
        return
      }
      const lines = ['Subagent activity:']
      for (const run of runs) {
        const marker = run.status === 'running' ? '●' : '✓'
        const short = shortenSession(run.sessionId)
        const reason = run.stopReason === undefined ? '' : ` [${run.stopReason}]`
        lines.push(`  ${marker} ${run.provider} · ${short}${reason}`)
      }
      emit(upsertRow(rt.state(), { kind: 'status', text: lines.join('\n') }))
      return
    }
    if (name === 'export-md') {
      exportTranscript(rawInput)
      return
    }
    if (name === 'copy') {
      copyLatestReply()
      return
    }
  }

  /**
   * Execute a slash command line through the host registry and echo its
   * result text as a status row. Tri-state return:
   * - `null` — no command registry is mounted (already noticed here).
   * - `undefined` — the registry matched nothing (the caller decides the notice).
   * - otherwise the command result.
   */
  const runHarness = async (line: string): Promise<{ kind: string; text?: string } | undefined | null> => {
    const commands = rt.ctx.get('commands') as CommandsLike | undefined
    if (commands === undefined) {
      showNotice('No command registry is mounted.')
      return null
    }
    const execution = await commands.execute(rt.current.agent, line, [], new AbortController().signal)
    const result = execution?.result
    if (result !== undefined && result.text !== undefined && result.text.length > 0) {
      emit(upsertRow(rt.state(), { kind: 'status', text: result.text }))
    }
    return result
  }

  return { exportTranscript, copyLatestReply, runLocal, runHarness }
}
