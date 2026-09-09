import type {
  EvidenceStore,
  ScopePolicy,
  ToolAdapter,
  ToolExecutionRequest,
  ToolProgress,
} from "@cyrion/contracts"
import type { OperatorCredentials } from "@cyrion/credentials"
import type { Embedder, KnowledgeStore } from "@cyrion/knowledge"
import type { TargetPin } from "@cyrion/scope"
import { binariesFor, type ToolRunner } from "@cyrion/sandbox"
import { browserSession } from "./browser"
import { httpCrawl } from "./crawl"
import { dnsLookup } from "./dns"
import { dnsEnum } from "./dns-enum"
import { httpProbe, httpRequest } from "./http"
import { knowledgeSearch } from "./knowledge"
import { netPortscan, netTls } from "./network"
import { pocRun } from "./poc"
import { repoDeps, repoInventory, repoScan } from "./repo"
import { sqliTest, vulnScan, webFuzz } from "./scanners"
import { pythonExec, shellExec } from "./shell"
import type { DnsResolver } from "./dns-enum"
import type { CapabilityAdapter, CapabilityContext } from "./types"

export const capabilityAdapters: readonly CapabilityAdapter[] = [
  dnsLookup,
  dnsEnum,
  httpProbe,
  httpRequest,
  httpCrawl,
  browserSession,
  netPortscan,
  netTls,
  knowledgeSearch,
  pocRun,
  repoInventory,
  repoScan,
  repoDeps,
  webFuzz,
  vulnScan,
  sqliTest,
  shellExec,
  pythonExec,
]

/**
 * Capabilities with no fixed binary, which the runner's allowlist cannot bound.
 *
 * Granting one moves the boundary from "which binary" to the sandbox itself, so
 * the caller has to know: it is what decides whether the runner is built with
 * its allowlist lifted, and what makes container the mode a run like this
 * belongs in.
 */
export const UNBOUNDED_CAPABILITIES: readonly string[] = ["shell.exec", "python.exec"]

export function needsUnboundedRunner(capabilities: readonly string[]): boolean {
  return capabilities.some((capability) => UNBOUNDED_CAPABILITIES.includes(capability))
}

export interface RegistryOptions {
  runner: ToolRunner
  scope: ScopePolicy
  evidence: EvidenceStore
  /** Only these capabilities are exposed; the manifest decides, not the registry. */
  capabilities: readonly string[]
  /** Corpus `knowledge.search` reads. Without it the capability refuses rather than inventing. */
  knowledge?: KnowledgeStore
  embedder?: Embedder
  /**
   * Credentials for authenticated testing, held by the operator rather than by
   * a skill file. Absent means every check runs unauthenticated, and one that
   * names a credential fails rather than quietly doing so.
   */
  credentials?: OperatorCredentials
  /**
   * The operator accepted that `browser.session` drives a browser on this host
   * even under a container sandbox. Without it a container run refuses the
   * capability rather than quietly stepping outside the egress allowlist.
   */
  allowHostBrowser?: boolean
  /** Resolver `dns.enum` asks. Absent means the system resolver. */
  dnsResolver?: DnsResolver
  /**
   * Adapters this release does not ship — today, operator-approved MCP tools.
   * They are filtered by `capabilities` like every built-in, and may not answer
   * as a capability Cyrion implements itself.
   */
  extraAdapters?: readonly CapabilityAdapter[]
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

/**
 * Capabilities a manifest names that no adapter can serve.
 *
 * `provided` names what something outside this release answers for — an MCP
 * server the operator approved — so a granted capability with a real adapter
 * behind it is not reported as missing.
 */
export function unservedCapabilities(granted: readonly string[], provided: readonly string[] = []): string[] {
  const served = new Set([...capabilityAdapters.map((adapter) => adapter.capability), ...provided])
  return granted.filter((capability) => !served.has(capability))
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
    for (const adapter of options.extraAdapters ?? []) {
      if (!options.capabilities.includes(adapter.capability)) continue
      // Shadowing a built-in would make a finding's provenance a guess, so it is
      // refused here as well as where the configuration is read.
      if (this.#adapters.has(adapter.capability)) {
        throw new Error(`${adapter.capability} is implemented by Cyrion and cannot be provided by another adapter`)
      }
      this.#adapters.set(adapter.capability, adapter)
    }
    this.#prefix = options.evidencePrefix ?? defaultEvidencePrefix()
    this.#context = {
      runner: options.runner,
      scope: options.scope,
      evidence: options.evidence,
      pins: new Map<string, TargetPin>(),
      ...(options.knowledge ? { knowledge: options.knowledge } : {}),
      ...(options.embedder ? { embedder: options.embedder } : {}),
      ...(options.credentials ? { credentials: options.credentials } : {}),
      ...(options.allowHostBrowser ? { allowHostBrowser: true } : {}),
      ...(options.dnsResolver ? { dnsResolver: options.dnsResolver } : {}),
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
        execute: async (request: ToolExecutionRequest, signal: AbortSignal, progress?: ToolProgress) => {
          const result = await adapter.execute(request, this.#context, signal, progress)
          return {
            ...result.summary,
            evidence: result.evidence,
            ...(result.outcome ? { outcome: result.outcome } : {}),
          }
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
