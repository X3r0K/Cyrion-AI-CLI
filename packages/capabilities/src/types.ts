import type { EvidenceRef, EvidenceStore, ScopePolicy, ToolExecutionRequest } from "@cyrion/contracts"
import type { TargetPin } from "@cyrion/scope"
import type { ToolRunner } from "@cyrion/sandbox"

export interface CapabilityContext {
  runner: ToolRunner
  scope: ScopePolicy
  evidence: EvidenceStore
  /** Addresses pinned per hostname during this engagement. */
  pins: Map<string, TargetPin>
  /** Sequence used to mint evidence identifiers the controller will accept. */
  nextEvidenceId(prefix: string): string
}

export interface CapabilityResult {
  /** Bounded, typed summary handed back to the worker. Never raw bytes. */
  summary: Record<string, unknown>
  /** Artifacts captured for this call, already stored and hashed. */
  evidence: EvidenceRef[]
}

export interface CapabilityAdapter {
  readonly capability: string
  /** Binary this adapter needs, or undefined when Cyrion implements it. */
  readonly binary?: string
  execute(request: ToolExecutionRequest, context: CapabilityContext, signal: AbortSignal): Promise<CapabilityResult>
}
