/**
 * Exhaustive pure-layer matrix for the resume gate (plan §4.6 steps 0-5):
 * each step's pass/block/notice/policy variants, degraded (`complete:false`)
 * pins, explicit-absence drift (a later-introduced adapter default), and
 * alias drift. Pure only — persistence of deny outcomes is the plugin's
 * durability ordering and is asserted by the integration suite.
 */
import { describe, expect, it } from 'vitest'
import { evaluateGate, type GateEnv } from '../src/gate.ts'
import { RESUME_POLICY_DEFAULTS, readResumePolicy, type ResumePolicy } from '../src/policy.ts'
import type { ResumePin } from '../src/pin.ts'
import type { CorruptPin } from '../src/store.ts'

function makePin(overrides: Partial<ResumePin> = {}): ResumePin {
  return {
    version: 1,
    childId: 'child-1',
    parentSessionId: 'parent',
    label: 'research',
    mode: 'continuable-background',
    createdAt: '2026-09-04T00:00:00.000Z',
    definition: { kind: 'plain' },
    modelSelector: { raw: 'inherit', via: 'inherit' },
    effective: {
      provider: 'mock',
      model: 'mock',
      reasoningEffort: 'high',
      maxTokens: 5555,
      complete: true,
    },
    toolFilter: { allow: [], deny: [] },
    workspace: { cwd: '/ws', gitDir: '.git', gitCommonDir: '.git', branch: 'main' },
    resume: { state: 'ok' },
    ...overrides,
  }
}

function makeEnv(overrides: Partial<GateEnv> = {}): GateEnv {
  return {
    sessionExists: true,
    cwdExists: true,
    currentGit: { gitDir: '.git', gitCommonDir: '.git', branch: 'main' },
    currentDefinitionFingerprint: null,
    restrictableNames: new Set(['read', 'send_message']),
    resolveCallConfig: async config => ({ ...config, provider: config.provider, model: config.model }),
    resolveDetailed: selector => ({ selector, via: 'literal', route: { model: selector } }),
    currentRoute: { provider: 'mock', model: 'mock' },
    ...overrides,
  }
}

const noticePolicy: ResumePolicy = RESUME_POLICY_DEFAULTS
const blockChanged: ResumePolicy = { ...RESUME_POLICY_DEFAULTS, onDefinitionChanged: 'block', onWorkspaceChanged: 'block' }
const routeCurrent: ResumePolicy = { ...RESUME_POLICY_DEFAULTS, onUnavailableModel: 'route-current' }

describe('gate step 0 — orphaned pin', () => {
  it('denies PIN_ORPHANED when the persisted session is gone', async () => {
    const decision = await evaluateGate(makePin(), makeEnv({ sessionExists: false }), noticePolicy)
    expect(decision).toMatchObject({ action: 'deny', code: 'PIN_ORPHANED' })
  })
})

describe('gate step 1 — unreadable pin', () => {
  it('denies PIN_UNREADABLE for a corrupt pin before any environment probe', async () => {
    const corrupt: CorruptPin = { kind: 'corrupt', reason: 'unsupported pin version 99' }
    const decision = await evaluateGate(corrupt, makeEnv({ sessionExists: false }), noticePolicy)
    expect(decision).toMatchObject({ action: 'deny', code: 'PIN_UNREADABLE' })
  })
})

describe('gate step 2 — workspace', () => {
  it('denies WORKSPACE_MISSING when the pinned cwd is gone (no policy can route around it)', async () => {
    for (const policy of [noticePolicy, routeCurrent]) {
      const decision = await evaluateGate(makePin(), makeEnv({ cwdExists: false }), policy)
      expect(decision).toMatchObject({ action: 'deny', code: 'WORKSPACE_MISSING' })
    }
  })

  it('gitCommonDir/gitDir drift → notice by default, deny under block policy', async () => {
    const env = makeEnv({ currentGit: { gitDir: '/other/.git/worktrees/ws', gitCommonDir: '/other/.git', branch: 'main' } })
    const pass = await evaluateGate(makePin(), env, noticePolicy)
    expect(pass).toMatchObject({ action: 'pass', notices: [expect.stringContaining('repository identity changed')] })
    const denied = await evaluateGate(makePin(), env, blockChanged)
    expect(denied).toMatchObject({ action: 'deny', code: 'WORKSPACE_CHANGED' })
  })

  it('branch-only drift is a notice independent of onWorkspaceChanged', async () => {
    const env = makeEnv({ currentGit: { gitDir: '.git', gitCommonDir: '.git', branch: 'topic' } })
    const pass = await evaluateGate(makePin(), env, blockChanged)
    expect(pass).toMatchObject({ action: 'pass', notices: [expect.stringContaining('branch changed')] })
  })
})

