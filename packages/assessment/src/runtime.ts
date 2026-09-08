import { createHash } from "node:crypto"
import type {
  AgentRuntime,
  EvidenceRef,
  Finding,
  FindingReproduction,
  Observation,
  PocPlan,
  PocVerdict,
  RuntimeContext,
  Severity,
  TaskSpec,
  WorkerResult,
} from "@cyrion/contracts"
import type { Skill } from "@cyrion/skills"
import { PROTECTION_HEADERS, buildPocPlan, readDiscoveryClaim } from "./poc-plan"

/** Shape returned by the http.probe capability, which the gateway has already validated. */
interface ProbeSummary {
  status?: number
  headerNames?: string[]
  server?: string | null
  contentType?: string | null
  durationMs?: number
  bodyBytes?: number
  redirect?: { location?: string; inScope?: boolean; reason?: string | null }
  evidence?: EvidenceRef[]
}

/** Shape returned by poc.run, which the gateway has already validated. */
interface PocSummary {
  verdict?: PocVerdict
  bundleId?: string
  reproId?: string
  runner?: "local" | "container"
  createdAt?: string
  steps?: Array<{ id: string; met: boolean; status: number | null; detail: string }>
  evidence?: EvidenceRef[]
}

interface LookupSummary {
  host?: string
  addresses?: string[]
  literal?: boolean
  evidence?: EvidenceRef[]
}

export interface AssessmentRuntimeOptions {
  skills: readonly Skill[]
  /** Wall clock allowed for one capability call. */
  toolTimeoutMs?: number
  maxOutputBytes?: number
}

/**
 * Workers that carry out one skill each against one approved asset.
 *
 * Every observation and finding is derived from a capability result the tool
 * gateway admitted, and every claim carries the evidence the capability
 * captured. Nothing here interprets model output: a provider may review these
 * results, but the records themselves come from what the target actually
 * returned.
 */
export class CapabilityWorkerRuntime implements AgentRuntime {
  readonly #skills: readonly Skill[]
  readonly #timeoutMs: number
  readonly #maxOutputBytes: number

  constructor(options: AssessmentRuntimeOptions) {
    this.#skills = options.skills
    this.#timeoutMs = options.toolTimeoutMs ?? 30_000
    this.#maxOutputBytes = options.maxOutputBytes ?? 500_000
  }

  async runTask(task: TaskSpec, context: RuntimeContext): Promise<WorkerResult> {
    if (task.role === "recon") return this.#recon(task, context)
    if (task.role === "web" || task.role === "api") return this.#assess(task, context)
    if (task.role === "validator") return this.#validate(task, context)
    return this.#report(task, context)
  }

  async cancel(): Promise<void> {}

  async close(): Promise<void> {}

  async #recon(task: TaskSpec, context: RuntimeContext): Promise<WorkerResult> {
    const observations: Observation[] = []
    const evidence: EvidenceRef[] = []

    if (task.capabilities.includes("dns.lookup")) {
      const lookup = await this.#call<LookupSummary>(task, context, "dns.lookup", {})
      evidence.push(...(lookup.evidence ?? []))
      observations.push({
        id: `O-${context.agentId}-dns`.slice(0, 128),
        asset: task.target,
        summary: `Resolved to ${(lookup.addresses ?? []).join(", ") || "no address"}.`,
        source: context.agentId,
        evidenceIds: (lookup.evidence ?? []).map((item) => item.id),
      })
    }

    if (task.capabilities.includes("http.probe") && task.target.startsWith("http")) {
      const probe = await this.#call<ProbeSummary>(task, context, "http.probe", {})
      evidence.push(...(probe.evidence ?? []))
      observations.push({
        id: `O-${context.agentId}-http`.slice(0, 128),
        asset: task.target,
        summary: `Answered ${probe.status ?? "no status"}`
          + `${probe.server ? ` from ${probe.server}` : ""}`
          + `${probe.contentType ? ` as ${probe.contentType}` : ""}.`,
        source: context.agentId,
        evidenceIds: (probe.evidence ?? []).map((item) => item.id),
      })
    }

