#!/usr/bin/env bun
import { existsSync } from "node:fs"
import { mkdir, readdir } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import {
  assertManifest,
  pocBundleContractError,
  type Severity,
  type AgentRuntime,
  type EngagementManifest,
  type EngagementSnapshot,
  type PocBundle,
  type RootPlanner,
} from "@cyrion/contracts"
import { CyrionController, FixtureRootPlanner, ScopedToolGateway, SQLiteEngagementStore } from "@cyrion/controller"
import { LocalEvidenceStore } from "@cyrion/evidence"
import { loadCredentials, type OperatorCredentials } from "@cyrion/credentials"
import {
  LlmRootPlanner,
  LlmRootReviewer,
  LlmWorkerReviewer,
  bindingForRole,
  createClient,
  createEmbeddingClient,
  loadModelConfig,
  probeReadiness,
  readEnvironmentConfig,
  type LlmReadiness,
  type ModelConfig,
  type ModelRole,
} from "@cyrion/llm"
import {
  buildCommunityReport,
  evaluateGate,
  renderCsvReport,
  renderHtmlReport,
  renderJUnitReport,
  renderJsonReport,
  renderMarkdownReport,
  renderSarifReport,
  severities,
  type KnowledgeRecord,
  type ReportContext,
} from "@cyrion/reporting"
import { AssessmentRootPlanner, CapabilityWorkerRuntime } from "@cyrion/assessment"
import {
  KnowledgeStore,
  builtInSources,
  embedPending,
  knowledgeSourceError,
  sourceById,
  syncSource,
  type CorpusStatus,
  type Embedder,
  type KnowledgeSource,
  type SyncReport,
} from "@cyrion/knowledge"
import {
  CapabilityRegistry,
  needsUnboundedRunner,
  McpCapabilities,
  capabilityAdapters,
  planEgress,
  unservedCapabilities,
} from "@cyrion/capabilities"
import {
  ContainerToolRunner,
  LocalToolRunner,
  egressFromPins,
  unreachableFromContainer,
  binariesFor,
  describeSandbox,
  detectHost,
  installPlan,
  requirementFor,
  inspectWorkerImage,
  pullWorkerImage,
  toolCatalog,
  workerImageDrift,
  workerImageError,
  workerImageLabel,
  type HostProfile,
  type SandboxKind,
  type WorkerImagePin,
} from "@cyrion/sandbox"
import { loadSkills, type Skill } from "@cyrion/skills"
import { renderBenchmarkMarkdown, scoreRun, summarize, type RunMetrics } from "@cyrion/benchmark"
import {
  CyrionMcpServer,
  McpStdioClient,
  assertMcpConfig,
  serveStdio,
  ungrantedCapabilities,
  type McpConfig,
} from "@cyrion/mcp"
import {
  canonicalScope,
  createScopeLock,
  evaluateScope,
  scopeHash,
  scopePolicyError,
  verifyScopeLock,
} from "@cyrion/scope"
import {
  FixtureAgentRuntime,
  GuardedAgentRuntime,
  GuardedRootPlanner,
  IsolatedFixtureToolAdapter,
  OpenCodeRuntime,
  inspectOpenCodeProviders,
  readProviderSelection,
  type FixtureScenario,
  type ProviderSelection,
  type ProviderStatus,
} from "@cyrion/runtime-opencode"
import { runTui, type TuiExit } from "./tui"
import { runLaunchScreen } from "./launch-screen"
import { WatchedEngagement } from "./watch"
import {
  buildScanManifest,
  defaultScanInput,
  scanCapabilities,
  scanInputError,
  type ScanInput,
} from "./scan-config"
import { prepareFixtureArtifacts } from "./fixture-artifacts"
import { readGeneralSettings, saveProviderSelection } from "./provider-config"

export const CLI_VERSION = "0.1.0-alpha.2"

/** The tag; what it must resolve to is recorded in containers/worker-manifest.json. */
const DEFAULT_WORKER_IMAGE = "cyrion/kali-worker:0.1"

/** Both routes to an endpoint, named wherever one is missing. */
const MODEL_SETUP_HINT = "Set the endpoint and model in Settings (press 5), or set CYRION_LLM_BASE_URL and "
  + "CYRION_LLM_MODEL. See docs/MODELS.md."

interface StatusSummary {
  status: EngagementSnapshot["status"]
  mode: EngagementManifest["mode"]
  scenario?: string
  engagementId: string
  agents: number
  tasks: number
  completedTasks: number
  confirmed: number
  rejected: number
  inconclusive: number
  evidence: number
  planner?: "fixture" | "opencode" | "llm" | "llm-author"
  workers?: "fixture" | "opencode" | "llm"
  approval?: "pending" | "approved"
}

const args = process.argv.slice(2)
const command = args[0] ?? "demo"
const projectRoot = resolveProjectRoot()


async function runDemo(): Promise<void> {
  const settings = readGeneralSettings(Bun.env)
  const provider = readProviderSelection(Bun.env)
  const headless = args.includes("--headless") || !process.stdout.isTTY
  const scenarios: FixtureScenario[] = ["known-positive", "clean", "rejected", "incomplete"]
  const scenario = readFlag("--fixture") ?? settings.defaultFixture
  if (!scenarios.includes(scenario as FixtureScenario)) {
    throw new Error(`Unknown fixture scenario: ${scenario}. Choose ${scenarios.join(", ")}.`)
  }
  const manifestPath = scenario === "known-positive"
    ? join(projectRoot, "fixtures/demo/engagement.json")
    : join(projectRoot, "fixtures/scenarios", `${scenario}.json`)
  const manifest = await Bun.file(manifestPath).json()
  assertManifest(manifest)
  const mode = readFlag("--mode") ?? settings.defaultMode
  if (mode && mode !== "autonomous" && mode !== "supervised") {
    throw new Error("--mode must be autonomous or supervised")
  }
  manifest.mode = mode === "supervised" ? "supervised" : "autonomous"
  const plannerModes = ["fixture", "opencode", "llm", "llm-author"] as const
  const workerModes = ["fixture", "opencode", "llm"] as const
  const plannerMode = (readFlag("--planner") ?? settings.defaultPlanner) as (typeof plannerModes)[number]
  if (!plannerModes.includes(plannerMode)) {
    throw new Error(`--planner must be one of ${plannerModes.join(", ")}`)
  }
  const workerMode = (readFlag("--workers") ?? settings.defaultWorkers) as (typeof workerModes)[number]
  if (!workerModes.includes(workerMode)) {
    throw new Error(`--workers must be one of ${workerModes.join(", ")}`)
  }
  const autoApprove = args.includes("--approve-all")
  if (headless && manifest.mode === "supervised" && !autoApprove) {
    const source = readFlag("--mode")
      ? "--mode supervised"
      : "CYRION_DEFAULT_MODE=supervised in your environment or .env"
    throw new Error(
      `Headless supervised mode requires --approve-all; interactive approval needs a TTY.\n`
      + `Supervised mode came from ${source}. Pass --mode autonomous to run unattended.`,
    )
  }
  const scopeLockPath = readFlag("--scope-lock")
  const scopeLock = scopeLockPath ? await Bun.file(absolute(scopeLockPath)).json() : undefined
  const stateArgument = readFlag("--state")
  const artifactArgument = readFlag("--artifacts") ?? ".cyrion/artifacts"
  const store = stateArgument
    ? new SQLiteEngagementStore(absolute(stateArgument), manifest.id)
    : undefined
  const artifactRoot = absolute(artifactArgument)
  const artifacts = await prepareFixtureArtifacts(join(artifactRoot, manifest.id), args.includes("--fresh"))
  if (artifacts.replaced && !headless) {
    console.error(
      `cyrion: replaced demo artifacts from ${terminalSafe(artifacts.replaced)} in `
      + `${terminalSafe(join(artifactRoot, manifest.id))}`,
    )
  }
  const evidenceStore = new LocalEvidenceStore(artifactRoot)
  const fixtureAdapter = new IsolatedFixtureToolAdapter(
    join(projectRoot, "workers/fixture-worker.ts"),
    manifest.scope.targets,
  )
  const toolGateway = new ScopedToolGateway(manifest, {
    "fixture.read": fixtureAdapter,
    "fixture.compare": fixtureAdapter,
  })
  const selected = await resolveDemoRuntime(
    { planner: plannerMode, workers: workerMode },
    { planner: readFlag("--planner") !== undefined, workers: readFlag("--workers") !== undefined },
    provider,
  )
  const { models, reviewer } = selected
  if (selected.notice) console.error(`cyrion: ${terminalSafe(selected.notice)}`)

  const rootSystemPrompt = selected.planner !== "fixture" || selected.workers !== "fixture"
    ? await Bun.file(join(projectRoot, "agents/root/system.md")).text()
    : ""

  const fixtureRuntime = new FixtureAgentRuntime({ scenario: scenario as FixtureScenario })
  let runtime: AgentRuntime = fixtureRuntime
  if (selected.workers === "opencode" && reviewer) {
    runtime = new GuardedAgentRuntime(fixtureRuntime, reviewer)
  } else if (selected.workers === "llm" && models) {
    const configured = models
  const workerClients = new Map<string, ReturnType<typeof createClient>>()
    runtime = new GuardedAgentRuntime(fixtureRuntime, new LlmWorkerReviewer((role) => {
      const modelRole = role === "validator" ? "validator" : role === "reporter" ? "reporter" : "worker"
      const existing = workerClients.get(modelRole)
      if (existing) return existing
      const client = createClient(configured, modelRole, Bun.env)
      workerClients.set(modelRole, client)
      return client
    }))
  }

  const fixturePlanner = new FixtureRootPlanner()
  let planner: RootPlanner = fixturePlanner
  if (selected.planner === "opencode" && reviewer) {
    planner = new GuardedRootPlanner(fixturePlanner, reviewer)
  } else if (selected.planner === "llm" && models) {
    planner = new GuardedRootPlanner(
      fixturePlanner,
      new LlmRootReviewer(createClient(models, "planner", Bun.env), rootSystemPrompt),
    )
  } else if (selected.planner === "llm-author" && models) {
    planner = new LlmRootPlanner(createClient(models, "planner", Bun.env), rootSystemPrompt)
  }
  const controller = new CyrionController(
    manifest as EngagementManifest,
    runtime,
    planner,
    join(projectRoot, "agents"),
    {
      ...(store ? { store } : {}),
      ...(scopeLock === undefined ? {} : { scopeLock }),
      toolGateway,
      autoApprove,
      evidenceStore,
    },
  )

  if (headless) {
    controller.events.subscribe((event) => console.log(JSON.stringify(event)))
    const result = await controller.run()
    console.log(JSON.stringify(statusSummary(result, scenario, { planner: selected.planner, workers: selected.workers })))
    controller.close()
    if (result.status !== "completed") process.exitCode = 1
    return
  }

  const exit = await runTui(
    controller,
    evidenceStore,
    {
      mode: selected.planner !== "fixture" || selected.workers !== "fixture" ? "hybrid" : "fixture",
      planner: selected.planner,
      workers: selected.workers,
      ...(runtimeProviderLabel(models, provider, selected.planner, selected.workers)
        ? { provider: runtimeProviderLabel(models, provider, selected.planner, selected.workers)! }
        : {}),
      ...(selected.notice ? { notice: selected.notice } : {}),
      ...(scopeLock && typeof scopeLock === "object" && "attestation" in scopeLock
        ? { attestation: String((scopeLock as { attestation: unknown }).attestation) }
        : {}),
    },
    join(absolute(artifactArgument), "..", "reports"),
    { ...defaultScanInput, sandbox: await detectSandbox() },
  )
  controller.close()
  // The demo is where an operator learns the terminal; the first real
  // assessment starts from the same place rather than from a second command.
  if (exit.kind === "scan") await engageScan(exit.input)
}


type PlannerMode = "fixture" | "opencode" | "llm" | "llm-author"
type WorkerMode = "fixture" | "opencode" | "llm"

interface DemoRuntimeChoice {
  planner: PlannerMode
  workers: WorkerMode
  models?: ModelConfig
  reviewer?: OpenCodeRuntime
  /** Why a requested runtime is not in use. Set only when Cyrion degraded. */
  notice?: string
}

/**
 * Decides what the demo actually runs with.
 *
 * A runtime named on the command line is honoured or refused, because the
 * operator asked for it in this run. One that came from saved defaults must
 * never keep the terminal from opening: it falls back to the deterministic
 * runtime and carries the reason into Settings, where it can be fixed.
 */
async function resolveDemoRuntime(
  requested: { planner: PlannerMode; workers: WorkerMode },
  explicit: { planner: boolean; workers: boolean },
  provider: ProviderSelection | undefined,
): Promise<DemoRuntimeChoice> {
  let planner = requested.planner
  let workers = requested.workers
  const notices: string[] = []

  if (planner === "opencode" || workers === "opencode") {
    const failure = await openCodeFailure(provider)
    if (failure) {
      if ((planner === "opencode" && explicit.planner) || (workers === "opencode" && explicit.workers)) {
        throw new Error(`OpenCode runtime is not ready: ${failure}. Run \`cyrion providers --check\`.`)
      }
      notices.push(`OpenCode review is off because ${failure}.`)
      if (planner === "opencode") planner = "fixture"
      if (workers === "opencode") workers = "fixture"
    }
  }

  let models: ModelConfig | undefined
  if (planner === "llm" || planner === "llm-author" || workers === "llm") {
    // Only the roles this run will actually create a client for. An endpoint
    // configured for a role nothing uses must not decide whether Cyrion runs.
    const needed: ModelRole[] = [
      ...(planner === "llm" || planner === "llm-author" ? ["planner" as const] : []),
      ...(workers === "llm" ? ["worker" as const, "validator" as const, "reporter" as const] : []),
    ]
    const attempt = await modelConfigOrReason(needed)
    if (attempt.reason) {
      const plannerAsked = planner === "llm" || planner === "llm-author"
      if ((plannerAsked && explicit.planner) || (workers === "llm" && explicit.workers)) {
        throw new Error(`The LLM runtime is not ready: ${attempt.reason}. ${MODEL_SETUP_HINT}`)
      }
      notices.push(`LLM planning and review are off because ${attempt.reason}.`)
      if (plannerAsked) planner = "fixture"
      if (workers === "llm") workers = "fixture"
    } else models = attempt.config
  }

  const reviewer = (planner === "opencode" || workers === "opencode") && provider
    ? new OpenCodeRuntime({
      agentsDir: join(projectRoot, "agents"),
      directory: process.cwd(),
      providerID: provider.providerID,
      modelID: provider.modelID,
    })
    : undefined

  return {
    planner,
    workers,
    ...(models ? { models } : {}),
    ...(reviewer ? { reviewer } : {}),
    ...(notices.length
      ? { notice: `${notices.join(" ")} Running the deterministic runtime instead; configure it in Settings.` }
      : {}),
  }
}