describe('gate step 3 — definition', () => {
  const named = (fingerprint: string): ResumePin =>
    makePin({ definition: { kind: 'named', agentType: 'researcher', source: 'project', fingerprint, personaHash: 'sha256:x' } })

  it('matching fingerprint passes silently; no-information (null) passes silently', async () => {
    for (const current of ['sha256:same', null]) {
      const decision = await evaluateGate(named('sha256:same'), makeEnv({ currentDefinitionFingerprint: current }), noticePolicy)
      expect(decision).toMatchObject({ action: 'pass', notices: [] })
    }
  })

  it('mismatch/missing → notice stating pinned persona is retained (default)', async () => {
    for (const current of ['sha256:other', 'missing' as const]) {
      const decision = await evaluateGate(named('sha256:same'), makeEnv({ currentDefinitionFingerprint: current }), noticePolicy)
      expect(decision).toMatchObject({ action: 'pass', notices: ['resumed with changed definition (pinned persona retained)'] })
    }
  })

  it('mismatch → deny under onDefinitionChanged=block', async () => {
    const decision = await evaluateGate(named('sha256:same'), makeEnv({ currentDefinitionFingerprint: 'sha256:other' }), blockChanged)
    expect(decision).toMatchObject({ action: 'deny', code: 'DEFINITION_CHANGED' })
  })
})

describe('gate step 4 — pinned tool filter', () => {
  it('denies PINNED_TOOL_UNAVAILABLE when an allow or deny name left the restrictable universe', async () => {
    const pin = makePin({ toolFilter: { allow: ['read'], deny: ['write'] } })
    const decision = await evaluateGate(pin, makeEnv({ restrictableNames: new Set(['read']) }), noticePolicy)
    expect(decision).toMatchObject({ action: 'deny', code: 'PINNED_TOOL_UNAVAILABLE', reason: expect.stringContaining('write') })
  })
})

