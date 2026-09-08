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
import {
  LlmRootPlanner,
  LlmRootReviewer,
  LlmWorkerReviewer,
  bindingForRole,
  createClient,
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
  type ReportContext,
} from "@cyrion/reporting"
import { AssessmentRootPlanner, CapabilityWorkerRuntime } from "@cyrion/assessment"
import { CapabilityRegistry, capabilityAdapters, planEgress } from "@cyrion/capabilities"
import {
  ContainerToolRunner,
  LocalToolRunner,
  egressFromPins,
  binariesFor,
  describeSandbox,
  detectHost,
  installPlan,
  requirementFor,
  toolCatalog,
  type HostProfile,
  type SandboxKind,
} from "@cyrion/sandbox"
import { loadSkills, type Skill } from "@cyrion/skills"
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
import { runTui } from "./tui"
import { runLaunchScreen } from "./launch-screen"
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

/** Pinned by digest in a release; a tag is enough while the image is unpublished. */
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

  await runTui(
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
  )
  controller.close()
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

  // Reproduction is the one capability that repeats an exploit condition against
  // a live target, so it is off unless the manifest grants it and supervised
  // unless the operator says otherwise in as many words.
  if (manifest.scope.capabilities.includes("poc.run")) {
    if (manifest.profile === "repository") {
      throw new Error("poc.run cannot be granted to a repository engagement: a static claim needs a runtime target.")
    }
    if (manifest.mode !== "supervised" && !args.includes("--allow-unsupervised-poc")) {
      manifest.mode = "supervised"
      console.error(
        "cyrion: poc.run is granted, so this run is supervised. "
        + "Pass --allow-unsupervised-poc to run it without approvals.",
      )
    }
  }

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

  const skills = await loadSkills(absolute(readFlag("--skills") ?? join(projectRoot, "skills")))
  if (!skills.length) throw new Error("No skills were loaded. Pass --skills <directory>.")

  const review = await resolveEngagementReview(settings)

  const artifactRoot = absolute(readFlag("--artifacts") ?? ".cyrion/artifacts")
  const evidenceStore = new LocalEvidenceStore(artifactRoot)
  const stateArgument = readFlag("--state")
  const store = stateArgument ? new SQLiteEngagementStore(absolute(stateArgument), manifest.id) : undefined

  const binaries = capabilityAdapters
    .filter((adapter) => manifest.scope.capabilities.includes(adapter.capability))
    .map((adapter) => adapter.binary)
    .filter((binary): binary is string => !!binary)
  const egress = sandbox === "container" ? await planEgress(manifest.scope) : undefined
  const runner = sandbox === "local"
    ? new LocalToolRunner({ allowedBinaries: binaries })
    : new ContainerToolRunner({
      engine: host.containerEngine ?? "docker",
      image: readFlag("--image") ?? DEFAULT_WORKER_IMAGE,
      engagementId: manifest.id,
      allowedBinaries: binaries,
      ...(egress ? { egress: egress.policy } : {}),
      ...(args.includes("--allow-unfiltered-egress") ? { allowUnfilteredEgress: true } : {}),
    })

  const registry = new CapabilityRegistry({
    runner,
    scope: manifest.scope,
    evidence: evidenceStore,
    capabilities: manifest.scope.capabilities,
  })
  for (const pin of egress?.pins ?? []) registry.context.pins.set(pin.hostname, pin)

  // The deterministic planner and the capability workers are the engagement.
  // A provider may review each transition and each canonical result, or author
  // transitions the controller then validates — it never gains a tool.
  const deterministicPlanner = new AssessmentRootPlanner({ skills })
  const capabilityWorkers = new CapabilityWorkerRuntime({ skills })
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
    ...(attestation ? { attestation } : {}),
    autoApprove,
    headless,
    close: async () => {
      controller.close()
      await runner.close()
    },
  }
}

/** Tool versions the run could have used, recorded as part of the report. */
async function recordToolVersions(prepared: PreparedEngagement): Promise<Array<{ name: string; version: string }>> {
  const tools: Array<{ name: string; version: string }> = []
  for (const binary of prepared.registry.requiredBinaries()) {
    const info = await prepared.runner.lookup(binary).catch(() => undefined)
    if (info) tools.push({ name: info.name, version: info.version ?? "present, version not reported" })
  }
  return tools
}

/**
 * Runs a real engagement: skills chosen from the approved scope, capabilities
 * executed in the selected sandbox, evidence hashed locally, and every
 * transition validated by the controller before anything is dispatched.
 */