/**
 * Whether OpenCode can serve this run, and why not when it cannot.
 *
 * The probe starts an OpenCode server, so it is held to a wall clock: a
 * provider that will not answer must delay a launch by seconds, not forever.
 */
async function openCodeFailure(provider: ProviderSelection | undefined): Promise<string | undefined> {
  if (!provider) return "no provider and model are selected"
  const timeout = new Promise<ProviderStatus>((resolve) => {
    setTimeout(() => resolve({
      ready: false,
      connectedProviders: [],
      error: "the provider did not answer within 15 seconds",
    }), 15_000)
  })
  const readiness = await Promise.race([
    inspectOpenCodeProviders(process.cwd(), provider)
      .catch((error: unknown) => ({
        ready: false,
        connectedProviders: [],
        error: error instanceof Error ? error.message : String(error),
      } satisfies ProviderStatus)),
    timeout,
  ])
  if (readiness.ready) return undefined
  // The diagnostic can come back empty once redaction has run over it.
  return readiness.error || "the selected provider, model, or credential is unavailable"
}

/**
 * The configuration this run can use, or the reason there is none. Never throws.
 *
 * Only the endpoints behind the roles the run needs are judged: a file may hold
 * a local server that is switched off and an endpoint kept for later without
 * that stopping a run whose roles all resolve somewhere reachable.
 */
async function modelConfigOrReason(roles: readonly ModelRole[]): Promise<{ config?: ModelConfig; reason?: string }> {
  let config: ModelConfig | undefined
  try {
    config = await findModelConfig()
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) }
  }
  if (!config) return { reason: "no model endpoint is configured" }

  const required = new Set<string>()
  for (const role of roles) {
    const binding = bindingForRole(config, role)
    if (!binding) return { reason: `no model is configured for the ${role} role` }
    required.add(binding.endpoint)
  }
  try {
    const readiness = await probeReadiness(config, Bun.env)
    const blocking = readiness.endpoints.filter((endpoint) =>
      required.has(endpoint.endpointId) && (!endpoint.reachable || endpoint.credential === "missing"))
    if (blocking.length) {
      const detail = blocking
        .map((endpoint) => `${endpoint.endpointId} (${endpoint.error ?? (endpoint.credential === "missing" ? "credential missing" : "unreachable")})`)
        .join(", ")
      return { reason: `the endpoint this run needs is unavailable: ${detail}` }
    }
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) }
  }
  return { config }
}

/**
 * Model configuration comes from an explicit path, the environment shorthand,
 * or a project file — in that order, so a local server needs no file at all.
 * Absence is a state, not a failure: the caller decides whether to refuse.
 */
async function findModelConfig(): Promise<ModelConfig | undefined> {
  const explicit = readFlag("--models") ?? Bun.env.CYRION_MODELS_CONFIG
  if (explicit) return loadModelConfig(absolute(explicit))
  const fromEnvironment = readEnvironmentConfig(Bun.env)
  if (fromEnvironment) return fromEnvironment
  const projectFile = absolute("cyrion.models.json")
  if (existsSync(projectFile)) return loadModelConfig(projectFile)
  return undefined
}

function runtimeProviderLabel(
  models: ModelConfig | undefined,
  provider: ProviderSelection | undefined,
  plannerMode: string,
  workerMode: string,
): string | undefined {
  if (models) {
    const planner = models.roles.planner
    const worker = models.roles.worker ?? planner
    const label = planner && worker && planner.model !== worker.model
      ? `${planner.model} + ${worker.model}`
      : planner?.model ?? worker?.model ?? "configured"
    return `${label} (ACTIVE)`
  }
  if (!provider) return undefined
  const active = plannerMode === "opencode" || workerMode === "opencode"
  return `${provider.providerID}/${provider.modelID} (${active ? "ACTIVE" : "CONFIGURED"})`
}

/**
 * Tells the operator what this machine can already do. A Kali or Parrot user
 * usually has the toolchain installed and wants `--sandbox local`; anyone else
 * gets the exact install command for what is missing, and never an implicit
 * package installation.
 */
/**
 * Runs a real engagement: skills chosen from the approved scope, capabilities
 * executed in the selected sandbox, evidence hashed locally, and every
 * transition validated by the controller before anything is dispatched.
 */
type EngagePlanner = "assessment" | "llm" | "llm-author"
type EngageWorkers = "capability" | "llm"


interface EngagementReview {
  planner: EngagePlanner
  workers: EngageWorkers
  models?: ModelConfig
  notice?: string
}

/**
 * Decides whether a provider reviews this engagement.
 *
 * A real run is deterministic by default: the planner and the workers are the
 * same ones a fixture run uses, and a model only ever reviews what they
 * produced. Naming a review mode on the command line is honoured or refused;
 * one inherited from saved defaults degrades to deterministic with the reason,
 * because a missing endpoint must never stop an authorized assessment.
 */
async function resolveEngagementReview(settings: { defaultPlanner: string; defaultWorkers: string }): Promise<EngagementReview> {
  const plannerFlag = readFlag("--planner")
  const workersFlag = readFlag("--workers")
  const planner = engagePlanner(plannerFlag ?? settings.defaultPlanner, !!plannerFlag)
  const workers = engageWorkers(workersFlag ?? settings.defaultWorkers, !!workersFlag)
  if (planner === "assessment" && workers === "capability") return { planner, workers }

  const needed: ModelRole[] = [
    ...(planner === "llm" || planner === "llm-author" ? ["planner" as const] : []),
    ...(workers === "llm" ? ["worker" as const, "validator" as const, "reporter" as const] : []),
  ]
  const attempt = await modelConfigOrReason(needed)
  if (!attempt.reason) return { planner, workers, ...(attempt.config ? { models: attempt.config } : {}) }

  const plannerAsked = planner !== "assessment"
  if ((plannerAsked && plannerFlag) || (workers === "llm" && workersFlag)) {
    throw new Error(`The LLM runtime is not ready: ${attempt.reason}. ${MODEL_SETUP_HINT}`)
  }
  return {
    planner: "assessment",
    workers: "capability",
    notice: `Provider review is off because ${attempt.reason}. `
      + "The engagement still runs with its deterministic planner and capability workers.",
  }
}

/** Saved defaults are shared with the fixture demo, where the word is "fixture". */
function engagePlanner(value: string, explicit: boolean): EngagePlanner {
  if (value === "assessment" || value === "fixture") return "assessment"
  if (value === "llm" || value === "llm-author") return value
  if (explicit) throw new Error("--planner must be assessment, llm, or llm-author for an engagement")
  // OpenCode review is a fixture-demo path; a real run falls back rather than refusing.
  return "assessment"
}

function engageWorkers(value: string, explicit: boolean): EngageWorkers {
  if (value === "capability" || value === "fixture") return "capability"
  if (value === "llm") return "llm"
  if (explicit) throw new Error("--workers must be capability or llm for an engagement")
  return "capability"
}

/** The model bound to each role this run will actually use, for the report. */
function reportModels(prepared: PreparedEngagement): Array<{ role: string; endpoint: string; model: string }> {
  if (!prepared.models) return []
  const roles: ModelRole[] = [
    ...(prepared.planner !== "assessment" ? ["planner" as const] : []),
    ...(prepared.workers === "llm" ? ["worker" as const, "validator" as const, "reporter" as const] : []),
  ]
  const entries: Array<{ role: string; endpoint: string; model: string }> = []
  for (const role of roles) {
    const binding = bindingForRole(prepared.models, role)
    if (binding) entries.push({ role, endpoint: binding.endpoint, model: binding.model })
  }
  return entries
}

interface PreparedEngagement {
  manifest: EngagementManifest
  controller: CyrionController
  planner: EngagePlanner
  workers: EngageWorkers
  models?: ModelConfig
  evidenceStore: LocalEvidenceStore
  registry: CapabilityRegistry
  runner: LocalToolRunner | ContainerToolRunner
  sandbox: SandboxKind
  skills: Skill[]
  artifactRoot: string
  /** The corpus `knowledge.search` read, when the manifest granted it. */
  corpus?: CorpusStatus
  /** Operator-approved MCP tools this run could call, when any were granted. */
  mcp?: McpCapabilities
  attestation?: string
  autoApprove: boolean
  headless: boolean
  close(): Promise<void>
}

/**
 * Builds an engagement from the manifest and the machine it will run on.
 *
 * `engage` and `ci` are the same run with different endings — one hands the
 * operator a terminal, the other hands a pipeline an exit code — so they share
 * every decision that could otherwise drift between them.
 */
async function prepareEngagement(options: { requireApproval: boolean }): Promise<PreparedEngagement> {
  const settings = readGeneralSettings(Bun.env)
  const manifestPath = absolute(readFlag("--scope") ?? readFlag("--manifest") ?? "engagement.json")
  if (!existsSync(manifestPath)) {
    throw new Error(`Engagement manifest not found: ${manifestPath}. Pass --scope <path>.`)
  }
  const manifest: unknown = await Bun.file(manifestPath).json()
  assertManifest(manifest)

  const mode = readFlag("--mode") ?? settings.defaultMode
  if (mode !== "autonomous" && mode !== "supervised") throw new Error("--mode must be autonomous or supervised")
  manifest.mode = mode

  const headless = args.includes("--headless") || !process.stdout.isTTY
  const autoApprove = args.includes("--approve-all")
  if (options.requireApproval && headless && manifest.mode === "supervised" && !autoApprove) {
    throw new Error("Headless supervised runs require --approve-all; interactive approval needs a TTY.")
  }

  const scopeLockPath = readFlag("--scope-lock")
  const scopeLock = scopeLockPath ? await Bun.file(absolute(scopeLockPath)).json() : undefined
  const attestation = scopeLock && typeof scopeLock === "object" && "attestation" in scopeLock
    ? String((scopeLock as { attestation: unknown }).attestation)
    : undefined

  const host = await detectHost()
  const requested = readFlag("--sandbox")
  if (requested && requested !== "local" && requested !== "container") {
    throw new Error("--sandbox must be local or container")
  }
  const sandbox: SandboxKind = (requested as SandboxKind | undefined)
    ?? (host.securityDistribution || !host.containerEngine ? "local" : "container")

  // A container's loopback is its own, so a lab on this machine's 127.0.0.1 is
  // not there at all. That is isolation working, but it reaches the operator as
  // a connection refused mid-run unless it is named here.
  if (sandbox === "container") {
    const unreachable = unreachableFromContainer(manifest.scope.targets)
    if (unreachable.length) {
      throw new Error(
        `${unreachable.join(", ")} is on this machine's loopback, which a container cannot reach — its own `
        + "loopback is a different network. Use --sandbox local for a target on this machine, or run the "
        + "target on the cyrion-sandbox network so the container can see it.",
      )
    }
  }

  const mcp = await mcpCapabilities(manifest.scope.capabilities, sandbox)

  // The image that will execute every tool is checked before the engagement
  // starts, not when the first capability runs: an operator finding out at the
  // first request has already spent an approval on a run that cannot work.
  if (sandbox === "container") {
    const engine = host.containerEngine ?? "docker"
    const pin = await workerImagePin()
    let status = await inspectWorkerImage(engine, workerImage())
    // Absent, so fetch it. Container is the default now, and a first run that
    // ends in "go and build this" is the ceremony this release removed.
    if (!status.present) {
      console.error(`cyrion: fetching the worker image ${terminalSafe(workerImage())} — this happens once`)
      const pull = await pullWorkerImage(engine, workerImage())
      status = await inspectWorkerImage(engine, workerImage())
      // One message rather than the engine's and then ours. The operator asked
      // to assess a target, not to read a registry error, and the sentence they
      // need is the one that says what to do next — including that container was
      // chosen for them, since otherwise the remedy looks like a demand.
      if (!status.present) {
        const chosen = readFlag("--sandbox")
          ? "You asked for --sandbox container."
          : "Container is the default because a worker runs code it wrote itself; "
            + "on this machine it is the only mode that confines that."
        throw new Error([
          `The worker image ${workerImage()} is not on this machine and could not be pulled.`,
          `  ${pull.detail}`,
          "",
          chosen,
          "",
          "Either build it once, which takes a few minutes:",
          "  ./containers/build-worker.sh",
          "",
          "Or run on this machine instead, unconfined:",
          "  --sandbox local",
        ].join("\n"))
      }
    }
    const imageError = workerImageError(status, pin.pin)
    if (imageError) throw new Error(imageError)
    const drift = workerImageDrift(status, pin.pin)
    if (drift) console.error(`cyrion: ${terminalSafe(drift)}`)
  }

  // A capability nobody implements would fail at dispatch, halfway through a
  // run, after the operator had already authorized it. Refuse at the start.
  const unserved = unservedCapabilities(manifest.scope.capabilities, mcp?.names() ?? [])
  if (unserved.length) {
    throw new Error(
      `No adapter implements ${unserved.join(", ")}. `
      + "Run `cyrion tools` to see which capabilities this release can serve, declare an MCP tool that answers "
      + "as one in mcp.json, and remove the rest from scope.capabilities.",
    )
  }

  const skills = await loadSkills(absolute(readFlag("--skills") ?? join(projectRoot, "skills")))
  if (!skills.length) throw new Error("No skills were loaded. Pass --skills <directory>.")

  const review = await resolveEngagementReview(settings)

  const artifactRoot = absolute(readFlag("--artifacts") ?? ".cyrion/artifacts")
  const evidenceStore = new LocalEvidenceStore(artifactRoot)
  const stateArgument = readFlag("--state")
  const store = stateArgument ? new SQLiteEngagementStore(absolute(stateArgument), manifest.id) : undefined

  // In a container, a capability implemented in-process falls back to a tool, so
  // that tool has to be on the allowlist or the request cannot leave the sandbox.
  const binaries = capabilityAdapters
    .filter((adapter) => manifest.scope.capabilities.includes(adapter.capability))
    .flatMap((adapter) => [adapter.binary, sandbox === "container" ? adapter.containerBinary : undefined])
    .filter((binary): binary is string => !!binary)
  const egress = sandbox === "container" ? await planEgress(manifest.scope) : undefined
  // A granted shell has no fixed binary, so the allowlist stops bounding the
  // run and the sandbox is what does. Said out loud when it is the operator's
  // own machine that is holding the line.
  const unbounded = needsUnboundedRunner(manifest.scope.capabilities)
  if (unbounded && sandbox === "local") {
    console.error(
      "cyrion: shell.exec runs commands this agent writes, on this machine, as you. "
      + "--sandbox container puts them behind a kernel boundary instead.",
    )
  }
  const runner = sandbox === "local"
    ? new LocalToolRunner({ allowedBinaries: binaries, ...(unbounded ? { allowAnyBinary: true } : {}) })
    : new ContainerToolRunner({
      engine: host.containerEngine ?? "docker",
      image: workerImage(),
      ...(await workerImagePin()),
      engagementId: manifest.id,
      allowedBinaries: binaries,
      ...(unbounded ? { allowAnyBinary: true } : {}),
      ...(egress ? { egress: egress.policy } : {}),
      ...(args.includes("--allow-unfiltered-egress") ? { allowUnfilteredEgress: true } : {}),
    })

  const knowledge = manifest.scope.capabilities.includes("knowledge.search")
    ? openCorpus(knowledgePath())
    : undefined
  const embedder = knowledge ? await optionalEmbedder() : undefined
  const credentials = await openCredentials()

  const registry = new CapabilityRegistry({
    runner,
    scope: manifest.scope,
    evidence: evidenceStore,
    capabilities: manifest.scope.capabilities,
    ...(knowledge ? { knowledge } : {}),
    ...(embedder ? { embedder } : {}),
    ...(credentials.size ? { credentials } : {}),
    ...(args.includes("--allow-host-browser") ? { allowHostBrowser: true } : {}),
    ...(mcp ? { extraAdapters: mcp.adapters() } : {}),
  })
  for (const pin of egress?.pins ?? []) registry.context.pins.set(pin.hostname, pin)

  // The deterministic planner and the capability workers are the engagement.
  // A provider may review each transition and each canonical result, or author
  // transitions the controller then validates — it never gains a tool.
  const deterministicPlanner = new AssessmentRootPlanner({ skills })
  const capabilityWorkers = new CapabilityWorkerRuntime({
    skills,
    ...(mcp ? { externalCapabilities: mcp.names() } : {}),
  })
  const rootPrompt = review.models
    ? await Bun.file(join(projectRoot, "agents/root/system.md")).text()
    : ""
  // A provider that will not answer must not outlast the engagement it is
  // reviewing: the controller checks its deadline between transitions, so a
  // single unbounded call would sail straight past it.
  const modelTimeoutMs = Math.max(5_000, Number(readFlag("--model-timeout") ?? 150_000))
  const workerClients = new Map<string, ReturnType<typeof createClient>>()
  const runtime: AgentRuntime = review.workers === "llm" && review.models
    ? new GuardedAgentRuntime(capabilityWorkers, new LlmWorkerReviewer((role) => {
      const modelRole = role === "validator" ? "validator" : role === "reporter" ? "reporter" : "worker"
      const existing = workerClients.get(modelRole)
      if (existing) return existing
      const client = createClient(review.models!, modelRole, Bun.env)
      workerClients.set(modelRole, client)
      return client
    }, { timeoutMs: modelTimeoutMs }))
    : capabilityWorkers
  const planner: RootPlanner = review.planner === "llm" && review.models
    ? new GuardedRootPlanner(
      deterministicPlanner,
      new LlmRootReviewer(createClient(review.models, "planner", Bun.env), rootPrompt, { timeoutMs: modelTimeoutMs }),
    )
    : review.planner === "llm-author" && review.models
      ? new LlmRootPlanner(createClient(review.models, "planner", Bun.env), rootPrompt, { timeoutMs: modelTimeoutMs })
      : deterministicPlanner

  const controller = new CyrionController(
    manifest,
    runtime,
    planner,
    join(projectRoot, "agents"),
    {
      ...(store ? { store } : {}),
      ...(scopeLock === undefined ? {} : { scopeLock }),
      toolGateway: new ScopedToolGateway(manifest, registry.toolAdapters()),
      autoApprove,
      evidenceStore,
    },
  )

  if (review.notice) console.error(`cyrion: ${terminalSafe(review.notice)}`)

  return {
    manifest,
    controller,
    planner: review.planner,
    workers: review.workers,
    ...(review.models ? { models: review.models } : {}),
    evidenceStore,
    registry,
    runner,
    sandbox,
    skills,
    artifactRoot,
    ...(knowledge ? { corpus: knowledge.status() } : {}),
    ...(mcp ? { mcp } : {}),
    ...(attestation ? { attestation } : {}),
    autoApprove,
    headless,
    close: async () => {
      controller.close()
      knowledge?.close()
      await mcp?.close()
      await runner.close()
    },
  }
}