describe('gate step 5 — model/route availability & drift (complete pins)', () => {
  it('passes when the re-resolved tuple matches field-by-field including pinned absences', async () => {
    const pin = makePin({ effective: { provider: 'mock', model: 'mock', reasoningEffort: null, maxTokens: null, complete: true } })
    const decision = await evaluateGate(pin, makeEnv(), noticePolicy)
    expect(decision).toMatchObject({ action: 'pass', notices: [] })
  })

  it('provider unmounted → deny SUBAGENT_MODEL_UNAVAILABLE naming the policy knob', async () => {
    const env = makeEnv({ resolveCallConfig: async () => { throw new Error('no adapter registered for provider "mock"') } })
    const decision = await evaluateGate(makePin(), env, noticePolicy)
    expect(decision).toMatchObject({ action: 'deny', code: 'SUBAGENT_MODEL_UNAVAILABLE', reason: expect.stringContaining("subagents-resume.onUnavailableModel: 'route-current'") })
  })

  it('adapter-default drift (pinned null, adapter now declares a default) is drift → deny by default', async () => {
    const pin = makePin({ effective: { provider: 'mock', model: 'mock', reasoningEffort: null, maxTokens: null, complete: true } })
    const env = makeEnv({ resolveCallConfig: async config => ({ ...config, maxTokens: 4321 }) })
    const decision = await evaluateGate(pin, env, noticePolicy)
    expect(decision).toMatchObject({ action: 'deny', code: 'SUBAGENT_MODEL_UNAVAILABLE', reason: expect.stringContaining('maxTokens') })
  })

  it('route-current policy: drift → pass with a complete current-tuple overlay + notice', async () => {
    const pin = makePin({ effective: { provider: 'mock', model: 'mock', reasoningEffort: null, maxTokens: null, complete: true } })
    const env = makeEnv({ resolveCallConfig: async config => ({ ...config, maxTokens: config.provider === 'mock' ? 4321 : undefined }) })
    const decision = await evaluateGate(pin, env, routeCurrent)
    expect(decision).toMatchObject({
      action: 'pass',
      overlay: { provider: 'mock', model: 'mock', reasoningEffort: null, maxTokens: 4321 },
      notices: [expect.stringContaining('resumed with current default route')],
    })
  })

  it('alias drift (alias no longer resolves to the pinned model) → deny by default', async () => {
    const pin = makePin({ modelSelector: { raw: 'sonnet', via: 'alias' } })
    const env = makeEnv({ resolveDetailed: () => ({ via: 'alias', route: { model: 'mock-v2' } }) })
    const decision = await evaluateGate(pin, env, noticePolicy)
    expect(decision).toMatchObject({ action: 'deny', code: 'SUBAGENT_MODEL_UNAVAILABLE', reason: expect.stringContaining('mock-v2') })
  })

  it('alias drift with route-current: re-resolves the selector atomically into the overlay', async () => {
    const pin = makePin({ modelSelector: { raw: 'sonnet', via: 'alias' } })
    const env = makeEnv({
      resolveDetailed: selector => selector === 'sonnet'
        ? { selector, via: 'alias', route: { provider: 'mock2', model: 'mock2', reasoningEffort: 'low' } }
        : { selector, via: 'literal', route: { model: selector } },
      resolveCallConfig: async config => ({ provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort, maxTokens: 999 }),
    })
    const decision = await evaluateGate(pin, env, routeCurrent)
    expect(decision).toMatchObject({
      action: 'pass',
      overlay: { provider: 'mock2', model: 'mock2', reasoningEffort: 'low', maxTokens: 999 },
    })
  })

  it('route-current with an unresolvable fallback → deny SUBAGENT_MODEL_UNAVAILABLE', async () => {
    const pin = makePin({ modelSelector: { raw: 'sonnet', via: 'alias' } })
    const env = makeEnv({
      resolveDetailed: () => ({ via: 'inherit', route: undefined }),
      resolveCallConfig: async () => { throw new Error('no adapter registered for provider "mock"') },
    })
    const decision = await evaluateGate(pin, env, routeCurrent)
    expect(decision).toMatchObject({ action: 'deny', code: 'SUBAGENT_MODEL_UNAVAILABLE', reason: expect.stringContaining('fallback is unavailable') })
  })

  it('alias-removed → the CURRENT default route is used, not the pinned one', async () => {
    const pin = makePin({
      modelSelector: { raw: 'sonnet', via: 'alias' },
      effective: { provider: 'mock', model: 'mock', reasoningEffort: 'high', maxTokens: 5555, complete: true },
    })
    // The alias no longer resolves (a literal now), and the parent has moved
    // to a different route entirely.
    const env = makeEnv({
      resolveDetailed: selector => ({ selector, via: 'literal', route: { model: 'mock3' } }),
      currentRoute: { provider: 'mockX', model: 'mockX', maxTokens: 100 },
      resolveCallConfig: async config =>
        config.provider === 'mock' ? Promise.reject(new Error('no adapter registered for provider "mock"')) : { ...config },
    })
    // resolvePinned (pinned mock/mock) throws → route-current; the overlay is
    // the current parent route + the fresh selector model, never the pinned
    // provider/model.
    const decision = await evaluateGate(pin, env, routeCurrent)
    expect(decision).toMatchObject({
      action: 'pass',
      overlay: { provider: 'mockX', model: 'mock3', reasoningEffort: null, maxTokens: 100 },
    })
  })

  it('literal selector → parent-route drift is honored (current maxTokens wins)', async () => {
    const pin = makePin({ modelSelector: { raw: 'mock', via: 'literal' } })
    const env = makeEnv({
      currentRoute: { provider: 'mock', model: 'mock', maxTokens: 777 },
      // Pinned route drifts (adapter now defaults 4321) to trigger the fallback;
      // the current-tuple preflight (maxTokens 777) resolves as requested.
      resolveCallConfig: async config => ({ ...config, maxTokens: config.maxTokens === 777 ? 777 : 4321 }),
    })
    const decision = await evaluateGate(pin, env, routeCurrent)
    expect(decision).toMatchObject({ action: 'pass', overlay: { provider: 'mock', model: 'mock', maxTokens: 777 } })
  })

  it('unresolvable current parent route (literal/inherit) → deny SUBAGENT_MODEL_UNAVAILABLE', async () => {
    const pin = makePin({ modelSelector: { raw: 'mock', via: 'literal' } })
    const env = makeEnv({
      currentRoute: undefined,
      // The pinned preflight drifts (adapter now defaults 4321); any
      // route-current preflight (no maxTokens) finds no current route.
      resolveCallConfig: async config =>
        config.maxTokens === 5555
          ? { ...config, maxTokens: 4321 }
          : Promise.reject(new Error('no adapter registered for provider "mock"')),
    })
    const decision = await evaluateGate(pin, env, routeCurrent)
    expect(decision).toMatchObject({ action: 'deny', code: 'SUBAGENT_MODEL_UNAVAILABLE' })
  })
})

