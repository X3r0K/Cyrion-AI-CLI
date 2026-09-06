import type {
  AgentRuntime,
  EvidenceRef,
  Finding,
  FindingStatus,
  RuntimeContext,
  Severity,
  TaskSpec,
  ToolAdapter,
  ToolExecutionRequest,
  WorkerResult,
} from "@cyrion/contracts"

export type FixtureScenario = "known-positive" | "clean" | "rejected" | "incomplete"

export interface FixtureRuntimeOptions {
  scenario?: FixtureScenario
}

export class FixtureAgentRuntime implements AgentRuntime {
  readonly #cancelled = new Set<string>()
  readonly #scenario: FixtureScenario

  constructor(options: FixtureRuntimeOptions = {}) {
    this.#scenario = options.scenario ?? "known-positive"
  }

  async runTask(task: TaskSpec, context: RuntimeContext): Promise<WorkerResult> {
    await context.tools.execute({
      capability: task.capabilities.includes("fixture.compare") ? "fixture.compare" : "fixture.read",
      target: task.target,
      timeoutMs: 1_000,
      maxOutputBytes: 4_096,
      input: { fixture: this.#scenario, operation: task.role },
    })
    await Bun.sleep(task.role === "web" ? 180 : task.role === "api" ? 210 : 90)
    if (this.#cancelled.has(context.agentId)) throw new Error("Worker cancelled")

    switch (task.role) {
      case "recon": return this.#recon(task, context)
      case "web": return this.#web(task, context)
      case "api": return this.#api(task, context)
      case "validator": return this.#validate(task, context)
      case "reporter": return this.#report(context)
    }
  }

  async cancel(agentId: string): Promise<void> {
    this.#cancelled.add(agentId)
  }

  async close(): Promise<void> {}

  async #recon(task: TaskSpec, context: RuntimeContext): Promise<WorkerResult> {
    const evidence = await this.#evidence(
      context,
      "E-001",
      "fixture",
      JSON.stringify({ scenario: this.#scenario, assets: context.scope.targets }, null, 2),
      "application/json",
    )
    return {
      summary: "Approved asset inventory saved.",
      observations: [{
        id: "O-001",
        asset: task.target,
        summary: "Fixture exposes one web surface and one API surface.",
        source: context.agentId,
        evidenceIds: [evidence.id],
      }],
      findings: [],
      evidence: [evidence],
    }
  }

  async #web(task: TaskSpec, context: RuntimeContext): Promise<WorkerResult> {
    const evidence = await this.#evidence(
      context,
      "E-002",
      "response",
      JSON.stringify({ status: 200, controls: ["content-type", "frame-options"] }, null, 2),
      "application/json",
    )
    return {
      summary: "Web fixture assessed; no independently reportable issue produced.",
      observations: [{
        id: "O-002",
        asset: task.target,
        summary: "Web response controls recorded for comparison.",
        source: context.agentId,
        evidenceIds: [evidence.id],
      }],
      findings: [],
      evidence: [evidence],
    }
  }