/**
 * Operator-approved MCP tools this engagement may call, if any.
 *
 * Two deliberate acts are required and neither implies the other: the operator
 * declared the server and its tool allowlist in `mcp.json`, and the manifest
 * granted the capability that tool answers as. A configuration alone grants
 * nothing, and a grant with no declaration is caught by the unserved check.
 */
async function mcpCapabilities(
  granted: readonly string[],
  sandbox: SandboxKind,
): Promise<McpCapabilities | undefined> {
  const named = readFlag("--mcp")
  const path = absolute(named ?? "mcp.json")
  if (!existsSync(path)) {
    if (named) throw new Error(`MCP configuration not found: ${path}`)
    return undefined
  }
  let value: unknown
  try {
    value = await Bun.file(path).json()
  } catch {
    throw new Error(`MCP configuration is not valid JSON: ${path}`)
  }
  assertMcpConfig(value)
  const host = new McpCapabilities({ config: value, granted })
  if (!host.names().length) return undefined

  // An MCP server is a subprocess of this process, not of the sandbox: its
  // requests leave the host under the operator's own network, and the kernel
  // egress allowlist that governs every other capability does not see them.
  // Said once, so the transcript records where those requests came from.
  console.error(
    `cyrion: ${host.names().length} capabilit${host.names().length === 1 ? "y is" : "ies are"} served by MCP `
    + `(${terminalSafe(host.names().join(", "))}) — results are untrusted data, and the server runs on this host`
    + `${sandbox === "container" ? ", outside the container's egress allowlist" : ""}.`,
  )
  return host
}

function knowledgePath(): string {
  return absolute(readFlag("--knowledge") ?? ".cyrion/knowledge.sqlite")
}

function credentialsPath(): string {
  return absolute(readFlag("--credentials") ?? Bun.env.CYRION_CREDENTIALS ?? "cyrion.credentials.json")
}

/**
 * Reads the operator's credential store, and says so without saying what is in
 * it.
 *
 * The line is printed because an engagement that authenticates is a materially
 * different run from one that does not, and the operator should be able to see
 * from the transcript which one they got. Names and hosts are printed; values
 * are not, here or anywhere else.
 */
async function openCredentials(): Promise<OperatorCredentials> {
  const path = credentialsPath()
  const credentials = await loadCredentials(path)
  if (credentials.size) {
    const named = credentials.list().map((entry) => `${entry.name} → ${entry.hosts.join(", ")}`)
    console.log(`cyrion: ${credentials.size} credential(s) loaded from ${terminalSafe(path)}: ${named.join("; ")}`)
  }
  return credentials
}

/**
 * Opens the corpus a granted `knowledge.search` will read.
 *
 * A granted capability with nothing behind it fails at dispatch, halfway
 * through a run the operator already authorized. Refusing here is the same
 * discipline as the unimplemented-capability check above.
 */
function openCorpus(path: string): KnowledgeStore {
  if (!existsSync(path)) {
    throw new Error(
      `knowledge.search is granted but no corpus exists at ${path}. `
      + "Run `cyrion knowledge sync` first, or remove knowledge.search from scope.capabilities.",
    )
  }
  const store = KnowledgeStore.open(path)
  if (!store.status().documents) {
    store.close()
    throw new Error(`The corpus at ${path} holds no documents. Run \`cyrion knowledge sync\` to ingest one.`)
  }
  return store
}

/**
 * The embedding client, when one is configured.
 *
 * Absent is a supported answer, not a degraded one: retrieval falls back to
 * lexical search, and the search result says so rather than presenting keyword
 * matches as semantic ones.
 */
async function optionalEmbedder(): Promise<Embedder | undefined> {
  const config = await findModelConfig().catch(() => undefined)
  if (!config?.roles.embedding) return undefined
  try {
    return createEmbeddingClient(config, Bun.env)
  } catch {
    return undefined
  }
}

/**
 * The corpus this run could consult, as the report states it.
 *
 * Recorded even when nothing was retrieved: what a worker was allowed to read
 * is part of how the engagement was conducted, and a reader comparing two
 * reports needs to know whether they were working from the same text.
 */
function knowledgeRecord(corpus: CorpusStatus | undefined): KnowledgeRecord | undefined {
  if (!corpus) return undefined
  return {
    corpusVersion: corpus.corpusVersion,
    documents: corpus.documents,
    chunks: corpus.chunks,
    retrieval: corpus.embedded ? "hybrid" : "lexical",
    sources: corpus.sources.map((source) => ({
      id: source.id,
      license: source.license,
      documents: source.documents,
    })),
    ...(corpus.embeddingModel ? { embeddingModel: corpus.embeddingModel } : {}),
  }
}

/** Tool versions the run could have used, recorded as part of the report. */
async function recordToolVersions(prepared: PreparedEngagement): Promise<Array<{ name: string; version: string }>> {
  const tools: Array<{ name: string; version: string }> = []
  for (const binary of prepared.registry.requiredBinaries()) {
    const info = await prepared.runner.lookup(binary).catch(() => undefined)
    if (info) tools.push({ name: info.name, version: info.version ?? "present, version not reported" })
  }
  // Which image the tools came from is provenance, the same as their versions:
  // "nmap 7.99" means something different from a different image's nmap 7.99.
  const image = prepared.runner instanceof ContainerToolRunner ? prepared.runner.imageStatus : undefined
  if (image) tools.push({ name: `image:${image.image}`, version: workerImageLabel(image) })

  // An MCP tool is as much a part of how the engagement was conducted as a
  // binary is, and the report has to be able to say which one answered.
  for (const entry of prepared.mcp?.describe() ?? []) {
    tools.push({
      name: `mcp:${entry.server}/${entry.tool} → ${entry.capability}`,
      version: entry.serverVersion
        ? `${entry.serverName ?? entry.server} ${entry.serverVersion}`
        : "declared, never called",
    })
  }
  return tools
}

/**
 * Runs a real engagement: skills chosen from the approved scope, capabilities
 * executed in the selected sandbox, evidence hashed locally, and every
 * transition validated by the controller before anything is dispatched.
 */
/** `engage`, plus whatever the operator starts from Mission when it closes. */
async function runEngagementSession(): Promise<void> {
  const next = await runEngagement()
  if (next) await engageScan(next)
}

/** Runs one engagement, and reports the assessment the operator started from Mission. */
async function runEngagement(): Promise<ScanInput | undefined> {
  const prepared = await prepareEngagement({ requireApproval: true })
  const { controller } = prepared
  try {
    if (prepared.headless) {
      controller.events.subscribe((event) => console.log(JSON.stringify(event)))
      const result = await controller.run()
      console.log(JSON.stringify({
        ...statusSummary(result),
        sandbox: prepared.sandbox,
        planner: prepared.planner,
        workers: prepared.workers,
        skills: prepared.skills.map((skill) => skill.id),
      }))
      if (result.status !== "completed") process.exitCode = 1
      return undefined
    }
    const exit = await runTui(
      controller,
      prepared.evidenceStore,
      {
        mode: "live",
        planner: prepared.planner === "assessment" ? "assessment" : prepared.planner,
        workers: prepared.workers,
        sandbox: prepared.sandbox,
        ...(prepared.attestation ? { attestation: prepared.attestation } : {}),
      },
      join(prepared.artifactRoot, "..", "reports"),
      // The machine's sandbox carries over; the target and its authorization
      // never do, because they are decisions about the next assessment.
      { ...defaultScanInput, sandbox: prepared.sandbox },
    )
    return exit.kind === "scan" ? exit.input : undefined
  } finally {
    await prepared.close()
  }
}

/**
 * Runs one capability by hand against an approved target. Everything the
 * controller enforces still applies — scope, capability grant, timeout, output
 * ceiling — and the raw output is stored as hashed evidence.
 */
async function runProbe(): Promise<void> {
  const capability = readFlag("--capability")
  const target = readFlag("--target")
  if (!capability || !target) {
    throw new Error("probe requires --capability <name> and --target <expression>")
  }
  const manifestPath = absolute(readFlag("--manifest") ?? "engagement.json")
  if (!existsSync(manifestPath)) {
    throw new Error(`Engagement manifest not found: ${manifestPath}. Pass --manifest <path>.`)
  }
  const manifest: unknown = await Bun.file(manifestPath).json()
  assertManifest(manifest)
  if (!manifest.scope.capabilities.includes(capability)) {
    throw new Error(`${capability} is not granted by ${terminalSafe(manifest.id)}. Add it to scope.capabilities.`)
  }

  const host = await detectHost()
  const requested = readFlag("--sandbox")
  if (requested && requested !== "local" && requested !== "container") {
    throw new Error("--sandbox must be local or container")
  }
  const kind: SandboxKind = (requested as SandboxKind | undefined)
    ?? (host.securityDistribution || !host.containerEngine ? "local" : "container")

  const artifactRoot = absolute(readFlag("--artifacts") ?? ".cyrion/artifacts")
  const evidenceStore = new LocalEvidenceStore(artifactRoot)
  // In a container, a capability implemented in-process falls back to a tool, so
  // that tool has to be on the allowlist or the request cannot leave the sandbox.
  const binaries = capabilityAdapters
    .filter((adapter) => manifest.scope.capabilities.includes(adapter.capability))
    .flatMap((adapter) => [adapter.binary, kind === "container" ? adapter.containerBinary : undefined])
    .filter((binary): binary is string => !!binary)

  // The allowlist is built from the approved scope before anything starts, so a
  // container never runs with a wider reach than the engagement was granted.
  const egress = kind === "container" ? await planEgress(manifest.scope) : undefined
  if (egress?.unresolved.length) {
    console.error(`cyrion: no address could be pinned for ${egress.unresolved.map((item) => terminalSafe(item)).join(", ")}`)
  }

  const probeUnbounded = needsUnboundedRunner([capability])
  const runner = kind === "local"
    ? new LocalToolRunner({ allowedBinaries: binaries, ...(probeUnbounded ? { allowAnyBinary: true } : {}) })
    : new ContainerToolRunner({
      engine: host.containerEngine ?? "docker",
      image: workerImage(),
      ...(await workerImagePin()),
      engagementId: manifest.id,
      allowedBinaries: binaries,
      ...(probeUnbounded ? { allowAnyBinary: true } : {}),
      ...(egress ? { egress: egress.policy } : {}),
      ...(args.includes("--allow-unfiltered-egress") ? { allowUnfilteredEgress: true } : {}),
    })

  // Only the capability being probed needs its corpus: an operator checking
  // http.probe should not be stopped by a knowledge store they have not built.
  const knowledge = capability === "knowledge.search" ? openCorpus(knowledgePath()) : undefined
  const embedder = knowledge ? await optionalEmbedder() : undefined
  // An MCP-backed capability is probed the same way a built-in one is: by hand,
  // under the same grant, scope check, and evidence rules.
  const mcp = await mcpCapabilities([capability], kind)

  const probeCredentials = await openCredentials()
  const registry = new CapabilityRegistry({
    runner,
    scope: manifest.scope,
    evidence: evidenceStore,
    capabilities: manifest.scope.capabilities,
    ...(knowledge ? { knowledge } : {}),
    ...(embedder ? { embedder } : {}),
    ...(probeCredentials.size ? { credentials: probeCredentials } : {}),
    ...(args.includes("--allow-host-browser") ? { allowHostBrowser: true } : {}),
    ...(mcp ? { extraAdapters: mcp.adapters() } : {}),
  })
  // Pins used for the allowlist are the pins later connections are held to.
  for (const pin of egress?.pins ?? []) registry.context.pins.set(pin.hostname, pin)

  const controller = new AbortController()
  const timeoutMs = Number(readFlag("--timeout") ?? 60_000)
  const timer = setTimeout(() => controller.abort(new Error("probe timed out")), timeoutMs + 5_000)
  try {
    const result = await registry.execute({
      engagementId: manifest.id,
      taskId: "PROBE",
      agentId: `operator-${kind}`,
      capability,
      target,
      timeoutMs,
      maxOutputBytes: Number(readFlag("--max-output") ?? 1_000_000),
      input: readFlag("--input") ? JSON.parse(readFlag("--input")!) : {},
    }, controller.signal)

    if (args.includes("--json")) {
      console.log(JSON.stringify({ capability, target, sandbox: kind, ...result }))
    } else {
      console.log([
        `CYRION/AI  PROBE  ${terminalSafe(capability)}`,
        `target       ${terminalSafe(target)}`,
        `sandbox      ${kind.toUpperCase()}`,
        "",
        terminalSafe(JSON.stringify(result.summary, null, 2), 4_000),
        "",
        ...result.evidence.map((item) => `evidence     ${item.id}  ${item.sha256.slice(0, 16)}…  ${terminalSafe(item.uri)}`),
      ].join("\n"))
    }
  } finally {
    clearTimeout(timer)
    knowledge?.close()
    await mcp?.close()
    await runner.close()
  }
}


