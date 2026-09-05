import { describe, expect, it } from 'vitest'
import { buildStatusLinePayload, type StatusLinePayloadView } from '../src/harness/statusline-payload.ts'

/** A minimal concrete view; individual tests spread overrides over it. */
function view(overrides: Partial<StatusLinePayloadView> = {}): StatusLinePayloadView {
  return {
    version: '0.4.1-test',
    bindTimeMs: 1_000_000,
    nowMs: 1_005_000,
    ...overrides,
  }
}

describe('buildStatusLinePayload', () => {
  it('emits the full CC-shaped payload from a full view', () => {
    const payload = buildStatusLinePayload(view({
      sessionId: 'sess-1',
      sessionCwd: '/repo/sub',
      driverCwd: '/repo',
      projectDir: '/repo',
      transcriptPath: '/home/.dsh/sessions/sess-1.jsonl',
      model: 'deepseek-v3',
      effort: 'high',
      outputStyleName: 'explanatory',
      gitWorktree: 'status-line',
      worktree: { name: 'status-line', path: '/repo/.claude/worktrees/status-line', branch: 'worktree-status-line' },
      inputTokens: 123_456,
      outputTokens: 2_345,
      contextWindowTokens: 200_000,
      pressureTokens: 130_000,
      sessionCreatedAtMs: 900_000,
    }))
    expect(payload).toEqual({
      cwd: '/repo/sub',
      session_id: 'sess-1',
      transcript_path: '/home/.dsh/sessions/sess-1.jsonl',
      model: { id: 'deepseek-v3', display_name: 'deepseek-v3' },
      workspace: {
        current_dir: '/repo/sub',
        project_dir: '/repo',
        added_dirs: [],
        git_worktree: 'status-line',
      },
      version: '0.4.1-test',
      output_style: { name: 'explanatory' },
      cost: { total_duration_ms: 105_000 },
      context_window: {
        total_input_tokens: 123_456,
        total_output_tokens: 2_345,
        context_window_size: 200_000,
        used_percentage: 65,
        remaining_percentage: 35,
      },
      exceeds_200k_tokens: false,
      effort: { level: 'high' },
      worktree: { name: 'status-line', path: '/repo/.claude/worktrees/status-line', branch: 'worktree-status-line' },
    })
  })

  it('drops absent sources field-by-field and drops empty sub-objects wholesale', () => {
    const payload = buildStatusLinePayload(view())
    // Only truthfully-sourced fields survive; absent ones are dropped.
    expect(payload).toEqual({
      // The bind-time duration fallback is still truthful, so `cost` stays.
      cost: { total_duration_ms: 5_000 },
      workspace: { added_dirs: [] },
      version: '0.4.1-test',
      exceeds_200k_tokens: false,
    })
    expect('cwd' in payload).toBe(false)
    expect('model' in payload).toBe(false)
    expect('context_window' in payload).toBe(false)
    expect('effort' in payload).toBe(false)
    expect('session_id' in payload).toBe(false)
    expect('transcript_path' in payload).toBe(false)
    expect('output_style' in payload).toBe(false)
    expect('worktree' in payload).toBe(false)
  })
})

describe('exceeds_200k_tokens boundary (uncached input total)', () => {
  it('is false at 200000 and true at 200001', () => {
    expect(buildStatusLinePayload(view({ inputTokens: 200_000 })).exceeds_200k_tokens).toBe(false)
    expect(buildStatusLinePayload(view({ inputTokens: 200_001 })).exceeds_200k_tokens).toBe(true)
  })

  it('ignores cache totals — only the input total decides', () => {
    expect(buildStatusLinePayload(view({ inputTokens: 5, outputTokens: 500_000 })).exceeds_200k_tokens).toBe(false)
  })
})

describe('cost.total_duration_ms', () => {
  it('derives from the session createdAt, not the bind time', () => {
    // bind→now is 5s, session createdAt→now is 105s: the session clock wins.
    const payload = buildStatusLinePayload(view({ sessionCreatedAtMs: 900_000 }))
    expect(payload.cost).toEqual({ total_duration_ms: 105_000 })
  })

  it('falls back to bind time when the session carries no createdAt', () => {
    const payload = buildStatusLinePayload(view())
    expect(payload.cost).toEqual({ total_duration_ms: 5_000 })
  })
})

describe('context_window percentages', () => {
  it('derives used/remaining from pressure over window', () => {
    const payload = buildStatusLinePayload(view({
      contextWindowTokens: 200_000,
      pressureTokens: 130_000,
    }))
    expect(payload.context_window).toMatchObject({ used_percentage: 65, remaining_percentage: 35 })
  })

  it('drops the whole sub-object when only percentages are unknown', () => {
    const payload = buildStatusLinePayload(view({ pressureTokens: 1_000 }))
    expect('context_window' in payload).toBe(false)
  })
})

describe('JSON round-trip', () => {
  it('stays small and survives a round-trip unchanged', () => {
    const payload = buildStatusLinePayload(view({
      sessionId: 'sess-1',
      sessionCwd: '/repo/sub',
      model: 'deepseek-v3',
      inputTokens: 123_456,
      contextWindowTokens: 200_000,
      pressureTokens: 130_000,
    }))
    const text = JSON.stringify(payload)
    expect(text.length).toBeLessThan(2 * 1024)
    expect(JSON.parse(text)).toEqual(payload)
  })
})