  async #api(task: TaskSpec, context: RuntimeContext): Promise<WorkerResult> {
    const request = await this.#evidence(
      context,
      "E-012",
      "request",
      JSON.stringify({ method: "GET", resource: "/fixture/objects/42", identity: "role-a" }, null, 2),
      "application/json",
    )
    const comparison = await this.#evidence(
      context,
      "E-013",
      "response",
      JSON.stringify(this.#comparisonPayload(), null, 2),
      "application/json",
    )
    if (this.#scenario === "clean") {
      return {
        summary: "API fixture assessed; authorization behavior matched the expected policy.",
        observations: [{
          id: "O-003",
          asset: task.target,
          summary: "Both fixture identities received policy-consistent responses.",
          source: context.agentId,
          evidenceIds: [request.id, comparison.id],
        }],
        findings: [],
        evidence: [request, comparison],
      }
    }
    return {
      summary: "API fixture assessed; one candidate queued for independent validation.",
      observations: [],
      findings: [this.#finding("candidate", context.agentId, [request.id, comparison.id], undefined, task.target)],
      evidence: [request, comparison],
    }
  }

  async #validate(task: TaskSpec, context: RuntimeContext): Promise<WorkerResult> {
    const verdict = this.#validationVerdict()
    const validation = await this.#evidence(
      context,
      "E-014",
      "response",
      JSON.stringify({ candidate: task.findingId ?? "F-001", verdict, freshSession: true }, null, 2),
      "application/json",
    )
    return {
      summary: validationSummary(verdict),
      observations: [],
      findings: [this.#finding(verdict, "api-t-003", ["E-012", "E-013", validation.id], context.agentId, task.target)],
      evidence: [validation],
    }
  }

  async #report(context: RuntimeContext): Promise<WorkerResult> {
    const report = reportFor(this.#scenario)
    const evidence = await this.#evidence(context, "E-015", "report", report, "text/markdown", "md")
    return { summary: "Evidence report prepared.", observations: [], findings: [], evidence: [evidence], report }
  }

  #finding(
    status: FindingStatus,
    discoveredBy: string,
    evidenceIds: string[],
    validatedBy?: string,
    asset = "api.demo.lab.test",
  ): Finding {
    const severity: Severity = this.#scenario === "incomplete" ? "medium" : "high"
    return {
      id: "F-001",
      title: "Object access control",
      asset,
      severity,
      status,
      summary: findingSummary(status),
      discoveredBy,
      ...(validatedBy ? { validatedBy } : {}),
      evidenceIds,
    }
  }

  #comparisonPayload(): unknown {
    if (this.#scenario === "rejected") return { roleA: 200, roleB: 200, bodyDifference: "volatile timestamp only" }
    if (this.#scenario === "incomplete") return { roleA: 200, roleB: null, interrupted: true }
    return { roleA: 200, roleB: 403, objectBoundaryMismatch: true }
  }

  #validationVerdict(): Exclude<FindingStatus, "candidate" | "validating"> {
    if (this.#scenario === "rejected") return "rejected"
    if (this.#scenario === "incomplete") return "inconclusive"
    return "confirmed"
  }

  async #evidence(
    context: RuntimeContext,
    id: string,
    kind: EvidenceRef["kind"],
    content: string,
    contentType: string,
    extension?: string,
  ): Promise<EvidenceRef> {
    return context.evidenceStore.capture({
      engagementId: context.engagementId,
      id,
      kind,
      content,
      contentType,
      source: context.agentId,
      ...(extension ? { extension } : {}),
    })
  }
}

export class FixtureToolAdapter implements ToolAdapter {
  calls: ToolExecutionRequest[] = []

  async execute(request: ToolExecutionRequest, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw signal.reason
    this.calls.push(structuredClone(request))
    return {
      fixture: "demo",
      target: request.target,
      capability: request.capability,
      accepted: true,
    }
  }
}

function validationSummary(status: FindingStatus): string {
  if (status === "confirmed") return "Independent fixture reproduction confirmed the candidate."
  if (status === "rejected") return "Independent fixture reproduction rejected the candidate as a volatile-data difference."
  return "Independent fixture reproduction could not reach a defensible verdict with the available evidence."
}

function findingSummary(status: FindingStatus): string {
  if (status === "confirmed") return "Independent fixture reproduction confirmed the authorization mismatch."
  if (status === "rejected") return "Fresh comparison showed only an expected volatile timestamp difference."
  if (status === "inconclusive") return "The comparison could not be completed with sufficient fresh evidence."
  return "Fixture responses differ across the supplied authorization boundary."
}

function reportFor(scenario: FixtureScenario): string {
  const outcome = scenario === "known-positive"
    ? "One fixture finding was independently confirmed."
    : scenario === "clean"
      ? "No candidate findings were produced by the controlled clean fixture."
      : scenario === "rejected"
        ? "One candidate was independently rejected and is not reported as confirmed."
        : "One candidate remains inconclusive because fresh evidence was incomplete."
  return [
    "# Cyrion Community fixture report",
    "",
    `Scenario: ${scenario}`,
    "",
    outcome,
    "",
    "This report contains synthetic lab data and is not a real assessment.",
  ].join("\n")
}