/**
 * Re-runs a stored proof bundle and compares the verdict with the recorded one.
 *
 * The bundle is data, not authority: the current manifest decides whether every
 * step is still in scope, and the run happens under the same capability grant,
 * pinning, and evidence rules an engagement uses. A bundle that no longer
 * reproduces is reported as such rather than quietly re-confirmed.
 */
async function runReplay(): Promise<void> {
  const findingArgument = args[1] && !args[1].startsWith("-") ? args[1] : undefined
  const bundleArgument = readFlag("--bundle")
  if (!findingArgument && !bundleArgument) {
    throw new Error("replay requires a finding ID, or --bundle <path> to a stored bundle")
  }

  const manifestPath = absolute(readFlag("--manifest") ?? readFlag("--scope") ?? "engagement.json")
  if (!existsSync(manifestPath)) {
    throw new Error(`Engagement manifest not found: ${manifestPath}. Pass --manifest <path>.`)
  }
  const manifest: unknown = await Bun.file(manifestPath).json()
  assertManifest(manifest)
  if (!manifest.scope.capabilities.includes("poc.run")) {
    throw new Error(
      `poc.run is not granted by ${terminalSafe(manifest.id)}. `
      + "Add it to scope.capabilities to replay a proof bundle.",
    )
  }

  const artifactRoot = absolute(readFlag("--artifacts") ?? ".cyrion/artifacts")
  const located = bundleArgument
    ? await readBundleFile(absolute(bundleArgument))
    : await findBundle(join(artifactRoot, manifest.id), findingArgument!)
  const bundle = located.bundle

  // The recorded scope proved nothing about today's authorization.
  for (const step of bundle.plan.steps) {
    const decision = evaluateScope(manifest.scope, step.url)
    if (!decision.allowed) {
      throw new Error(`Bundle step ${step.id} is outside the approved scope: ${step.url} (${decision.reason})`)
    }
  }

  const host = await detectHost()
  const requested = readFlag("--sandbox")
  if (requested && requested !== "local" && requested !== "container") {
    throw new Error("--sandbox must be local or container")
  }
  const kind: SandboxKind = (requested as SandboxKind | undefined)
    ?? (host.securityDistribution || !host.containerEngine ? "local" : "container")

  const evidenceStore = new LocalEvidenceStore(artifactRoot)
  const egress = kind === "container" ? await planEgress(manifest.scope) : undefined
  const runner = kind === "local"
    ? new LocalToolRunner({ allowedBinaries: binariesFor(["poc.run"]) })
    : new ContainerToolRunner({
      engine: host.containerEngine ?? "docker",
      image: workerImage(),
      ...(await workerImagePin()),
      engagementId: manifest.id,
      allowedBinaries: binariesFor(["poc.run"]),
      ...(egress ? { egress: egress.policy } : {}),
      ...(args.includes("--allow-unfiltered-egress") ? { allowUnfilteredEgress: true } : {}),
    })
  // A bundle records the credential's name rather than its value, so a replay
  // needs the operator's store to authenticate the way the original run did.
  // That is the point of storing the reference: the bundle is shareable, and
  // whoever replays it supplies their own secret.
  const replayCredentials = await openCredentials()
  const registry = new CapabilityRegistry({
    runner,
    scope: manifest.scope,
    evidence: evidenceStore,
    capabilities: ["poc.run"],
    ...(replayCredentials.size ? { credentials: replayCredentials } : {}),
  })
  for (const pin of egress?.pins ?? []) registry.context.pins.set(pin.hostname, pin)

  const controller = new AbortController()
  const timeoutMs = Number(readFlag("--timeout") ?? 60_000)
  const timer = setTimeout(() => controller.abort(new Error("replay timed out")), timeoutMs + 5_000)
  try {
    const result = await registry.execute({
      engagementId: manifest.id,
      taskId: "REPLAY",
      agentId: `operator-${kind}`,
      capability: "poc.run",
      target: bundle.plan.steps[0]!.url,
      timeoutMs,
      maxOutputBytes: 1_000_000,
      input: { plan: bundle.plan },
    }, controller.signal)

    const summary = result.summary as { verdict: string; bundleId: string; steps: Array<{ detail: string }> }
    const matches = summary.verdict === bundle.verdict
    if (args.includes("--json")) {
      console.log(JSON.stringify({
        findingId: bundle.findingId,
        source: located.path,
        recorded: { verdict: bundle.verdict, capturedAt: bundle.createdAt, runner: bundle.runner },
        replay: { verdict: summary.verdict, bundleId: summary.bundleId, sandbox: kind },
        matches,
        evidence: result.evidence.map(({ id, sha256, uri }) => ({ id, sha256, uri })),
      }))
    } else {
      console.log([
        `CYRION/AI  REPLAY  ${terminalSafe(bundle.findingId)}`,
        `bundle       ${terminalSafe(located.path)}`,
        `captured     ${terminalSafe(bundle.createdAt)} on ${bundle.runner}, verdict ${bundle.verdict.toUpperCase()}`,
        `target       ${terminalSafe(bundle.plan.steps[0]!.url)}`,
        `sandbox      ${kind.toUpperCase()}`,
        `replayed     ${summary.verdict.toUpperCase()}  ${matches ? "(matches the recorded verdict)" : "(DIFFERS from the recorded verdict)"}`,
        "",
        ...summary.steps.map((step, index) => `step ${index + 1}      ${terminalSafe(step.detail, 160)}`),
        "",
        ...result.evidence.map((item) => `evidence     ${item.id}  ${item.sha256.slice(0, 16)}…  ${terminalSafe(item.uri)}`),
      ].join("\n"))
    }
    if (!matches) process.exitCode = 1
  } finally {
    clearTimeout(timer)
    await runner.close()
  }
}

interface LocatedBundle {
  path: string
  bundle: PocBundle
}

async function readBundleFile(path: string): Promise<LocatedBundle> {
  if (!existsSync(path)) throw new Error(`Proof bundle not found: ${path}`)
  let value: unknown
  try {
    value = await Bun.file(path).json()
  } catch {
    throw new Error(`Proof bundle is not valid JSON: ${path}`)
  }
  const error = pocBundleContractError(value)
  if (error) throw new Error(`Proof bundle is invalid: ${error}`)
  return { path, bundle: value as PocBundle }
}

/** The newest bundle stored for one finding, so a re-validated claim replays its latest proof. */
async function findBundle(directory: string, findingId: string): Promise<LocatedBundle> {
  const entries = await readdir(directory).catch(() => [])
  const found: LocatedBundle[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.endsWith(".meta.json")) continue
    const value: unknown = await Bun.file(join(directory, entry)).json().catch(() => undefined)
    if (!value || pocBundleContractError(value)) continue
    const bundle = value as PocBundle
    if (bundle.findingId === findingId) found.push({ path: join(directory, entry), bundle })
  }
  if (!found.length) {
    throw new Error(
      `No proof bundle for ${findingId} was found in ${directory}. `
      + "Run the engagement with poc.run granted, or pass --bundle <path>.",
    )
  }
  return found.sort((left, right) =>
    Date.parse(right.bundle.createdAt) - Date.parse(left.bundle.createdAt))[0]!
}


const reportFormats = ["markdown", "json", "html", "sarif", "junit", "csv"] as const
type ReportFormat = (typeof reportFormats)[number]

const reportExtensions: Record<ReportFormat, string> = {
  markdown: "md",
  json: "json",
  html: "html",
  sarif: "sarif.json",
  junit: "junit.xml",
  csv: "csv",
}

function renderReport(
  format: ReportFormat,
  snapshot: EngagementSnapshot,
  context: ReportContext,
  failOn: Severity,
): string {
  if (format === "markdown") return renderMarkdownReport(snapshot, context)
  if (format === "json") return renderJsonReport(snapshot, context)
  if (format === "html") return renderHtmlReport(snapshot, context)
  if (format === "sarif") return renderSarifReport(snapshot, context)
  if (format === "csv") return renderCsvReport(snapshot, context)
  return renderJUnitReport(snapshot, { ...context, failOn })
}

function readFormats(fallback: ReportFormat[]): ReportFormat[] {
  const requested = readFlag("--formats")
  if (!requested) return fallback
  const chosen = requested.split(",").map((value) => value.trim()).filter(Boolean)
  for (const format of chosen) {
    if (!reportFormats.includes(format as ReportFormat)) {
      throw new Error(`--formats must name ${reportFormats.join(", ")}`)
    }
  }
  return chosen as ReportFormat[]
}

function readSeverity(flag: string, fallback: Severity): Severity {
  const value = readFlag(flag)
  if (!value) return fallback
  if (!severities.includes(value as Severity)) throw new Error(`${flag} must be one of ${severities.join(", ")}`)
  return value as Severity
}

/**
 * Runs an engagement and turns its record into a pipeline decision.
 *
 * The gate counts confirmed findings only: a candidate nobody validated is not
 * evidence of a problem, and a gate that fails on one teaches a team to ignore
 * it. Reports are written before the exit code is decided, so a failing build
 * still leaves the operator everything needed to read why.
 */
async function runCi(): Promise<void> {
  const failOn = readSeverity("--fail-on", "high")
  const failOnUnresolved = args.includes("--fail-on-unresolved")
  const formats = readFormats(["markdown", "json", "junit"])
  const reportDirectory = absolute(readFlag("--report") ?? ".cyrion/reports")

  const prepared = await prepareEngagement({ requireApproval: false })
  // A pipeline has nobody to approve a delegation; supervised runs auto-approve
  // here and the report states the mode that was actually in force.
  const snapshot = await (async () => {
    try {
      if (args.includes("--verbose")) prepared.controller.events.subscribe((event) => console.error(JSON.stringify(event)))
      return await prepared.controller.run()
    } finally {
      await prepared.close()
    }
  })()

  const models = reportModels(prepared)
  const knowledge = knowledgeRecord(prepared.corpus)
  const context: ReportContext = {
    sandbox: prepared.sandbox,
    runtime: { planner: prepared.planner, workers: prepared.workers },
    tools: await recordToolVersions(prepared).catch(() => []),
    ...(models.length ? { models } : {}),
    ...(knowledge ? { knowledge } : {}),
    ...(prepared.attestation ? { attestation: prepared.attestation } : {}),
  }
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 })
  const written: string[] = []
  for (const format of formats) {
    const path = join(reportDirectory, `${prepared.manifest.id}.${reportExtensions[format]}`)
    await Bun.write(path, renderReport(format, snapshot, context, failOn))
    written.push(path)
  }

  const gate = evaluateGate(snapshot, { failOn, failOnUnresolved })
  const report = buildCommunityReport(snapshot, context)
  if (args.includes("--json")) {
    console.log(JSON.stringify({
      engagementId: report.engagement.id,
      status: report.engagement.status,
      failOn,
      passed: gate.passed,
      reasons: gate.reasons,
      summary: report.summary,
      severities: report.severities,
      reports: written,
    }))
  } else {
    console.log([
      `CYRION/AI  CI  ${terminalSafe(report.engagement.id)}`,
      `status       ${report.engagement.status.toUpperCase()}`,
      `sandbox      ${prepared.sandbox.toUpperCase()}`,
      `findings     ${report.summary.confirmed} confirmed (${report.summary.reproduced} reproduced) / `
        + `${report.summary.rejected} rejected / ${report.summary.unresolved} unresolved`,
      `severities   ${severities.map((severity) => `${severity} ${report.severities[severity]}`).join("  ")}`,
      `refusals     ${report.summary.refusals}`,
      `gate         ${gate.passed ? "PASS" : "FAIL"} (--fail-on ${failOn})`,
      ...gate.reasons.map((reason) => `             ${terminalSafe(reason)}`),
      "",
      ...written.map((path) => `report       ${terminalSafe(path)}`),
    ].join("\n"))
  }
  if (!gate.passed) process.exitCode = 1
}


/**
 * Cyrion on both sides of MCP.
 *
 * `serve` exposes an engagement to another agent as records it can read but not
 * widen. `list` and `call` drive an operator-approved server from here, so the
 * allowlist and the capability mapping can be checked before a worker relies on
 * them.
 */