async function runEngagement(): Promise<void> {
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
      return
    }
    await runTui(
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
    )
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
  const binaries = capabilityAdapters
    .filter((adapter) => manifest.scope.capabilities.includes(adapter.capability))
    .map((adapter) => adapter.binary)
    .filter((binary): binary is string => !!binary)

  // The allowlist is built from the approved scope before anything starts, so a
  // container never runs with a wider reach than the engagement was granted.
  const egress = kind === "container" ? await planEgress(manifest.scope) : undefined
  if (egress?.unresolved.length) {
    console.error(`cyrion: no address could be pinned for ${egress.unresolved.map((item) => terminalSafe(item)).join(", ")}`)
  }

  const runner = kind === "local"
    ? new LocalToolRunner({ allowedBinaries: binaries })
    : new ContainerToolRunner({
      engine: host.containerEngine ?? "docker",
      image: readFlag("--image") ?? DEFAULT_WORKER_IMAGE,
      engagementId: manifest.id,
      allowedBinaries: binaries,
      ...(egress ? { egress: egress.policy } : {}),
      ...(args.includes("--allow-unfiltered-egress") ? { allowUnfilteredEgress: true } : {}),
    })

  const registry = new CapabilityRegistry({
    runner,
    scope: manifest.scope,
    evidence: evidenceStore,
    capabilities: manifest.scope.capabilities,
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
      image: readFlag("--image") ?? DEFAULT_WORKER_IMAGE,
      engagementId: manifest.id,
      allowedBinaries: binariesFor(["poc.run"]),
      ...(egress ? { egress: egress.policy } : {}),
      ...(args.includes("--allow-unfiltered-egress") ? { allowUnfilteredEgress: true } : {}),
    })
  const registry = new CapabilityRegistry({
    runner,
    scope: manifest.scope,
    evidence: evidenceStore,
    capabilities: ["poc.run"],
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
  const context: ReportContext = {
    sandbox: prepared.sandbox,
    runtime: { planner: prepared.planner, workers: prepared.workers },
    tools: await recordToolVersions(prepared).catch(() => []),
    ...(models.length ? { models } : {}),
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
  return value
}

async function runMcpServe(): Promise<void> {
  const stateArgument = readFlag("--state")
  const engagementId = readFlag("--engagement")
  const artifactRoot = absolute(readFlag("--artifacts") ?? ".cyrion/artifacts")
  if (!stateArgument || !engagementId) {
    throw new Error("mcp serve requires --state <sqlite-path> and --engagement <id>")
  }
  const databasePath = absolute(stateArgument)
  if (!existsSync(databasePath)) throw new Error(`State database not found: ${databasePath}`)
  const store = new SQLiteEngagementStore(databasePath, engagementId)

  if (args.includes("--allow-start")) {
    // Starting a run from another agent needs the same authorization record a
    // run from the command line needs, and it is off unless asked for.
    throw new Error(
      "mcp serve --allow-start is not available in this release: starting an engagement from another agent "
      + "requires a scope lock bound to the manifest, which this server does not yet hold. Run `cyrion engage` "
      + "or `cyrion ci`, then serve the resulting state read-only.",
    )
  }

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
  const flagTarget = readFlag("--target")
  const headless = args.includes("--headless") || !process.stdout.isTTY
  const host = await detectHost()
  const requested = readFlag("--sandbox")
  if (requested && requested !== "local" && requested !== "container") {
    throw new Error("--sandbox must be local or container")
  }
  const detected: SandboxKind = (requested as SandboxKind | undefined)
    ?? (host.securityDistribution || !host.containerEngine ? "local" : "container")

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

  // A terminal gets the form; a pipeline gets exactly what it asked for.
  const chosen = headless || (flagTarget && readFlag("--attest"))
    ? initial
    : await runLaunchScreen(initial)
  if (!chosen) {
    console.error("cyrion: no assessment was started")
    return
  }
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
  if (args.includes("--dry-run")) {
    console.error("cyrion: --dry-run, so nothing was executed. Start it with:")
    console.error(`  cyrion engage --scope ${terminalSafe(manifestPath)} --scope-lock ${terminalSafe(lockPath)}`)
    return
  }

  // Hand the prepared engagement to the same path `cyrion engage` uses.
  const argv = [
    "--scope", manifestPath,
    "--scope-lock", lockPath,
    "--sandbox", chosen.sandbox,
    "--mode", manifest.mode,
    ...(manifest.mode === "supervised" && headless ? ["--approve-all"] : []),
    ...(manifest.scope.capabilities.includes("poc.run") ? ["--allow-unsupervised-poc"] : []),
    ...(headless ? ["--headless"] : []),
    ...passThrough(["--planner", "--workers", "--artifacts", "--state", "--skills", "--model-timeout"]),
  ]
  args.splice(0, args.length, "engage", ...argv)
  await runEngagement()
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

async function runTools(): Promise<void> {
  const host = await detectHost()
  const requested = readFlag("--sandbox")
  if (requested && requested !== "local" && requested !== "container") {
    throw new Error("--sandbox must be local or container")
  }
  const kind: SandboxKind = (requested as SandboxKind | undefined)
    ?? (host.securityDistribution || !host.containerEngine ? "local" : "container")
  const report = await describeSandbox(kind, host)

  const runner = new LocalToolRunner({ allowedBinaries: binariesFor(toolCatalog.map((tool) => tool.capability)) })
  const rows = await Promise.all(toolCatalog.map(async (tool) => {
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
      install: { manager: plan.manager, command: plan.command, manual: plan.manual.map((tool) => tool.binary) },
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
    const state = row.state === "built-in"
      ? "BUILT-IN"
      : row.state === "installed" ? "INSTALLED" : row.tool.optional ? "MISSING (optional)" : "MISSING"
    lines.push(`  ${row.tool.capability.padEnd(20)}${(row.tool.binary || "-").padEnd(12)}${state}${version}`)
  }
  if (missing.length) {
    lines.push("", "install what is missing")
    if (plan.command) lines.push(`  ${plan.command}`)
    for (const tool of plan.manual) {
      lines.push(`  ${tool.binary}: ${terminalSafe(tool.note ?? "no package is available for this manager")}`)
    }
    lines.push("", "Cyrion never installs packages for you. Review the command, then run it yourself.")
  }
  console.log(lines.join("\n"))
  if (args.includes("--check") && missing.some((tool) => !tool.optional)) process.exitCode = 1
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
    const attestation = readFlag("--attest")
    if (!attestation) {
      throw new Error('scope lock requires --attest "who authorized this engagement, and under what reference"')
    }
    const lock = createScopeLock(manifest, attestation)
    const output = absolute(readFlag("--out") ?? "scope.lock")
    await Bun.write(output, `${JSON.stringify(lock, null, 2)}\n`)
    console.log([
      `Scope locked for ${terminalSafe(manifest.id)}`,
      `  hash        ${lock.scopeHash}`,
      `  attestation ${terminalSafe(lock.attestation)}`,
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
    "  cyrion scan [--target <url>] [--attest <text>] [--capabilities <list>]",
    "              [--sandbox local|container] [--mode autonomous|supervised]",
    "              [--out <directory>] [--dry-run] [--headless]",
    "  cyrion engage --scope <manifest> [--sandbox local|container] [--skills <dir>]",
    "                [--planner assessment|llm|llm-author] [--workers capability|llm]",
    "                [--model-timeout <ms>]",
    "                [--mode autonomous|supervised] [--approve-all] [--scope-lock <path>]",
    "                [--state <sqlite-path>] [--artifacts <directory>] [--headless]",
    "                [--allow-unsupervised-poc]",
    "  cyrion replay <finding-id> [--manifest <path>] [--artifacts <directory>]",
    "                [--bundle <path>] [--sandbox local|container] [--json]",
    "  cyrion ci --scope <manifest> [--fail-on critical|high|medium|low|info]",
    "            [--planner assessment|llm|llm-author] [--workers capability|llm]",
    "            [--fail-on-unresolved] [--formats markdown,json,html,sarif,junit,csv]",
    "            [--report <directory>] [--sandbox local|container] [--json] [--verbose]",
    "  cyrion tools [--sandbox local|container] [--json] [--check]",
    "  cyrion probe --capability <name> --target <expression> [--manifest <path>]",
    "               [--sandbox local|container] [--json]",
    "  cyrion scope check [--manifest <path>] [--target <expression>] [--json] [--check]",
    "  cyrion scope lock --attest <text> [--manifest <path>] [--out <path>]",
    "  cyrion mcp serve --state <sqlite-path> --engagement <id> [--artifacts <directory>]",
    "  cyrion mcp list [--config <path>] [--server <id>] [--manifest <path>] [--json]",
    "  cyrion mcp call --tool <name> [--config <path>] [--server <id>] [--input <json>] [--json]",
    "  cyrion status <engagement-id> --state <sqlite-path> [--json]",
    "  cyrion report <engagement-id> --state <sqlite-path>",
    "                [--format markdown|json|html|sarif|junit|csv] [--out <path>] [--fail-on <severity>]",
    "  cyrion version",
    "",
    "`cyrion scan` with no flags opens a form: target, capabilities, sandbox, mode, and who authorized it.",
    "Fixture scenarios: known-positive, clean, rejected, incomplete",
    "OpenCode and llm planning or worker review may make billable model requests.",
    "Headless supervised runs require --approve-all.",
    "poc.run is off unless the manifest grants it, and supervised unless --allow-unsupervised-poc.",
    "cyrion ci exits non-zero when the gate fails; reports are written either way.",
    "--fresh replaces artifacts written by an earlier fixture version.",
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
  else if (command === "probe") await runProbe()
  else if (command === "engage") await runEngagement()
  else if (command === "replay") await runReplay()
  else if (command === "ci") await runCi()
  else if (command === "scan") await runScan()
  else if (command === "mcp") await runMcp()
  else if (command === "demo") await runDemo()
  else if (command === "status") runStatus()
  else if (command === "report") await runReport()
  else throw new Error(`Unknown command: ${command}\n\n${usage()}`)
} catch (error) {
  console.error(`cyrion: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
