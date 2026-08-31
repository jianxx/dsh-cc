/**
 * One scope's tool-registry contribution: visibility, reservations,
 * restrictions, guards, and per-scope presentation shadowing.
 * @module tool-layer
 */
import { AnonymousEntries, NamedEntries } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer } from '@deepseek-ai/dsh-scope'
import type { CompiledToolRestriction, ToolDefinition, ToolExecution, ToolGuard, PreToolDecision, ToolPresentationMode } from './tool-types.ts'

/** One scope's complete tool-registry contribution. */
export class ToolLayer implements ScopeLayer {
  readonly tools: NamedEntries<ToolDefinition>
  /** Known-but-invisible capability names, so a scoped restriction can gate a tool before it loads. */
  readonly reserved = new NamedEntries<undefined>(name => new Error(`tool name "${name}" is already reserved in this scope`))
  readonly restrictions = new AnonymousEntries<CompiledToolRestriction>()
  readonly guards = new AnonymousEntries<ToolGuard>()
  /**
   * Presentation this scope's agent declared for itself, shadowing the
   * deployment default. One cell rather than an entry table: two answers to
   * "which form does the model see" is a contradiction, not a merge.
   */
  mode: ToolPresentationMode | undefined

  constructor(scope: ScopeKey | undefined) {
    this.tools = new NamedEntries(name => new Error(scope === undefined
      ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`
      : `tool "${name}" is already registered in this scope`))
  }

  /** Whether every contribution table in this aggregate layer is empty. */
  isEmpty(): boolean {
    return this.tools.isEmpty() && this.reserved.isEmpty() && this.restrictions.isEmpty()
      && this.guards.isEmpty() && this.mode === undefined
  }

  /** Whether every compiled restriction in this layer admits a global tool name. */
  admits(name: string): boolean {
    for (const filter of this.restrictions.values()) {
      if ((filter.allow !== undefined && !filter.allow.has(name))
        || (filter.deny !== undefined && filter.deny.has(name))) return false
    }
    return true
  }

  /** First monotonic denial from this layer's live guard registrations. */
  guardReason(exec: ToolExecution): string | undefined {
    for (const guard of this.guards.values()) {
      const reason = guard(exec)
      if (reason !== undefined) return reason
    }
    return undefined
  }
}

/** Approval decision plus whether the approval channel reported cancellation. */
export interface ToolAskResolution {
  readonly decision: Extract<PreToolDecision, { kind: 'allow' | 'deny' }>
  readonly approvalCancelled: boolean
}

/** Caller cancellation and dispatch state kept outside the around-wrapper view. */
export interface ToolCancellationState {
  readonly callerSignal: AbortSignal
  bodyInvoked: boolean
}

/** One dispatch-scoped fused signal plus listener cleanup after the body settles. */
export interface FusedToolSignal {
  readonly signal: AbortSignal
  dispose(): void
}

/** Resolve the run_code overlap cap at the owning config boundary (direct construction bypasses the Loader schema). */
export function resolveMaxParallelSubCalls(value: number | undefined): number {
  const maxParallelSubCalls = value ?? 10
  if (!Number.isInteger(maxParallelSubCalls) || maxParallelSubCalls < 1) {
    throw new Error('maxParallelSubCalls must be a positive integer')
  }
  return maxParallelSubCalls
}