async function runMcp(): Promise<void> {
  const subcommand = args[1] ?? "serve"
  if (subcommand === "serve") return runMcpServe()
  if (subcommand === "list" || subcommand === "call") return runMcpClient(subcommand)
  throw new Error("mcp requires serve, list, or call")
}

async function readMcpConfig(): Promise<McpConfig> {
  const path = absolute(readFlag("--config") ?? "mcp.json")
  if (!existsSync(path)) throw new Error(`MCP configuration not found: ${path}. Pass --config <path>.`)
  let value: unknown
  try {
    value = await Bun.file(path).json()
  } catch {
    throw new Error(`MCP configuration is not valid JSON: ${path}`)
  }
  assertMcpConfig(value)
  // The rule a run applies, checked where an operator looks before starting one:
  // an MCP tool may not answer as a capability Cyrion implements itself.
  new McpCapabilities({ config: value, granted: [] })
  return value
}

async function runMcpServe(): Promise<void> {
  // Pointed at a manifest, the server can start that engagement; pointed at a
  // state database, it reads a run somebody else started. The argument says
  // which, so there is no flag to remember.
  if (readFlag("--scope") || readFlag("--manifest")) return runMcpServeStartable()

  const stateArgument = readFlag("--state")
  const engagementId = readFlag("--engagement")
  const artifactRoot = absolute(readFlag("--artifacts") ?? ".cyrion/artifacts")
  if (!stateArgument || !engagementId) {
    throw new Error("mcp serve requires --state <sqlite-path> and --engagement <id>")
  }
  const databasePath = absolute(stateArgument)
  if (!existsSync(databasePath)) throw new Error(`State database not found: ${databasePath}`)
  const store = new SQLiteEngagementStore(databasePath, engagementId)

  const server = new CyrionMcpServer({
    // Read per request: another agent watching a live run sees it progress.
    snapshot: () => store.loadSnapshot() ?? undefined,
    evidence: new LocalEvidenceStore(artifactRoot),
    version: CLI_VERSION,
  })
  console.error(
    `cyrion: MCP server ready for ${terminalSafe(engagementId)} (read-only, `
    + `${server.tools.length} tools) — speaking JSON-RPC on stdio`,
  )
  try {
    await serveStdio(server, { onError: (message) => console.error(`cyrion: ${terminalSafe(message)}`) })
  } finally {
    store.close()
  }
}

/**
 * The server that can also start the engagement the operator prepared.
 *
 * The caller chooses nothing: the scope, the capabilities, the sandbox, and the
 * authorization are all decided before this process starts speaking, by the
 * manifest and the scope lock on disk. `start_engagement` only releases work
 * that was already authorized — the calling agent has to repeat the operator's
 * attestation to do it, and cannot widen anything by asking differently.
 */
async function runMcpServeStartable(): Promise<void> {
  // Every refusal a command-line run would make happens here, before the first
  // frame: an unserved capability, a loopback target in a container, a
  // supervised mode nobody can approve over stdio.
  const prepared = await prepareEngagement({ requireApproval: true })

  // A caller starts the engagement the operator prepared and picks nothing:
  // scope, capabilities, sandbox and mode were all decided before the server
  // spoke. Where the operator kept a scope lock with an attestation in it, the
  // caller repeats that too — a record they asked for, not a gate.
  const attestation = prepared.attestation?.trim()

  let run: Promise<EngagementSnapshot> | undefined
  const server = new CyrionMcpServer({
    snapshot: () => prepared.controller.snapshot,
    evidence: prepared.evidenceStore,
    version: CLI_VERSION,
    startEngagement: async (input) => {
      if (attestation && input.attestation !== attestation) {
        throw new Error(
          "The attestation does not match the operator's scope lock. Repeat the attestation recorded in the "
          + "lock exactly; this server cannot accept a new authorization.",
        )
      }
      if (!run) {
        console.error(`cyrion: ${terminalSafe(prepared.manifest.id)} started over MCP`)
        run = prepared.controller.run()
        // The run owns the process from here; a rejection is reported through
        // the snapshot the caller reads, never as an unhandled failure.
        run.catch(() => undefined)
      }
      return { engagementId: prepared.manifest.id, status: prepared.controller.snapshot.status }
    },
  })

  console.error(
    `cyrion: MCP server ready for ${terminalSafe(prepared.manifest.id)} (${server.tools.length} tools, `
    + `start enabled, sandbox ${prepared.sandbox.toUpperCase()}) — speaking JSON-RPC on stdio`,
  )
  try {
    await serveStdio(server, { onError: (message) => console.error(`cyrion: ${terminalSafe(message)}`) })
  } finally {
    // The peer hung up. An engagement it started does not outlive the
    // conversation: it is cancelled, and what it recorded stays on disk.
    if (run) {
      await prepared.controller.cancel().catch(() => undefined)
      await run.catch(() => undefined)
    }
    await prepared.close()
  }
}

async function runMcpClient(subcommand: "list" | "call"): Promise<void> {
  const config = await readMcpConfig()
  const serverId = readFlag("--server")
  const selected = serverId ? config.servers.filter((server) => server.id === serverId) : config.servers
  if (!selected.length) throw new Error(`No MCP server named ${serverId} is configured`)

  // A configured server is not an authorization: the manifest still decides.
  const manifestPath = readFlag("--manifest")
  if (manifestPath) {
    const manifest: unknown = await Bun.file(absolute(manifestPath)).json()
    assertManifest(manifest)
    const ungranted = ungrantedCapabilities(config, manifest.scope.capabilities)
    if (ungranted.length) {
      console.error(
        `cyrion: ${ungranted.map((capability) => terminalSafe(capability)).join(", ")} `
        + `${ungranted.length === 1 ? "is" : "are"} declared in mcp.json but not granted by `
        + `${terminalSafe(manifest.id)}; a worker cannot call ${ungranted.length === 1 ? "it" : "them"}.`,
      )
    }
  }

  if (subcommand === "list") {
    const rows: object[] = []
    for (const server of selected) {
      const client = new McpStdioClient(server)
      try {
        const tools = await client.listTools()
        rows.push({ server: server.id, info: client.serverInfo ?? {}, tools })
        if (!args.includes("--json")) {
          console.log(`server       ${terminalSafe(server.id)}  ${terminalSafe(client.serverInfo?.name ?? "unknown")}`)
          for (const tool of tools) {
            const binding = server.tools.find((entry) => entry.tool === tool.name)
            console.log(
              `  ${tool.allowed ? "+" : "-"} ${terminalSafe(tool.name).padEnd(28)}`
              + `${binding ? `→ ${terminalSafe(binding.capability)}` : "not allowed by mcp.json"}`,
            )
          }
        }
      } finally {
        await client.close()
      }
    }
    if (args.includes("--json")) console.log(JSON.stringify(rows))
    return
  }

  const toolName = readFlag("--tool")
  if (!toolName) throw new Error("mcp call requires --tool <name>")
  const server = selected[0]!
  const client = new McpStdioClient(server)
  try {
    const input = readFlag("--input") ? JSON.parse(readFlag("--input")!) : {}
    const outcome = await client.call(toolName, input)
    if (args.includes("--json")) console.log(JSON.stringify({ server: server.id, tool: toolName, ...outcome }))
    else {
      console.log([
        `CYRION/AI  MCP CALL  ${terminalSafe(server.id)}/${terminalSafe(toolName)}`,
        `capability   ${terminalSafe(server.tools.find((tool) => tool.tool === toolName)?.capability ?? "unmapped")}`,
        `duration     ${outcome.durationMs}ms${outcome.truncated ? "  (result truncated)" : ""}`,
        `status       ${outcome.isError ? "SERVER REPORTED AN ERROR" : "OK"}`,
        "",
        "-- untrusted result, treat as data --",
        terminalSafe(outcome.text, 8_000),
      ].join("\n"))
    }
    if (outcome.isError) process.exitCode = 1
  } finally {
    await client.close()
  }
}


/**
 * The short path from "I want to scan this" to a running assessment.
 *
 * Everything a scan needs is decided once — the address, what it may do, and
 * who authorized it — and written to a manifest and a scope lock the operator
 * keeps. Nothing here bypasses a control: the same controller, the same scope
 * engine, and the same attestation requirement apply. It only removes the
 * requirement to assemble them by hand.
 */
async function runScan(): Promise<void> {
  // `cyrion hack acme.test` — the target is the argument, because that is the
  // whole sentence. `--target` still works, and `scan` still opens the form.
  const positional = args[1] && !args[1].startsWith("-") ? args[1] : undefined
  const flagTarget = readFlag("--target") ?? positional
  const headless = args.includes("--headless") || !process.stdout.isTTY
  const requested = readFlag("--sandbox")
  if (requested && requested !== "local" && requested !== "container") {
    throw new Error("--sandbox must be local or container")
  }
  const detected: SandboxKind = (requested as SandboxKind | undefined) ?? await detectSandbox()

  const mode = readFlag("--mode") ?? "autonomous"
  if (mode !== "autonomous" && mode !== "supervised") throw new Error("--mode must be autonomous or supervised")
  const requestedCapabilities = readFlag("--capabilities")?.split(",").map((value) => value.trim()).filter(Boolean)
  for (const capability of requestedCapabilities ?? []) {
    if (!scanCapabilities.some((entry) => entry.name === capability)) {
      throw new Error(`--capabilities may name ${scanCapabilities.map((entry) => entry.name).join(", ")}`)
    }
  }

  const initial: ScanInput = {
    ...defaultScanInput,
    sandbox: detected,
    mode,
    ...(flagTarget ? { target: flagTarget } : {}),
    ...(readFlag("--attest") ? { attestation: readFlag("--attest")! } : {}),
    ...(requestedCapabilities ? { capabilities: requestedCapabilities as ScanInput["capabilities"] } : {}),
    ...(readFlag("--name") ? { name: readFlag("--name")! } : {}),
  }

  // A target on the command line is an answer, not a draft: `cyrion hack x`
  // runs, and the form is for the operator who did not bring one.
  const chosen = headless || flagTarget
    ? initial
    : await runLaunchScreen(initial)
  if (!chosen) {
    console.error("cyrion: no assessment was started")
    return
  }
  const prepared = await writeScanFiles(chosen)
  if (args.includes("--dry-run")) {
    console.error("cyrion: --dry-run, so nothing was executed. Start it with:")
    console.error(
      `  cyrion engage --scope ${terminalSafe(prepared.manifestPath)} `
      + `--scope-lock ${terminalSafe(prepared.lockPath)}`,
    )
    return
  }

  // Hand the prepared engagement to the same path `cyrion engage` uses.
  const argv = engageArgv(
    chosen,
    prepared,
    headless,
    passThrough(["--planner", "--workers", "--artifacts", "--state", "--skills", "--model-timeout"]),
  )
  args.splice(0, args.length, "engage", ...argv)
  const next = await runEngagement()
  if (next) await engageScan(next)
}

/** The worker image this run will use: the operator's, or the release's. */
function workerImage(): string {
  return readFlag("--image") ?? DEFAULT_WORKER_IMAGE
}

/**
 * What the release says its worker image is.
 *
 * The manifest is written by `containers/build-worker.sh` from the image it
 * actually built, so this is a record rather than an intention. It is applied
 * only to the image it names: an operator who passed `--image` asked for
 * something else deliberately, and the runner says so instead of refusing it.
 */
async function workerImagePin(): Promise<{ pin?: WorkerImagePin }> {
  const path = join(projectRoot, "containers", "worker-manifest.json")
  if (!existsSync(path)) return {}
  const value = await Bun.file(path).json().catch(() => undefined) as
    { image?: unknown; id?: unknown; repoDigest?: unknown } | undefined
  if (!value || typeof value.image !== "string") return {}
  return {
    pin: {
      image: value.image,
      ...(typeof value.id === "string" && value.id ? { id: value.id } : {}),
      ...(typeof value.repoDigest === "string" && value.repoDigest ? { repoDigest: value.repoDigest } : {}),
    },
  }
}

/**
 * What `--sandbox` defaults to on this machine.
 *
 * Container, wherever there is an engine to run one. A worker writes and runs
 * code the operator did not read, so the default belongs somewhere that is not
 * their home directory with their credentials in the environment. Local stays
 * a flag away and is fully supported — it is the Kali and Parrot path — but it
 * is now something you choose rather than something you get.
 */
async function detectSandbox(): Promise<SandboxKind> {
  const host = await detectHost()
  return host.containerEngine ? "container" : "local"
}

interface PreparedScan {
  manifest: EngagementManifest
  manifestPath: string
  lockPath: string
}

/**
 * Writes the two files an assessment starts from, and says what they contain.
 *
 * The manifest and its scope lock are on disk before anything runs, whether the
 * operator filled the form at the shell or under Mission: what was authorized
 * is a record, not a terminal session.
 */
async function writeScanFiles(chosen: ScanInput): Promise<PreparedScan> {
  const inputError = scanInputError(chosen)
  if (inputError) throw new Error(inputError)
  const manifest = buildScanManifest(chosen)
  const lock = createScopeLock(manifest, chosen.attestation)
  const directory = absolute(readFlag("--out") ?? ".cyrion/engagements")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const manifestPath = join(directory, `${manifest.id}.json`)
  const lockPath = join(directory, `${manifest.id}.lock`)
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await Bun.write(lockPath, `${JSON.stringify(lock, null, 2)}\n`)

  console.error([
    `cyrion: prepared ${terminalSafe(manifest.id)}`,
    `  target       ${terminalSafe(manifest.scope.targets.join(", "))}`,
    `  capabilities ${terminalSafe(manifest.scope.capabilities.join(", "))}`,
    `  mode         ${manifest.mode.toUpperCase()}  sandbox ${chosen.sandbox.toUpperCase()}`,
    `  scope hash   ${lock.scopeHash.slice(0, 32)}…`,
    `  manifest     ${terminalSafe(manifestPath)}`,
    `  lock         ${terminalSafe(lockPath)}`,
  ].join("\n"))
  return { manifest, manifestPath, lockPath }
}

/** The `engage` command line one approved form implies. */
function engageArgv(
  chosen: ScanInput,
  prepared: PreparedScan,
  headless: boolean,
  forwarded: string[],
): string[] {
  return [
    "--scope", prepared.manifestPath,
    "--scope-lock", prepared.lockPath,
    "--sandbox", chosen.sandbox,
    "--mode", prepared.manifest.mode,
    ...(prepared.manifest.mode === "supervised" && headless ? ["--approve-all"] : []),
    ...(headless ? ["--headless"] : []),
    ...forwarded,
  ]
}

/**
 * Runs the assessment an operator started from Mission, and the one after that.
 *
 * The terminal that handed this over is already closed and its engagement
 * cancelled, so each run replaces the last rather than nesting inside it.
 */