describe('gate step 5 — degraded pins (complete:false)', () => {
  const degraded = makePin({
    effective: { provider: 'mock', model: 'mock', reasoningEffort: null, maxTokens: null, complete: false },
  })

  it('explicit fields still resolvable → pass without absence-drift checks', async () => {
    // The adapter now declares a default maxTokens — degraded pins cannot
    // detect that (documented limit), so this passes.
    const env = makeEnv({ resolveCallConfig: async config => ({ ...config, maxTokens: 4321 }) })
    const decision = await evaluateGate(degraded, env, noticePolicy)
    expect(decision).toMatchObject({ action: 'pass', notices: [] })
    expect((decision as { overlay?: unknown }).overlay).toBeUndefined()
  })

  it('provider unmounted → deny; route-current resumes via the current tuple (alias selector)', async () => {
    const pin = makePin({
      modelSelector: { raw: 'sonnet', via: 'alias' },
      effective: { provider: 'mock', model: 'mock', reasoningEffort: null, maxTokens: null, complete: false },
    })
    const throwing = makeEnv({
      resolveDetailed: selector => selector === 'sonnet'
        ? { selector, via: 'alias', route: { provider: 'mock2', model: 'mock2' } }
        : { selector, via: 'literal', route: { model: selector } },
      resolveCallConfig: async config => {
        if (config.provider === 'mock') throw new Error('no adapter registered for provider "mock"')
        return { provider: config.provider, model: config.model }
      },
    })
    expect(await evaluateGate(pin, throwing, noticePolicy)).toMatchObject({ action: 'deny', code: 'SUBAGENT_MODEL_UNAVAILABLE' })
    expect(await evaluateGate(pin, throwing, routeCurrent)).toMatchObject({
      action: 'pass',
      overlay: { provider: 'mock2', model: 'mock2' },
    })
    // An inherit-selector degraded pin whose provider is gone has no fallback.
    expect(await evaluateGate(degraded, throwing, routeCurrent)).toMatchObject({ action: 'deny', code: 'SUBAGENT_MODEL_UNAVAILABLE' })
  })

  it('alias drift is still checked on degraded pins', async () => {
    const pin = makePin({
      modelSelector: { raw: 'sonnet', via: 'alias' },
      effective: { provider: 'mock', model: 'mock', reasoningEffort: null, maxTokens: null, complete: false },
    })
    const env = makeEnv({ resolveDetailed: () => ({ via: 'alias', route: { model: 'mock-v2' } }) })
    expect(await evaluateGate(pin, env, noticePolicy)).toMatchObject({ action: 'deny', code: 'SUBAGENT_MODEL_UNAVAILABLE' })
  })
})

describe('gate — durability bookkeeping', () => {
  it('an all-passing evaluation of a previously blocked pin requests clearBlocked', async () => {
    const pin = makePin({ resume: { state: 'blocked', reason: '[WORKSPACE_MISSING] gone' } })
    const decision = await evaluateGate(pin, makeEnv(), noticePolicy)
    expect(decision).toMatchObject({ action: 'pass', clearBlocked: true })
  })

  it('a passing evaluation of an ok pin does not set clearBlocked', async () => {
    const decision = await evaluateGate(makePin(), makeEnv(), noticePolicy)
    expect(decision).toMatchObject({ action: 'pass' })
    expect((decision as { clearBlocked?: boolean }).clearBlocked).toBeUndefined()
  })

  it('step ordering: an orphaned corrupt-definition pin denies PIN_ORPHANED first', async () => {
    const pin = makePin({ definition: { kind: 'named', agentType: 'x', source: 'project', fingerprint: 'a', personaHash: 'b' } })
    const decision = await evaluateGate(pin, makeEnv({ sessionExists: false, currentDefinitionFingerprint: 'missing' }), blockChanged)
    expect(decision).toMatchObject({ action: 'deny', code: 'PIN_ORPHANED' })
  })
})

describe('policy — readResumePolicy', () => {
  it('absent/malformed sections resolve to the fail-closed defaults', () => {
    for (const raw of [undefined, null, 'nope', 42, { onUnavailableModel: 'yolo' }]) {
      expect(readResumePolicy(raw)).toEqual(RESUME_POLICY_DEFAULTS)
    }
  })

  it('live values override defaults field-by-field; unknown fields are ignored', () => {
    expect(readResumePolicy({ onUnavailableModel: 'route-current', future: true })).toEqual({
      onUnavailableModel: 'route-current',
      onDefinitionChanged: 'resume-with-notice',
      onWorkspaceChanged: 'resume-with-notice',
    })
  })

  it('the settings schema is an object schema with explicit per-knob defaults (M12)', async () => {
    const { ResumePolicySchema } = await import('../src/plugin.ts')
    // Missing section → the defaults.
    expect(ResumePolicySchema({})).toEqual(RESUME_POLICY_DEFAULTS)
    // Valid spellings normalize through.
    expect(ResumePolicySchema({ onUnavailableModel: 'route-current' })).toMatchObject({ onUnavailableModel: 'route-current' })
    // Invalid spellings are rejected at write time.
    expect(() => ResumePolicySchema({ onUnavailableModel: 'yolo' })).toThrow()
    expect(() => ResumePolicySchema({ onDefinitionChanged: 'route-current' })).toThrow()
  })
})
