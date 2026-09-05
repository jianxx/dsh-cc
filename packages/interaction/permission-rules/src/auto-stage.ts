/**
 * The async LLM-classifier stage for `auto` mode: owns arming (per call, from
 * the live `permissions.autoMode` settings slice), the memoized
 * `createLlmClassifier` instance, and the `permission/classifier` session
 * audit event. The plugin's `tools/pre-execute` listener (index.ts) only
 * wires this stage — the escalate-only decision flow lives here.
 *
 * Arming predicate (§4.4): `autoMode.classifier.enabled === true` AND an llm
 * stream capability is wired AND the alias route resolves. Enabled but
 * unarmable ⇒ disarm with ONE warning per process (plus an `unarmed` audit
 * event when a session is available) and the legacy decision path runs.
 *
 * @module @jianxx/dsh-cc-permission-rules/auto-stage
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@jianxx/dsh-cc-tools'
import { createLlmClassifier, expandSoftDeny, type ClassifierRoute, type LlmClassifier } from './llm-classifier.ts'
import type { DecidedCall } from './decide.ts'

/** `permissions.autoMode.classifier` — the plugin-local hand-mirror of the shared AutoModeClassifierSchema. */
export interface AutoModeClassifierSettings {
  /** Master switch for the LLM risk classifier stage (default `false`). */
  enabled?: boolean
  /** Model route used for classification (default `'haiku'`). */
  route?: string
  /** Per-call timeout in milliseconds (default `5000`). */
  timeoutMs?: number
  /** Verdict cache size in entries (default `256`). */
  cacheMaxEntries?: number
}

/** `permissions.autoMode` — the plugin-local hand-mirror of the shared AutoModeSchema. */
export interface AutoModeSettings {
  /**
   * Soft-deny hints evaluated by the classifier, in CC's snake_case spelling.
   * `$defaults` expansion happens at consumption time — the schema never
   * expands it.
   */
  soft_deny?: string[]
  /** LLM risk classifier configuration; absent when the section omits it. */
  classifier?: AutoModeClassifierSettings
}

/** The session event type carrying one classifier verdict audit record. */
export const CLASSIFIER_EVENT = 'permission/classifier'

// Cross-repo event registration: postdates the upstream session catalog
// (same pattern as `permission/mode` / `permission/session-allow`).
;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add(CLASSIFIER_EVENT)

/** The `permission/classifier` payload. The raw classifier input NEVER appears — only its digest. */
export interface ClassifierAuditEventData {
  /** The tool the verdict is about. */
  tool: string
  /** sha256 of the rendered classifier input (absent on the arming `unarmed` record). */
  digest?: string
  verdict: 'allow' | 'ask'
  failure?: 'timeout' | 'error' | 'malformed' | 'unarmed'
  route?: string
  provider?: string
  model?: string
  latencyMs: number
  cacheHit: boolean
}

/** Wire face of one log event that may or may not be a `permission/classifier`. */
interface ClassifierWire {
  readonly type: string
  readonly data: ClassifierAuditEventData
}

/**
 * Append one `permission/classifier` audit record through the widened session
 * append face (same cross-pin strategy as `./mode.ts` and
 * `./session-allowlist.ts`).
 */
export function appendSessionClassifier(session: Session, data: ClassifierAuditEventData): void {
  type AppendFace = { append(type: string, data: ClassifierAuditEventData): unknown }
  ;(session as unknown as AppendFace).append(CLASSIFIER_EVENT, data)
}

/**
 * Fold a session log into the classifier verdict records it carries, in log
 * order. Foreign event types are skipped; resume/replay reconstructs why a
 * call did or did not prompt.
 */
export function foldClassifiers(events: readonly SessionEvent[]): ClassifierAuditEventData[] {
  const out: ClassifierAuditEventData[] = []
  for (const event of events) {
    const wire = event as unknown as ClassifierWire
    if (wire.type !== CLASSIFIER_EVENT || typeof wire.data !== 'object' || wire.data === null) continue
    out.push(wire.data)
  }
  return out
}

/**
 * Structural dependency face the service supplies. `stream` is the llm
 * adapter (undefined when the llm service is not mounted); `resolveRoute`
 * resolves the configured alias route per call (undefined when unresolvable).
 */
export type AutoStageDeps = {
  /** The live `permissions` settings section (re-read on every call). */
  settingsRead(): { autoMode?: AutoModeSettings }
  /**
   * One-shot text completion over the auxiliary lane; `undefined` when no llm
   * service is mounted (the stage then disarms).
   */
  stream: ((opts: { provider: string; model: string; system: string; prompt: string; maxTokens: number; signal?: AbortSignal }) => Promise<string>) | undefined
  /** Resolve the configured classifier route for this call's session. */
  resolveRoute(exec: ToolExecution): { provider: string; model: string } | undefined
  /** Process logger for the one-time disarm warning. */
  warn(message: string): void
  /** Durable audit sink (session append face, listener-owned). */
  audit(session: Session, event: ClassifierAuditEventData): void
}

/** The stage's contribution to one pre-execute decision: allow, an escalated ask, or nothing (legacy path). */
export type StageOutcome = 'allow' | { kind: 'ask'; reason: string }