    const withEvidence = observations.filter((observation) => observation.evidenceIds.length)
    return {
      summary: `Inventoried ${task.target} with ${withEvidence.length} recorded observation(s).`,
      observations: withEvidence,
      findings: [],
      evidence,
    }
  }

  async #assess(task: TaskSpec, context: RuntimeContext): Promise<WorkerResult> {
    const skill = this.#skills.find((item) => item.id === task.skillId)
    const probe = await this.#call<ProbeSummary>(task, context, "http.probe", {})
    const evidence = probe.evidence ?? []
    const evidenceIds = evidence.map((item) => item.id)
    if (!evidenceIds.length) throw new Error("http.probe returned no evidence to support a claim")

    const findings: Finding[] = []
    if (task.skillId === "web-security-headers") {
      const missing = missingProtections(probe)
      if (missing.length) {
        findings.push(this.#finding({
          id: `F-HEADERS-${short(task.target)}`,
          title: "Missing browser protection headers",
          summary: `The response omits ${missing.join(", ")}.`,
          severity: severityFor(skill, "low"),
          task,
          context,
          evidenceIds,
        }))
      }
    } else if (task.skillId === "api-object-boundary" && returnsObjectContent(probe)) {
      findings.push(this.#finding({
        id: `F-OBJECT-${short(task.target)}`,
        title: "Object endpoint answers an unauthenticated request",
        summary: `An unauthenticated request returned ${probe.status} with ${probe.contentType}.`,
        severity: severityFor(skill, "high"),
        task,
        context,
        evidenceIds,
      }))
    }

    return {
      summary: findings.length
        ? `Assessed ${task.target}; ${findings.length} candidate(s) raised with fresh evidence.`
        : `Assessed ${task.target}; behaviour matched the expected policy.`,
      observations: [{
        id: `O-${context.agentId}-assess`.slice(0, 128),
        asset: task.target,
        summary: `Response ${probe.status ?? "unknown"} recorded for ${skill?.name ?? task.role} review.`,
        source: context.agentId,
        evidenceIds,
      }],
      findings,
      evidence,
    }
  }

  /**
   * Reproduces the candidate from its record. The verdict follows the fresh
   * response only: agreement confirms, disagreement rejects, and missing
   * evidence is inconclusive rather than a confident guess.
   */
  async #validate(task: TaskSpec, context: RuntimeContext): Promise<WorkerResult> {
    const candidate = context.candidate
    if (!candidate || candidate.id !== task.findingId) throw new Error("Validator received no candidate record")

    if (task.capabilities.includes("poc.run")) {
      const claim = await readDiscoveryClaim(context.candidateEvidence ?? [], context.evidenceStore)
      const plan = buildPocPlan(candidate, claim)
      if (plan) return this.#reproduce(task, context, candidate, plan)
    }
    if (!task.capabilities.includes("http.probe")) {
      throw new Error(`No reproduction capability is granted to ${task.id}`)
    }

    const probe = await this.#call<ProbeSummary>(task, context, "http.probe", {})
    const evidence = probe.evidence ?? []
    if (!evidence.length) throw new Error("Validation produced no fresh evidence")

    let status: Finding["status"] = "inconclusive"
    let summary = `${candidate.summary} Reproduction was inconclusive.`
    if (probe.status === undefined) {
      summary = `${candidate.summary} The asset did not answer during reproduction.`
    } else if (candidate.skillId === "web-security-headers") {
      const missing = missingProtections(probe)
      status = missing.length ? "confirmed" : "rejected"
      summary = missing.length
        ? `${candidate.summary} Reproduced independently: ${missing.join(", ")} still absent.`
        : `${candidate.summary} Independent reproduction found every header present.`
    } else if (candidate.skillId === "api-object-boundary") {
      const reproduced = returnsObjectContent(probe)
      status = reproduced ? "confirmed" : "rejected"
      summary = reproduced
        ? `${candidate.summary} Reproduced independently: the endpoint answered ${probe.status} without a credential.`
        : `${candidate.summary} Independent reproduction was refused by the endpoint.`
    }

    return {
      summary: `Validated ${candidate.id}: ${status}.`,
      observations: [],
      findings: [{
        ...candidate,
        status,
        summary,
        validatedBy: context.agentId,
        evidenceIds: [...new Set([...candidate.evidenceIds, ...evidence.map((item) => item.id)])],
      }],
      evidence,
    }
  }

  /**
   * Reproduces the candidate by executing its proof bundle.
   *
   * The verdict follows the bundle and nothing else: the run either met every
   * condition the plan stated, failed one of them, or could not decide. The
   * bundle, the raw exchanges, and the manual reproduction are all attached, so
   * the verdict can be checked without trusting this worker.
   */
  async #reproduce(
    task: TaskSpec,
    context: RuntimeContext,
    candidate: Finding,
    plan: PocPlan,
  ): Promise<WorkerResult> {
    const outcome = await this.#call<PocSummary>(task, context, "poc.run", { plan })
    const evidence = outcome.evidence ?? []
    if (!evidence.length) throw new Error("Reproduction produced no fresh evidence")
    const { verdict, bundleId, runner, createdAt } = outcome
    if (!verdict || !bundleId || !runner || !createdAt) throw new Error("Reproduction returned an incomplete record")

    const status: Finding["status"] = verdict === "reproduced"
      ? "confirmed"
      : verdict === "not-reproduced" ? "rejected" : "inconclusive"
    const steps = outcome.steps ?? []
    const detail = bounded(steps.find((step) => !step.met)?.detail ?? steps.at(0)?.detail ?? "no step was recorded")
    const summary = verdict === "reproduced"
      ? `${candidate.summary} Reproduced independently from proof bundle ${bundleId}: ${detail}.`
      : verdict === "not-reproduced"
        ? `${candidate.summary} Proof bundle ${bundleId} did not reproduce the claim: ${detail}.`
        : `${candidate.summary} Reproduction from proof bundle ${bundleId} was inconclusive: ${detail}.`

    const reproduction: FindingReproduction = {
      verdict,
      bundleId,
      steps: Math.max(1, steps.length),
      runner,
      at: createdAt,
    }
    return {
      summary: `Validated ${candidate.id}: ${status} by independent reproduction.`,
      observations: [],
      findings: [{
        ...candidate,
        status,
        summary,
        validatedBy: context.agentId,
        evidenceIds: [...new Set([...candidate.evidenceIds, ...evidence.map((item) => item.id)])],
        reproduction,
      }],
      evidence,
    }
  }

  async #report(task: TaskSpec, context: RuntimeContext): Promise<WorkerResult> {
    const report = [
      `# Engagement ${context.engagementId}`,
      "",
      `Prepared from accepted records for ${task.target}.`,
      "",
      "The controller admitted every finding in this report with verified evidence.",
      "Findings, verdicts, and evidence references are reproduced from the engagement",
      "record rather than restated by a worker.",
      "",
    ].join("\n")
    return { summary: "Report rendered from accepted records.", observations: [], findings: [], evidence: [], report }
  }

  #finding(input: {
    id: string
    title: string
    summary: string
    severity: Severity
    task: TaskSpec
    context: RuntimeContext
    evidenceIds: string[]
  }): Finding {
    return {
      id: input.id,
      title: input.title,
      asset: input.task.target,
      severity: input.severity,
      status: "candidate",
      summary: input.summary,
      discoveredBy: input.context.agentId,
      evidenceIds: input.evidenceIds,
      ...(input.task.skillId ? { skillId: input.task.skillId } : {}),
    }
  }

  async #call<T>(
    task: TaskSpec,
    context: RuntimeContext,
    capability: string,
    input: unknown,
  ): Promise<T> {
    if (!task.capabilities.includes(capability)) {
      throw new Error(`${capability} is not granted to ${task.id}`)
    }
    const result = await context.tools.execute<T>({
      capability,
      target: task.target,
      timeoutMs: this.#timeoutMs,
      maxOutputBytes: this.#maxOutputBytes,
      input,
    })
    return result.output
  }
}

/** Detail text reaches a finding summary, so it is bounded and control-free. */
function bounded(value: string, maximum = 400): string {
  const clean = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim()
  return clean.length > maximum ? `${clean.slice(0, maximum)}…` : clean || "no detail recorded"
}

function missingProtections(probe: ProbeSummary): string[] {
  const present = new Set(probe.headerNames ?? [])
  return PROTECTION_HEADERS.filter((header) => !present.has(header))
}

/** Object content, not a generic page: a JSON body returned with a success status. */
function returnsObjectContent(probe: ProbeSummary): boolean {
  return probe.status === 200 && !!probe.contentType && probe.contentType.includes("application/json")
}

function severityFor(skill: Skill | undefined, fallback: Severity): Severity {
  return skill?.severity ?? fallback
}

/**
 * Deterministic, identifier-safe suffix for a finding id.
 *
 * The readable part is truncated, so a digest of the full target is appended:
 * two sibling endpoints must never collapse onto one finding id, which the
 * controller would reject as a duplicate mid-engagement.
 */
function short(target: string): string {
  const clean = target.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  const digest = createHash("sha256").update(target).digest("hex").slice(0, 8)
  return `${clean.slice(0, 20) || "asset"}-${digest}`
}
