import type {
  EvidenceStore,
  ScopePolicy,
  ToolAdapter,
  ToolExecutionRequest,
} from "@cyrion/contracts"
import type { TargetPin } from "@cyrion/scope"
import { binariesFor, type ToolRunner } from "@cyrion/sandbox"
import { dnsLookup } from "./dns"
import { httpProbe } from "./http"
import { netPortscan, netTls } from "./network"
import { pocRun } from "./poc"
import type { CapabilityAdapter, CapabilityContext } from "./types"

export const capabilityAdapters: readonly CapabilityAdapter[] = [dnsLookup, httpProbe, netPortscan, netTls, pocRun]

export interface RegistryOptions {
  runner: ToolRunner
  scope: ScopePolicy
  evidence: EvidenceStore
  /** Only these capabilities are exposed; the manifest decides, not the registry. */
  capabilities: readonly string[]
  /**
   * Evidence identifiers must stay unique across every run of an engagement,
   * because the store refuses to rewrite an ID with different content. The
   * default mints a per-registry prefix; pass one to make a run reproducible.
   */
  evidencePrefix?: string
}

/**
 * Turns capability adapters into the `ToolAdapter` shape the controller's tool
 * gateway already validates, so real tooling inherits every check fixtures had:
 * capability grant, target match, timeout, and output ceiling.
 */
/** Short, sortable, and collision-resistant: time in base 36 plus random suffix. */
export function defaultEvidencePrefix(now = Date.now()): string {
  const stamp = now.toString(36)
  const random = Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, "0")
  return `E-${stamp}${random}`
}

export class CapabilityRegistry {
  readonly #adapters = new Map<string, CapabilityAdapter>()
  readonly #context: CapabilityContext
  readonly #prefix: string
  #evidenceSequence = 0

  constructor(options: RegistryOptions) {
    for (const adapter of capabilityAdapters) {
      if (options.capabilities.includes(adapter.capability)) this.#adapters.set(adapter.capability, adapter)
    }
    this.#prefix = options.evidencePrefix ?? defaultEvidencePrefix()
    this.#context = {
      runner: options.runner,
      scope: options.scope,
      evidence: options.evidence,
      pins: new Map<string, TargetPin>(),
      nextEvidenceId: () => `${this.#prefix}-${String(++this.#evidenceSequence).padStart(4, "0")}`,
    }
  }

  get context(): CapabilityContext {
    return this.#context
  }

  /** Capability names this registry can serve. */
  names(): string[] {
    return [...this.#adapters.keys()]
  }

  /** Binaries the selected capabilities need on the machine that runs them. */
  requiredBinaries(): string[] {
    return binariesFor(this.names())
  }

  /** Adapters keyed by capability, ready for `new ScopedToolGateway(manifest, adapters)`. */
  toolAdapters(): Record<string, ToolAdapter> {
    const adapters: Record<string, ToolAdapter> = {}
    for (const [capability, adapter] of this.#adapters) {
      adapters[capability] = {
        execute: async (request: ToolExecutionRequest, signal: AbortSignal) => {
          const result = await adapter.execute(request, this.#context, signal)
          return { ...result.summary, evidence: result.evidence }
        },
      }
    }
    return adapters
  }

  /** Runs one capability directly, for `cyrion probe` and for tests. */
  async execute(request: ToolExecutionRequest, signal: AbortSignal) {
    const adapter = this.#adapters.get(request.capability)
    if (!adapter) throw new Error(`Capability is not available: ${request.capability}`)
    return adapter.execute(request, this.#context, signal)
  }

  /** The evidence prefix is fixed per engagement so identifiers never collide. */
  get evidencePrefix(): string {
    return this.#prefix
  }
}