async function engageScan(first: ScanInput): Promise<void> {
  let chosen: ScanInput | undefined = first
  while (chosen) {
    const prepared = await writeScanFiles(chosen)
    // A terminal handoff is never headless: someone is sitting in front of it.
    args.splice(0, args.length, "engage", ...engageArgv(chosen, prepared, false, handoffFlags()))
    chosen = await runEngagement()
  }
}

/**
 * Flags an assessment started from Mission carries into the next run.
 *
 * Where artifacts, state, and skills live follows the operator across a
 * handoff. How a fixture demo was reviewed does not: `--planner opencode` is a
 * word the demo understands and an engagement refuses, so a review mode is
 * forwarded only when `engage` accepts it.
 */
function handoffFlags(): string[] {
  const forwarded = passThrough(["--artifacts", "--state", "--skills", "--model-timeout"])
  const planner = readFlag("--planner")
  if (planner && ["assessment", "llm", "llm-author"].includes(planner)) forwarded.push("--planner", planner)
  const workers = readFlag("--workers")
  if (workers && ["capability", "llm"].includes(workers)) forwarded.push("--workers", workers)
  return forwarded
}

/** Flags the operator set on `scan` that `engage` also understands. */
function passThrough(names: readonly string[]): string[] {
  const forwarded: string[] = []
  for (const name of names) {
    const index = args.indexOf(name)
    if (index >= 0 && args[index + 1] && !args[index + 1]!.startsWith("--")) {
      forwarded.push(name, args[index + 1]!)
    }
  }
  return forwarded
}


/**
 * Runs the labs and reports what the assessment actually got right.
 *
 * Ground truth lives with the labs, not with the code being measured, so the
 * benchmark can fail. Only confirmed findings count as claims: a candidate
 * nobody validated is not an assertion about a target, and counting one would
 * reward raising noise. `inconclusive` gets its own column rather than being
 * folded into either side, because not knowing is a different outcome from
 * being right or wrong.
 */