export type AutoStage = {
  /** Drop the memoized classifier so the next armed call rebuilds it (settings onChange). */
  rebuild(): void
  /**
   * Maybe escalate one verbose decision. Returns a final decision only for
   * the armed + `auto` + LOW + `ask`/`passthrough` slice (§4.1); every other
   * shape returns undefined and the listener applies the legacy mapping
   * unchanged — the LLM is then never invoked (I1–I3, I5).
   */
  maybeEscalate(decided: DecidedCall, exec: ToolExecution): Promise<StageOutcome | undefined>
}

/** The autoMode settings slice, normalized for comparison and consumption. */
interface AutoModeSlice {
  softDeny: string[]
  route: string
  timeoutMs: number
  cacheMaxEntries: number
  enabled: boolean
  raw: string
}

function readSlice(settings: { autoMode?: AutoModeSettings }): AutoModeSlice {
  const autoMode = settings.autoMode
  const classifier = autoMode?.classifier
  const softDeny = expandSoftDeny(autoMode?.soft_deny ?? ['$defaults'])
  return {
    softDeny,
    route: classifier?.route ?? 'haiku',
    timeoutMs: classifier?.timeoutMs ?? 5000,
    cacheMaxEntries: classifier?.cacheMaxEntries ?? 256,
    enabled: classifier?.enabled === true,
    raw: JSON.stringify([autoMode?.soft_deny, classifier]),
  }
}

/**
 * Build the stage. The classifier instance is memoized per autoMode slice:
 * `rebuild()` (wired to the plugin's settings onChange/reload) drops it, and
 * the next armed call rebuilds from the fresh slice — never per call.
 */
export function createAutoStage(deps: AutoStageDeps): AutoStage {
  let slice = readSlice(deps.settingsRead())
  /** The raw autoMode slice the memoized classifier was built from. */
  let builtRaw = slice.raw
  let classifier: LlmClassifier | undefined
  /** Warned-once flag for enabled-but-unarmable (per process). */
  let warnedUnarmed = false

  const ensureClassifier = (): LlmClassifier => {
    if (classifier !== undefined && builtRaw === slice.raw) return classifier
    classifier = createLlmClassifier({
      // The route for each call is passed as data to classify() (per-call
      // argument, never ambient state) and the caller audits from the returned
      // classification — no session/route fields live on this stage, so
      // concurrent calls cannot cross-contaminate audit attribution.
      stream: (opts) => {
        const stream = deps.stream
        if (stream === undefined) throw new Error('llm service unmounted')
        return stream(opts)
      },
      softDeny: slice.softDeny,
      timeoutMs: slice.timeoutMs,
      cacheMaxEntries: slice.cacheMaxEntries,
    })
    builtRaw = slice.raw
    return classifier
  }

  const disarmUnarmed = (exec: ToolExecution): void => {
    if (!warnedUnarmed) {
      warnedUnarmed = true
      deps.warn('permission classifier: enabled but unarmable (llm service or model route unavailable); stage disarmed, auto mode uses the legacy path')
    }
    const session = exec.agent?.session
    if (session !== undefined) {
      deps.audit(session, {
        tool: exec.name,
        verdict: 'ask',
        failure: 'unarmed',
        latencyMs: 0,
        cacheHit: false,
      })
    }
  }

  return {
    rebuild(): void {
      // Drop the memoized classifier only when the autoMode slice actually
      // changed — an onChange for unrelated keys keeps the instance.
      const current = readSlice(deps.settingsRead())
      if (current.raw !== builtRaw) {
        slice = current
        classifier = undefined
      }
    },

    async maybeEscalate(decided: DecidedCall, exec: ToolExecution): Promise<StageOutcome | undefined> {
      slice = readSlice(deps.settingsRead())
      if (!slice.enabled) return undefined
      if (deps.stream === undefined) {
        disarmUnarmed(exec)
        return undefined
      }
      // The route for this call is passed to classify as data; the audit event
      // is appended from this call's own exec session — no ambient fields.
      const route: ClassifierRoute | undefined = deps.resolveRoute(exec)
      if (route === undefined) {
        disarmUnarmed(exec)
        return undefined
      }
      // Eligibility (§4.1): only auto + LOW + ask/passthrough reaches the LLM.
      if (decided.mode !== 'auto' || decided.risk.level !== 'LOW') return undefined
      if (decided.decision.kind !== 'ask' && decided.decision.kind !== 'passthrough') return undefined
      const verdict = await ensureClassifier().classify(exec, { route })
      const session = exec.agent?.session
      if (session !== undefined) {
        deps.audit(session, {
          tool: verdict.tool,
          digest: verdict.digest,
          verdict: verdict.verdict,
          ...(verdict.failure === undefined ? {} : { failure: verdict.failure }),
          ...(verdict.routeAlias === undefined ? {} : { route: verdict.routeAlias, provider: verdict.provider, model: verdict.model }),
          latencyMs: verdict.latencyMs,
          cacheHit: verdict.cacheHit,
        })
      }
      return verdict.verdict === 'allow' ? 'allow' : { kind: 'ask', reason: verdict.reason }
    },
  }
}
