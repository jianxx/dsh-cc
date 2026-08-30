import { describe, expect, it } from 'vitest'
import { loadStandardTrajectory, parseTrajectory } from '../src/index.ts'

/** The built-in standard trajectory must itself satisfy the schema guards. */
describe('standard trajectory', () => {
  const trajectory = loadStandardTrajectory()

  it('parses against the trajectory schema', () => {
    expect(() => parseTrajectory(JSON.parse(JSON.stringify(trajectory)))).not.toThrow()
    expect(trajectory.schemaVersion).toBe(1)
    expect(trajectory.id).toBe('standard')
  })

  it('carries a persona well past the 64-token cache-block granularity', () => {
    // ~4 chars/token as a coarse floor: 64 tokens ≈ 256 chars; the benchmark
    // persona must clear that from the first request by a wide margin.
    expect(trajectory.persona.length).toBeGreaterThan(1024)
  })

  it('forces a tool call on the first turn only', () => {
    expect(trajectory.turns[0]?.expectToolCall).toBe(true)
    expect(trajectory.turns.slice(1).every(turn => !turn.expectToolCall)).toBe(true)
  })

  it('runs 3-4 turns with a request-count floor covering the forced first turn', () => {
    expect(trajectory.turns.length).toBeGreaterThanOrEqual(3)
    expect(trajectory.turns.length).toBeLessThanOrEqual(4)
    // Turn 1 contributes ≥2 requests (tool call + answer), the rest ≥1 each.
    expect(trajectory.minRequests).toBeGreaterThanOrEqual(trajectory.turns.length + 1)
  })

  it('uses conservative soft floors with the session gate above the per-request gate', () => {
    const { perRequestMinRate, sessionMinRate } = trajectory.thresholds
    expect(perRequestMinRate).toBeGreaterThanOrEqual(0)
    expect(perRequestMinRate).toBeLessThan(sessionMinRate)
    expect(sessionMinRate).toBeLessThanOrEqual(1)
  })

  it('registers at least one deterministic content tool', () => {
    expect(trajectory.tools.length).toBeGreaterThanOrEqual(1)
    for (const tool of trajectory.tools) {
      expect(tool.resultText).toMatch(/\{/)
    }
  })
})