async function runBench(): Promise<void> {
  const { labs, labIds } = await import("../../../fixtures/labs/catalog")
  const selected = readFlag("--lab")?.split(",").map((value) => value.trim()).filter(Boolean) ?? labIds
  for (const id of selected) {
    if (!labIds.includes(id)) throw new Error(`--lab must name ${labIds.join(", ")}`)
  }
  const sandbox = (readFlag("--sandbox") ?? "local") as SandboxKind
  if (sandbox !== "local" && sandbox !== "container") throw new Error("--sandbox must be local or container")
  const planner = readFlag("--planner") ?? "assessment"
  const workers = readFlag("--workers") ?? "capability"
  const deterministic = planner === "assessment" && workers === "capability"
  const root = absolute(readFlag("--out") ?? ".cyrion/benchmark")
  // Every flag is read before the loop: dispatching each lab through
  // `prepareEngagement` replaces the argument list, and a flag read afterwards
  // would be read from the engagement's arguments rather than the benchmark's.
  const markdownPath = absolute(readFlag("--report") ?? join(root, "BENCHMARKS.md"))
  const modelTimeout = readFlag("--model-timeout")
  const asJson = args.includes("--json")
  await mkdir(root, { recursive: true, mode: 0o700 })

  const fixtures = await Bun.file(join(projectRoot, "fixtures/manifest.json")).json() as { fixtureVersion: string }
  const skills = await loadSkills(join(projectRoot, "skills"))
  const runs: RunMetrics[] = []
  let models: Array<{ role: string; endpoint: string; model: string }> = []

  for (const id of selected) {
    const definition = labs[id]!
    const server = definition.start()
    const truth = definition.truth(`http://127.0.0.1:${server.port}`)
    const manifest: EngagementManifest = {
      id: `ENG-BENCH-${id.toUpperCase()}`,
      name: `Benchmark: ${truth.name}`,
      objective: truth.purpose,
      profile: "web-api",
      mode: "autonomous",
      scope: { targets: [...truth.targets], excluded: [], capabilities: ["dns.lookup", "http.probe", "poc.run"] },
      budgets: {
        maxConcurrentAgents: 3, maxAgents: 60, maxDepth: 3, maxTasks: 60,
        maxDurationMs: 1_800_000, maxTokens: 400_000, maxCostUsd: 5,
      },
    }
    const manifestPath = join(root, `${manifest.id}.json`)
    await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    console.error(`cyrion: running lab ${terminalSafe(id)} — ${terminalSafe(truth.purpose)}`)
    const started = performance.now()
    let snapshot: EngagementSnapshot
    try {
      args.splice(0, args.length, "engage",
        "--scope", manifestPath,
        "--sandbox", sandbox,
        "--mode", "autonomous",
        "--approve-all",
        "--headless",
        "--artifacts", join(root, id, "artifacts"),
        "--planner", planner,
        "--workers", workers,
        ...(modelTimeout ? ["--model-timeout", modelTimeout] : []))
      const prepared = await prepareEngagement({ requireApproval: false })
      if (!models.length) models = reportModels(prepared)
      try {
        snapshot = await prepared.controller.run()
      } finally {
        await prepared.close()
      }
    } finally {
      server.stop()
    }
    const wallClockMs = Math.round(performance.now() - started)
    const metrics = scoreRun(snapshot, truth, { wallClockMs })
    runs.push(metrics)
    console.error(
      `cyrion:   ${metrics.status} — ${metrics.truePositives} true, ${metrics.falsePositives} false, `
      + `${metrics.falseNegatives} missed, ${metrics.inconclusive} inconclusive, `
      + `${metrics.scopeViolations} scope violation(s)`,
    )
  }

  const report = summarize(runs, {
    cliVersion: CLI_VERSION,
    fixtureVersion: fixtures.fixtureVersion,
    planner,
    workers,
    sandbox,
    deterministic,
    ...(models.length ? { models } : {}),
  })
  const jsonPath = join(root, "benchmark.json")
  await Bun.write(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  await Bun.write(markdownPath, renderBenchmarkMarkdown(report))

  if (asJson) console.log(JSON.stringify(report))
  else console.log(renderBenchmarkMarkdown(report))
  console.error(`cyrion: wrote ${terminalSafe(jsonPath)} and ${terminalSafe(markdownPath)}`)
  void skills

  // A benchmark that tolerates a scope violation is not measuring the thing
  // that matters most, so the command fails when one occurs.
  if (report.totals.scopeViolations > 0 || report.totals.overconfident > 0) process.exitCode = 1
}


/**
 * Attaches to an engagement someone else is running, read only.
 *
 * A headless run on a server, a `cyrion ci` job, a colleague's terminal — all
 * of them write the same durable record, and this reads it. Every operator
 * control refuses rather than reaching across into a running engagement, which
 * is the sort of thing the controller exists to prevent.
 */
async function runWatch(): Promise<void> {
  const engagementId = args[1]
  if (!engagementId || engagementId.startsWith("-")) {
    throw new Error("watch requires an engagement ID, and --state <sqlite-path>")
  }
  const stateArgument = readFlag("--state")
  if (!stateArgument) throw new Error("watch requires --state <sqlite-path>")
  const databasePath = absolute(stateArgument)
  if (!existsSync(databasePath)) throw new Error(`State database not found: ${databasePath}`)

  const store = new SQLiteEngagementStore(databasePath, engagementId)
  const initial = store.loadSnapshot()
  if (!initial) {
    store.close()
    throw new Error(`Engagement not found in state database: ${terminalSafe(engagementId)}`)
  }
  const intervalMs = Number(readFlag("--interval") ?? 500)
  const watcher = new WatchedEngagement(store, initial, { intervalMs, untilFinished: args.includes("--until-finished") })

  if (args.includes("--headless") || !process.stdout.isTTY) {
    // No terminal to draw in: report each change as a line instead.
    let seen = 0
    const emit = (): void => {
      const snapshot = watcher.snapshot
      for (const event of snapshot.events.slice(seen)) console.log(JSON.stringify(event))
      seen = snapshot.events.length
    }
    const unsubscribe = watcher.events.subscribe(emit)
    emit()
    const result = await watcher.run()
    unsubscribe()
    console.log(JSON.stringify(statusSummary(result)))
    watcher.close()
    return
  }

  let exit: TuiExit = { kind: "closed" }
  try {
    exit = await runTui(
      watcher,
      new LocalEvidenceStore(absolute(readFlag("--artifacts") ?? ".cyrion/artifacts")),
      { mode: "live", planner: "assessment", workers: "capability", notice: "Read-only: watching an engagement run elsewhere." },
      join(absolute(readFlag("--artifacts") ?? ".cyrion/artifacts"), "..", "reports"),
      { ...defaultScanInput, sandbox: await detectSandbox() },
    )
  } finally {
    watcher.close()
  }
  // Starting an assessment is not steering the watched one: it is a new
  // engagement, with its own manifest and its own authorization, run here.
  if (exit.kind === "scan") await engageScan(exit.input)
}

/**
 * What Cyrion will authenticate as, without ever printing what with.
 *
 * There is deliberately no command that writes a credential. Cyrion reading a
 * secret it was handed is one thing; Cyrion holding the pen that writes secrets
 * to disk is another, and an operator's own editor and file permissions are a
 * better place for that than an argv the shell will put in a history file.
 */
async function runCredentials(): Promise<void> {
  const path = credentialsPath()
  const json = args.includes("--json")
  if (!existsSync(path)) {
    if (json) console.log(JSON.stringify({ path, credentials: [] }, null, 2))
    else {
      console.log(`No credential store at ${path}.`)
      console.log("")
      console.log("Create one to test authenticated surfaces. It holds values; skills hold names:")
      console.log("")
      console.log(JSON.stringify(
        {
          version: "cyrion.community/credentials-v1",
          credentials: [{
            name: "api-token",
            value: "<the token>",
            hosts: ["api.example.test"],
            description: "Read-only service account",
          }],
        },
        null,
        2,
      ))
      console.log("")
      console.log("A skill then writes: \"headers\": { \"authorization\": \"Bearer ${cred:api-token}\" }")
      console.log("Keep the file out of version control; Cyrion never writes it and never prints a value.")
    }
    return
  }
  const credentials = await loadCredentials(path)
  const entries = credentials.list()
  if (json) {
    console.log(JSON.stringify({ path, credentials: entries }, null, 2))
    return
  }
  console.log(`Credential store: ${terminalSafe(path)}`)
  console.log("")
  if (!entries.length) {
    console.log("The store is valid and holds no credentials.")
    return
  }
  for (const entry of entries) {
    console.log(`  ${terminalSafe(entry.name)}`)
    console.log(`    may be sent to  ${terminalSafe(entry.hosts.join(", "))}`)
    console.log(`    model may read  ${entry.exposeToModel ? "yes (explicitly allowed)" : "no"}`)
    if (entry.description) console.log(`    note            ${terminalSafe(entry.description, 120)}`)
  }
  console.log("")
  console.log("Reference one from a skill or a manifest as ${cred:<name>}. Values are never printed.")
}

/**
 * The operator's side of the corpus: what is in it, how it got there, and what
 * a search actually returns.
 *
 * Ingestion is a separate command from an engagement on purpose. Fetching a
 * standard is a network request to somewhere that is not the target, and it
 * happens when an operator asks for it, never in the middle of a run.
 */
async function runKnowledge(): Promise<void> {
  const subcommand = args[1] && !args[1].startsWith("-") ? args[1] : "status"
  if (subcommand !== "sync" && subcommand !== "status" && subcommand !== "search" && subcommand !== "forget") {
    throw new Error("knowledge takes sync, status, search, or forget")
  }
  const path = knowledgePath()
  if (subcommand !== "sync" && !existsSync(path)) {
    throw new Error(`No corpus at ${path}. Run \`cyrion knowledge sync\` to build one.`)
  }
  await mkdir(join(path, ".."), { recursive: true }).catch(() => undefined)
  const store = KnowledgeStore.open(path)
  try {
    if (subcommand === "sync") await knowledgeSync(store, path)
    else if (subcommand === "search") await knowledgeSearchCommand(store)
    else if (subcommand === "forget") knowledgeForget(store)
    else knowledgeStatus(store, path)
  } finally {
    store.close()
  }
}

async function knowledgeSync(store: KnowledgeStore, path: string): Promise<void> {
  const sources = await selectedSources()
  const reports: SyncReport[] = []
  for (const source of sources) {
    if (source.origin === "remote" && !args.includes("--yes") && !args.includes("--json")) {
      console.error(
        `cyrion: fetching ${terminalSafe(source.name)} (${source.license}) from ${(source.urls ?? []).length} URL(s).`,
      )
    }
    reports.push(await syncSource(store, source, { root: projectRoot }))
  }

  const embedded = args.includes("--embed") ? await knowledgeEmbed(store) : undefined
  const status = store.status()
  if (args.includes("--json")) {
    console.log(JSON.stringify({ path, status, sources: reports, ...(embedded ? { embedded } : {}) }))
    return
  }
  const lines = [
    "CYRION/AI  KNOWLEDGE SYNC",
    "",
    `store        ${terminalSafe(path)}`,
    `corpus       ${status.corpusVersion}`,
    "",
    "source                    documents  chunks",
  ]
  for (const report of reports) {
    lines.push(
      `  ${report.sourceId.padEnd(24)}${String(report.documents).padStart(9)}${String(report.chunks).padStart(8)}`,
    )
    for (const skipped of report.skipped) {
      lines.push(`    skipped ${terminalSafe(skipped.reference, 60)}: ${terminalSafe(skipped.reason, 90)}`)
    }
  }
  if (embedded) lines.push("", `embedded     ${embedded.embedded} of ${embedded.total} pending chunk(s) with ${terminalSafe(embedded.model)}`)
  else lines.push("", "Retrieval is lexical. Bind roles.embedding in your model configuration and pass --embed for vectors.")
  console.log(lines.join("\n"))
}

/** Vectors are optional. Saying why they are absent beats silently ranking worse. */
async function knowledgeEmbed(store: KnowledgeStore): Promise<{ model: string; embedded: number; total: number }> {
  const config = await findModelConfig()
  if (!config) throw new Error(`--embed needs a model configuration. ${MODEL_SETUP_HINT}`)
  if (!config.roles.embedding) {
    throw new Error("--embed needs roles.embedding in the model configuration; no other role is used for vectors.")
  }
  const client = createEmbeddingClient(config, Bun.env)
  const result = await embedPending(store, client, {
    onProgress: (done, total) => {
      if (!args.includes("--json") && done % 64 === 0) console.error(`cyrion: embedded ${done}/${total}`)
    },
  })
  return { model: client.model, ...result }
}

async function knowledgeSearchCommand(store: KnowledgeStore): Promise<void> {
  const query = (positionalArgs(2, ["--json", "--yes", "--embed"]).join(" ") || readFlag("--query") || "").trim()
  if (!query.trim()) throw new Error('knowledge search needs a query: cyrion knowledge search "object level authorization"')
  const k = Number(readFlag("--k") ?? 5)
  const embedder = await optionalEmbedder()
  const result = await store.search(query, { k, ...(embedder ? { embedder } : {}) })

  if (args.includes("--json")) {
    console.log(JSON.stringify(result))
    return
  }
  const lines = [
    "CYRION/AI  KNOWLEDGE",
    "",
    `query        ${terminalSafe(result.query)}`,
    `mode         ${result.mode.toUpperCase()}`,
    `corpus       ${result.corpusVersion}`,
    "",
  ]
  if (!result.hits.length) lines.push("No snippet matched. Try different terms, or sync a source that covers this.")
  for (const [index, hit] of result.hits.entries()) {
    lines.push(
      `${String(index + 1).padStart(2)}. ${terminalSafe(hit.title, 70)}`,
      `    ${terminalSafe(hit.reference, 100)}${hit.heading ? `  ·  ${terminalSafe(hit.heading, 50)}` : ""}`,
      ...terminalSafe(hit.snippet, 600).split("\n").map((line) => `    ${line}`),
      "",
    )
  }
  console.log(lines.join("\n"))
}

function knowledgeForget(store: KnowledgeStore): void {
  const id = readFlag("--source")
  if (!id) throw new Error("knowledge forget needs --source <id>")
  const removed = store.forget(id)
  console.log(`Removed ${removed} document(s) ingested under ${terminalSafe(id)}.`)
}

function knowledgeStatus(store: KnowledgeStore, path: string): void {
  const status = store.status()
  if (args.includes("--json")) {
    console.log(JSON.stringify({ path, ...status, documents: store.documents() }))
    return
  }
  const lines = [
    "CYRION/AI  KNOWLEDGE",
    "",
    `store        ${terminalSafe(path)}`,
    `corpus       ${status.corpusVersion}`,
    `documents    ${status.documents}`,
    `chunks       ${status.chunks}`,
    `retrieval    ${status.embedded ? `HYBRID  ${status.embedded}/${status.chunks} embedded with ${terminalSafe(status.embeddingModel ?? "")}` : "LEXICAL  no vectors stored"}`,
    "",
    "source                    documents  licence",
  ]
  for (const source of status.sources) {
    lines.push(
      `  ${source.id.padEnd(24)}${String(source.documents).padStart(9)}  ${terminalSafe(source.license, 40)}`,
    )
  }
  const known = new Set(status.sources.map((source) => source.id))
  const available = builtInSources.filter((source) => !known.has(source.id))
  if (available.length) {
    lines.push("", "not ingested", ...available.map((source) => `  ${source.id.padEnd(24)}${terminalSafe(source.name, 60)}`))
    lines.push("", `cyrion knowledge sync --source ${available[0]!.id}`)
  }
  console.log(lines.join("\n"))
}

/**
 * Sources this sync will ingest.
 *
 * `--source` names built-in descriptors; `--from` ingests a directory the
 * operator already has, which is how a private methodology enters the corpus
 * without being published; `--sources` reads a file of descriptors, validated
 * the same way a skill pack is.
 */
async function selectedSources(): Promise<KnowledgeSource[]> {
  const from = readFlag("--from")
  if (from) {
    const root = absolute(from)
    if (!existsSync(root)) throw new Error(`Knowledge directory not found: ${root}`)
    return [{
      id: readFlag("--source") ?? "operator",
      name: readFlag("--name") ?? `Operator corpus (${root.split("/").pop() ?? "local"})`,
      license: readFlag("--license") ?? "operator-supplied",
      origin: "local",
      path: root,
      ...(readFlag("--extensions") ? { extensions: readFlag("--extensions")!.split(",") } : {}),
    }]
  }

  const file = readFlag("--sources")
  if (file) {
    const value: unknown = await Bun.file(absolute(file)).json()
    if (!Array.isArray(value)) throw new Error(`${file} must contain an array of sources`)
    return value.map((entry, index) => {
      const error = knowledgeSourceError(entry)
      if (error) throw new Error(`${file} entry ${index} is invalid: ${error}`)
      return entry as KnowledgeSource
    })
  }

  const requested = readFlag("--source")
  if (requested) {
    const source = sourceById(requested)
    if (!source) {
      throw new Error(
        `Unknown source ${requested}. Available: ${builtInSources.map((entry) => entry.id).join(", ")}.`,
      )
    }
    return [source]
  }
  // With no selection, only what is already on this machine is ingested. A bare
  // `sync` must not reach out to the network on its own.
  return builtInSources.filter((source) => source.origin === "local")
}

async function runTools(): Promise<void> {
  const host = await detectHost()
  const requested = readFlag("--sandbox")
  if (requested && requested !== "local" && requested !== "container") {
    throw new Error("--sandbox must be local or container")
  }
  const kind: SandboxKind = (requested as SandboxKind | undefined)
    ?? (host.securityDistribution || !host.containerEngine ? "local" : "container")
  const report = await describeSandbox(kind, host, {
    ...(kind === "container" ? { image: workerImage(), ...(await workerImagePin()) } : {}),
  })

  const runner = new LocalToolRunner({ allowedBinaries: binariesFor(toolCatalog.map((tool) => tool.capability)) })
  const rows = await Promise.all(toolCatalog.map(async (tool) => {
    // A capability with no adapter cannot be granted, whatever is installed for
    // it. Saying so here is the difference between a catalog and a wish list.
    if (tool.planned) return { tool, state: "planned" as const }
    // A capability backed by a library rather than a binary is not built-in:
    // saying so on a machine that cannot run it is the same false advertisement
    // the planned check above exists to prevent.
    if (tool.module) {
      return { tool, state: (await moduleInstalled(tool.module)) ? "installed" as const : "missing" as const }
    }
    if (!tool.binary) return { tool, state: "built-in" as const }
    const info = await runner.lookup(tool.binary).catch(() => undefined)
    return { tool, state: info ? ("installed" as const) : ("missing" as const), ...(info ? { info } : {}) }
  }))
  const missing = rows.filter((row) => row.state === "missing").map((row) => row.tool)
  const plan = installPlan(missing, host.packageManager)

  if (args.includes("--json")) {
    console.log(JSON.stringify({
      host: { ...host, sandbox: kind },
      sandbox: report,
      capabilities: rows.map(({ tool, state, ...rest }) => ({
        capability: tool.capability,
        binary: tool.binary || null,
        optional: tool.optional ?? false,
        state,
        version: "info" in rest ? rest.info?.version ?? null : null,
      })),
      install: {
        manager: plan.manager,
        command: plan.command,
        manual: plan.manual.map((tool) => tool.binary || tool.module || tool.capability),
      },
    }))
    if (args.includes("--check") && missing.some((tool) => !tool.optional)) process.exitCode = 1
    return
  }

  const lines = [
    "CYRION/AI  TOOLING",
    "",
    `host         ${terminalSafe(host.distribution)}${host.securityDistribution ? "  (security distribution)" : ""}`,
    `packages     ${host.packageManager}`,
    `engine       ${host.containerEngine ?? "none"}`,
    `sandbox      ${kind.toUpperCase()}  ${report.ready ? "READY" : "NOT READY"}`,
    `             ${terminalSafe(report.detail)}`,
    "",
    "enforced",
    ...report.enforced.map((item) => `  + ${item}`),
    ...(report.missing.length ? ["not enforced", ...report.missing.map((item) => `  - ${item}`)] : []),
    "",
    "capability            tool        state",
  ]
  for (const row of rows) {
    const version = "info" in row && row.info?.version ? `  ${terminalSafe(row.info.version, 48)}` : ""
    const state = row.state === "planned"
      ? "NOT IMPLEMENTED YET"
      : row.state === "built-in"
        ? "BUILT-IN"
        : row.state === "installed" ? "INSTALLED" : row.tool.optional ? "MISSING (optional)" : "MISSING"
    const backing = row.tool.binary || row.tool.module || "-"
    lines.push(`  ${row.tool.capability.padEnd(20)}${backing.padEnd(12)}${state}${version}`)
  }
  if (missing.length) {
    lines.push("", "install what is missing")
    if (plan.command) lines.push(`  ${plan.command}`)
    for (const tool of plan.manual) {
      const name = tool.binary || tool.module || tool.capability
      lines.push(`  ${name}: ${terminalSafe(tool.note ?? "no package is available for this manager")}`)
    }
    lines.push("", "Cyrion never installs packages for you. Review the command, then run it yourself.")
  }
  console.log(lines.join("\n"))
  if (args.includes("--check") && missing.some((tool) => !tool.optional)) process.exitCode = 1
}

/**
 * Whether an optional library this release does not depend on is installed.
 *
 * Resolution rather than execution: importing it would run the package's own
 * top-level code just to answer a readiness question.
 */
async function moduleInstalled(name: string): Promise<boolean> {
  try {
    await import.meta.resolve(name)
    return true
  } catch {
    return false
  }
}

async function runScope(): Promise<void> {
  const subcommand = args[1] ?? "check"
  if (subcommand !== "check" && subcommand !== "lock") {
    throw new Error("scope takes check or lock")
  }
  const manifestPath = absolute(readFlag("--manifest") ?? "engagement.json")
  if (!existsSync(manifestPath)) {
    throw new Error(`Engagement manifest not found: ${manifestPath}. Pass --manifest <path>.`)
  }
  const manifest: unknown = await Bun.file(manifestPath).json()
  assertManifest(manifest)
  const policyError = scopePolicyError(manifest.scope)
  if (policyError) throw new Error(policyError)

  if (subcommand === "lock") {
    // `--attest` is optional. A lock is worth writing for the scope hash alone,
    // and whether an authorization record belongs in it is the operator's call.
    const lock = createScopeLock(manifest, readFlag("--attest"))
    const output = absolute(readFlag("--out") ?? "scope.lock")
    await Bun.write(output, `${JSON.stringify(lock, null, 2)}\n`)
    console.log([
      `Scope locked for ${terminalSafe(manifest.id)}`,
      `  hash        ${lock.scopeHash}`,
      ...(lock.attestation ? [`  attestation ${terminalSafe(lock.attestation)}`] : []),
      `  written     ${terminalSafe(output)}`,
    ].join("\n"))
    return
  }

  const target = readFlag("--target")
  const lockPath = absolute(readFlag("--scope-lock") ?? "scope.lock")
  const lock: unknown = existsSync(lockPath) ? await Bun.file(lockPath).json() : undefined
  const lockError = lock === undefined ? undefined : verifyScopeLock(lock, manifest)
  const decision = target ? evaluateScope(manifest.scope, target) : undefined

  if (args.includes("--json")) {
    console.log(JSON.stringify({
      engagementId: manifest.id,
      scopeHash: scopeHash(manifest.scope),
      canonicalScope: canonicalScope(manifest.scope),
      lock: lock === undefined ? "absent" : lockError ? "invalid" : "valid",
      ...(lockError ? { lockError } : {}),
      ...(decision ? { target, decision } : {}),
    }))
  } else {
    console.log([
      `CYRION/AI  SCOPE  ${terminalSafe(manifest.id)}`,
      "",
      canonicalScope(manifest.scope),
      "",
      `hash         ${scopeHash(manifest.scope)}`,
      `lock         ${lock === undefined ? "ABSENT" : lockError ? "INVALID" : "VALID"}`,
      ...(lockError ? [`             ${terminalSafe(lockError)}`] : []),
      ...(decision
        ? [
          "",
          `target       ${terminalSafe(String(target))}`,
          `decision     ${decision.allowed ? "IN SCOPE" : "OUT OF SCOPE"}`,
          `             ${terminalSafe(decision.matched ?? decision.reason ?? "")}`,
          ...(decision.allowedPorts ? [`ports        ${decision.allowedPorts}`] : []),
        ]
        : []),
    ].join("\n"))
  }
  if (args.includes("--check") && (lockError || (decision && !decision.allowed))) process.exitCode = 1
}

async function runModels(): Promise<void> {
  const config = await findModelConfig()
  if (!config) {
    const detail = `No model endpoint is configured. ${MODEL_SETUP_HINT}`
    if (args.includes("--json")) console.log(JSON.stringify({ configured: false, ready: false, detail }))
    else console.log(["CYRION/AI  MODELS", "", "status       NOT CONFIGURED", "", detail].join("\n"))
    if (args.includes("--check")) process.exitCode = 1
    return
  }
  const readiness = await probeReadiness(config, Bun.env, { probeStructured: args.includes("--probe") })
  if (args.includes("--json")) console.log(JSON.stringify(readiness))
  else console.log(formatModelReadiness(readiness))
  if (args.includes("--check") && !readiness.ready) process.exitCode = 1
}

function formatModelReadiness(readiness: LlmReadiness): string {
  const lines = ["CYRION/AI  MODEL READINESS", ""]
  for (const endpoint of readiness.endpoints) {
    lines.push(
      `endpoint     ${terminalSafe(endpoint.endpointId)} (${endpoint.kind})`,
      `  url        ${terminalSafe(endpoint.baseUrl)}`,
      `  reachable  ${endpoint.reachable ? "YES" : "NO"}`,
      `  credential ${endpoint.credential.toUpperCase()}`,
      `  models     ${endpoint.models.length ? terminalSafe(endpoint.models.slice(0, 8).join(", ")) : "none reported"}`,
    )
    if (endpoint.error) lines.push(`  error      ${terminalSafe(endpoint.error)}`)
  }
  lines.push("")
  for (const role of readiness.roles) {
    lines.push(
      `role         ${role.role}`,
      `  model      ${terminalSafe(role.endpointId)}/${terminalSafe(role.model)}`,
      `  available  ${role.modelAvailable ? "YES" : "NOT LISTED"}`,
      ...(role.structuredMode ? [`  structured ${role.structuredMode}`] : []),
      ...(role.error ? [`  error      ${terminalSafe(role.error)}`] : []),
    )
  }
  lines.push("", `ready        ${readiness.ready ? "YES" : "NO"}`)
  if (!readiness.ready) {
    const bound = new Set(readiness.roles.map((role) => role.endpointId))
    const blocking = readiness.endpoints.filter((endpoint) =>
      bound.has(endpoint.endpointId) && (!endpoint.reachable || endpoint.credential === "missing"))
    for (const endpoint of blocking) {
      const roles = readiness.roles.filter((role) => role.endpointId === endpoint.endpointId).map((role) => role.role)
      lines.push(`  blocked by ${terminalSafe(endpoint.endpointId)}, bound to ${roles.join(", ")}`)
    }
  }
  return lines.join("\n")
}

async function runProviders(): Promise<void> {
  if (args.includes("--select") && args.includes("--json")) {
    throw new Error("--select cannot be combined with --json")
  }
  const selection = readProviderSelection(Bun.env)
  const status = await inspectOpenCodeProviders(process.cwd(), selection)
  if (args.includes("--select")) {
    await selectProvider(status)
    return
  }
  if (args.includes("--json")) console.log(JSON.stringify(status))
  else console.log(formatProviderStatus(status))
  if (args.includes("--check") && !status.ready) process.exitCode = 1
}

async function selectProvider(status: ProviderStatus): Promise<void> {
  if (status.error) throw new Error(`Provider discovery failed: ${status.error}`)
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Provider selection requires an interactive terminal")
  }
  if (!status.connectedProviders.length) {
    throw new Error("No connected providers. Run `opencode auth login`, then retry.")
  }

  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const provider = await promptChoice(
      terminal,
      "provider",
      status.connectedProviders,
      status.selected?.providerID,
      (item) => `${item.name} / ${item.id} / ${item.modelCount} models`,
    )
    if (!provider.models.length) throw new Error(`Connected provider ${provider.id} has no available models`)
    const model = await promptChoice(
      terminal,
      "model",
      provider.models,
      status.selected?.providerID === provider.id ? status.selected.modelID : undefined,
      (item) => item.name === item.id ? item.id : `${item.name} / ${item.id}`,
    )
    const path = join(process.cwd(), ".env")
    await saveProviderSelection(path, { providerID: provider.id, modelID: model.id })
    console.log(`\nSelected ${provider.id}/${model.id}`)
    console.log(`Saved provider/model selection to ${path}`)
    console.log("Credential remains managed by OpenCode or your environment.")
  } finally {
    terminal.close()
  }
}

