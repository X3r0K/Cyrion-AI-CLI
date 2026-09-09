import type { EvidenceRef, EvidenceStore, ScopePolicy, ToolExecutionRequest, ToolProgress } from "@cyrion/contracts"
import type { OperatorCredentials } from "@cyrion/credentials"
import type { Embedder, KnowledgeStore } from "@cyrion/knowledge"
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
  /** Local corpus `knowledge.search` reads. Absent when nothing has been ingested. */
  knowledge?: KnowledgeStore
  /** Ranks retrieval semantically as well as lexically. Absent means lexical only. */
  embedder?: Embedder
  /**
   * The operator has accepted that `browser.session` drives a browser on this
   * host even in container mode, where its requests bypass the kernel egress
   * allowlist and are held to the scope by Cyrion instead.
   */
  allowHostBrowser?: boolean
  /**
   * The operator's credential store, read only where bytes leave for a host.
   *
   * Absent means an engagement that authenticates nothing, which is the common
   * case; a check that references a credential then fails with the name it
   * could not find rather than running unauthenticated.
   */
  credentials?: OperatorCredentials
}

export interface CapabilityResult {
  /** Bounded, typed summary handed back to the worker. Never raw bytes. */
  summary: Record<string, unknown>
  /** Artifacts captured for this call, already stored and hashed. */
  evidence: EvidenceRef[]
  /**
   * One short line describing what the target actually returned, for the live
   * transcript. It reaches an event, so it stays scalar and bounded: a status
   * and a content type, never a body or an attacker-chosen string of any length.
   */
  outcome?: string
}

export interface CapabilityAdapter {
  readonly capability: string
  /** Binary this adapter needs, or undefined when Cyrion implements it. */
  readonly binary?: string
  /**
   * Tool this adapter falls back to when it cannot run in the Cyrion process.
   *
   * A capability implemented in-process gives no isolation, which is fine in
   * local mode and a lie in container mode: the whole point of a container is
   * that the request leaves from inside it, under the egress allowlist.
   */
  readonly containerBinary?: string
  execute(
    request: ToolExecutionRequest,
    context: CapabilityContext,
    signal: AbortSignal,
    progress?: ToolProgress,
  ): Promise<CapabilityResult>
}