async function promptChoice<T extends { id: string }>(
  terminal: ReturnType<typeof createInterface>,
  label: string,
  choices: T[],
  selectedID: string | undefined,
  format: (choice: T) => string,
): Promise<T> {
  const defaultIndex = Math.max(0, choices.findIndex((choice) => choice.id === selectedID))
  console.log(`\nConnected ${label}s:`)
  for (const [index, choice] of choices.entries()) {
    const marker = index === defaultIndex ? "◆" : "◇"
    console.log(`  ${marker} [${index + 1}] ${format(choice)}`)
  }
  while (true) {
    const answer = (await terminal.question(`Choose ${label} [${defaultIndex + 1}]: `)).trim()
    const index = answer ? Number(answer) - 1 : defaultIndex
    const choice = Number.isInteger(index) ? choices[index] : undefined
    if (choice) return choice
    console.log(`Enter a number from 1 to ${choices.length}.`)
  }
}

function formatProviderStatus(status: ProviderStatus): string {
  const selected = status.selected
  const connected = status.connectedProviders.length
    ? status.connectedProviders.map((provider) => `${provider.id} (${provider.modelCount} models)`).join(", ")
    : "none"
  return [
    "CYRION/AI  PROVIDER READINESS",
    `OpenCode     ${status.opencodeVersion ?? "NOT FOUND"}`,
    `selection    ${selected ? `${selected.providerID}/${selected.modelID}` : "NOT CONFIGURED"}`,
    `connected    ${connected}`,
    `provider     ${selected ? readinessLabel(selected.providerAvailable) : "-"}`,
    `model        ${selected ? readinessLabel(selected.modelAvailable) : "-"}`,
    `credential   ${selected ? readinessLabel(selected.connected) : "-"}`,
    `ready        ${status.ready ? "YES" : "NO"}`,
    ...(selected?.requiredEnvironment.length
      ? [`accepted env ${selected.requiredEnvironment.join(", ")}`]
      : []),
    ...(status.error ? [`error        ${status.error}`, "next         run `opencode upgrade`, then retry"] : []),
    ...(!selected ? ["next         set CYRION_PROVIDER_ID and CYRION_MODEL_ID in .env"] : []),
  ].join("\n")
}

function readinessLabel(value: boolean): string {
  return value ? "OK" : "MISSING"
}

function runStatus(): void {
  const { snapshot, close } = readDurableSnapshot()
  const json = args.includes("--json")
  if (json) {
    console.log(JSON.stringify(statusSummary(snapshot)))
  } else {
    const summary = statusSummary(snapshot)
    console.log([
      `CYRION/AI  ${terminalSafe(summary.engagementId)}`,
      `status       ${summary.status.toUpperCase()}`,
      `mode         ${summary.mode.toUpperCase()}`,
      ...(summary.approval ? [`approval     ${summary.approval.toUpperCase()}`] : []),
      `target       ${terminalSafe(snapshot.manifest.scope.targets.join(", "))}`,
      `tasks        ${summary.completedTasks}/${summary.tasks} completed`,
      `findings     ${summary.confirmed} confirmed / ${summary.rejected} rejected / ${summary.inconclusive} inconclusive`,
      `evidence     ${summary.evidence} artifacts`,
    ].join("\n"))
  }
  close()
}

async function runReport(): Promise<void> {
  const format = (readFlag("--format") ?? "markdown") as ReportFormat
  if (!reportFormats.includes(format)) throw new Error(`--format must be one of ${reportFormats.join(", ")}`)
  const failOn = readSeverity("--fail-on", "high")
  const { snapshot, close } = readDurableSnapshot()
  try {
    const rendered = renderReport(format, snapshot, {}, failOn)
    const out = readFlag("--out")
    if (out) {
      await Bun.write(absolute(out), rendered)
      console.log(`cyrion: wrote ${terminalSafe(absolute(out))}`)
    } else {
      process.stdout.write(rendered)
    }
  } finally {
    close()
  }
}

function readDurableSnapshot(): { snapshot: EngagementSnapshot; close: () => void } {
  const engagementId = args[1]
  if (!engagementId || engagementId.startsWith("-")) {
    throw new Error(`${command} requires an engagement ID`)
  }
  const stateArgument = readFlag("--state")
  if (!stateArgument) throw new Error(`${command} requires --state <sqlite-path>`)
  const databasePath = absolute(stateArgument)
  if (!existsSync(databasePath)) throw new Error(`State database not found: ${databasePath}`)
  const store = new SQLiteEngagementStore(databasePath, engagementId)
  const snapshot = store.loadSnapshot()
  if (!snapshot) {
    store.close()
    throw new Error(`Engagement not found in state database: ${engagementId}`)
  }
  return { snapshot, close: () => store.close() }
}

function statusSummary(
  snapshot: EngagementSnapshot,
  scenario?: string,
  runtime?: { planner: NonNullable<StatusSummary["planner"]>; workers: NonNullable<StatusSummary["workers"]> },
): StatusSummary {
  return {
    status: snapshot.status,
    mode: snapshot.manifest.mode,
    ...(scenario ? { scenario } : {}),
    engagementId: snapshot.manifest.id,
    agents: snapshot.agents.length,
    tasks: snapshot.tasks.length,
    completedTasks: snapshot.tasks.filter((task) => task.status === "completed").length,
    confirmed: snapshot.findings.filter((finding) => finding.status === "confirmed").length,
    rejected: snapshot.findings.filter((finding) => finding.status === "rejected").length,
    inconclusive: snapshot.findings.filter((finding) => finding.status === "inconclusive").length,
    evidence: snapshot.evidence.length,
    ...(runtime ?? {}),
    ...(snapshot.pendingApproval ? { approval: snapshot.pendingApproval.status } : {}),
  }
}

/**
 * Positional arguments, with flags and the values they consume removed.
 *
 * A search query is words, and words sit next to `--k 3` on the same line.
 * Filtering only on a leading dash would fold the 3 into the query and search
 * for something the operator never typed.
 */
function positionalArgs(from: number, booleanFlags: readonly string[]): string[] {
  const positional: string[] = []
  for (let index = from; index < args.length; index += 1) {
    const value = args[index]!
    if (!value.startsWith("-")) {
      positional.push(value)
      continue
    }
    const name = value.split("=")[0]!
    // `--flag=value` carries its own value; a bare flag that takes one eats the
    // next argument.
    if (!value.includes("=") && !booleanFlags.includes(name)) index += 1
  }
  return positional
}

function readFlag(name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

/** Strips control characters so untrusted text cannot drive the terminal. Tab and newline survive. */
function terminalSafe(value: string, maxLength?: number): string {
  const clean = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "")
  return maxLength !== undefined && clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean
}

function resolveProjectRoot(): string {
  const candidates = [
    join(import.meta.dir, "../../.."),
    join(import.meta.dir, ".."),
  ]
  const root = candidates.find((candidate) =>
    existsSync(join(candidate, "agents")) && existsSync(join(candidate, "fixtures"))
  )
  if (!root) throw new Error("Cyrion runtime assets were not found beside the CLI")
  return root
}

function usage(): string {
  return [
    `CYRION/AI Community ${CLI_VERSION}`,
    "",
    "Usage:",
    "  cyrion demo [--headless] [--fixture <scenario>]",
    "              [--planner fixture|opencode|llm|llm-author] [--workers fixture|opencode|llm]",
    "              [--models <path>]",
    "              [--mode autonomous|supervised] [--approve-all]",
    "              [--state <sqlite-path>] [--artifacts <directory>] [--fresh]",
    "              [--scope-lock <path>]",
    "  cyrion providers [--json] [--check] [--select]",
    "  cyrion models [--models <path>] [--json] [--check] [--probe]",
    "  cyrion hack <target> [--capabilities <list>] [--sandbox local|container]",
    "                       [--mode autonomous|supervised] [--out <directory>]",
    "                       [--dry-run] [--headless]      (alias: cyrion scan)",
    "  cyrion engage --scope <manifest> [--sandbox local|container] [--skills <dir>]",
    "                [--planner assessment|llm|llm-author] [--workers capability|llm]",
    "                [--model-timeout <ms>]",
    "                [--mode autonomous|supervised] [--approve-all] [--scope-lock <path>]",
    "                [--state <sqlite-path>] [--artifacts <directory>] [--headless]",
    "                [--mcp <path>] [--allow-host-browser]",
    "  cyrion replay <finding-id> [--manifest <path>] [--artifacts <directory>]",
    "                [--bundle <path>] [--sandbox local|container] [--json]",
    "  cyrion bench [--lab imperfect,clean,partial] [--sandbox local|container]",
    "               [--planner assessment|llm|llm-author] [--workers capability|llm]",
    "               [--out <directory>] [--report <path>] [--json]",
    "  cyrion ci --scope <manifest> [--fail-on critical|high|medium|low|info]",
    "            [--planner assessment|llm|llm-author] [--workers capability|llm]",
    "            [--fail-on-unresolved] [--formats markdown,json,html,sarif,junit,csv]",
    "            [--report <directory>] [--sandbox local|container] [--json] [--verbose]",
    "            [--mcp <path>]",
    "  cyrion tools [--sandbox local|container] [--json] [--check]",
    "  cyrion knowledge status [--knowledge <path>] [--json]",
    "  cyrion knowledge sync [--source <id>] [--from <directory>] [--sources <path>]",
    "                        [--embed] [--knowledge <path>] [--json]",
    "  cyrion knowledge search <query> [--k <n>] [--knowledge <path>] [--json]",
    "  cyrion knowledge forget --source <id> [--knowledge <path>]",
    "  cyrion credentials [--credentials <path>] [--json]",
    "  cyrion probe --capability <name> --target <expression> [--manifest <path>]",
    "               [--allow-host-browser]",
    "               [--sandbox local|container] [--json]",
    "  cyrion scope check [--manifest <path>] [--target <expression>] [--json] [--check]",
    "  cyrion scope lock [--attest <text>] [--manifest <path>] [--out <path>]",
    "  cyrion mcp serve --state <sqlite-path> --engagement <id> [--artifacts <directory>]",
    "  cyrion mcp serve --scope <manifest> [--scope-lock <path>]",
    "                   [--sandbox local|container] [--state <sqlite-path>]",
    "                   [--artifacts <directory>] [--skills <dir>] [--mcp <path>]",
    "  cyrion mcp list [--config <path>] [--server <id>] [--manifest <path>] [--json]",
    "  cyrion mcp call --tool <name> [--config <path>] [--server <id>] [--input <json>] [--json]",
    "  cyrion watch <engagement-id> --state <sqlite-path> [--artifacts <directory>]",
    "               [--interval <ms>] [--until-finished] [--headless]",
    "  cyrion status <engagement-id> --state <sqlite-path> [--json]",
    "  cyrion report <engagement-id> --state <sqlite-path>",
    "                [--format markdown|json|html|sarif|junit|csv] [--out <path>] [--fail-on <severity>]",
    "  cyrion version",
    "",
    "`cyrion hack <target>` needs nothing else: every capability the target kind supports, autonomous, in a container.",
    "`cyrion scan` with no target opens a form for the same choices.",
    "`mcp serve --scope <manifest>` also serves start_engagement for that engagement.",
    "An MCP tool in mcp.json answers as the capability it declares, and only when the manifest granted that name.",
    "Fixture scenarios: known-positive, clean, rejected, incomplete",
    "OpenCode and llm planning or worker review may make billable model requests.",
    "Headless supervised runs require --approve-all.",
    "--sandbox defaults to container wherever an engine is present; the worker image is pulled on first use.",
    "cyrion ci exits non-zero when the gate fails; reports are written either way.",
    "--fresh replaces artifacts written by an earlier fixture version.",
    "`cyrion knowledge sync` with no --source ingests only what is already on this machine.",
    "knowledge.search is refused before a run starts when no corpus has been built.",
  ].join("\n")
}

// Dispatch last: every helper above is hoisted, but a `const` is not, and a
// command that ran before one initialized would fail with a reference error
// instead of doing its job.
try {
  if (args.includes("--help") || args.includes("-h") || command === "help") console.log(usage())
  else if (args.includes("--version") || command === "version") console.log(CLI_VERSION)
  else if (command === "providers") await runProviders()
  else if (command === "models") await runModels()
  else if (command === "scope") await runScope()
  else if (command === "tools") await runTools()
  else if (command === "knowledge") await runKnowledge()
  else if (command === "credentials") await runCredentials()
  else if (command === "probe") await runProbe()
  else if (command === "engage") await runEngagementSession()
  else if (command === "replay") await runReplay()
  else if (command === "ci") await runCi()
  else if (command === "scan" || command === "hack") await runScan()
  else if (command === "bench") await runBench()
  else if (command === "watch") await runWatch()
  else if (command === "mcp") await runMcp()
  else if (command === "demo") await runDemo()
  else if (command === "status") runStatus()
  else if (command === "report") await runReport()
  else throw new Error(`Unknown command: ${command}\n\n${usage()}`)
} catch (error) {
  console.error(`cyrion: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
