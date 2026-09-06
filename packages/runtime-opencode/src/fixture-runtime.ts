import { createHash } from "node:crypto"
import type {
  AgentRuntime,
  EvidenceRef,
  RuntimeContext,
  TaskSpec,
  WorkerResult,
} from "@cyrion/contracts"

export class FixtureAgentRuntime implements AgentRuntime {
  readonly #cancelled = new Set<string>()

  async runTask(task: TaskSpec, context: RuntimeContext): Promise<WorkerResult> {
    await Bun.sleep(task.role === "web" ? 180 : task.role === "api" ? 210 : 90)
    if (this.#cancelled.has(context.agentId)) throw new Error("Worker cancelled")

    switch (task.role) {
      case "recon": {
        const evidence = this.#evidence("E-001", "fixture://inventory/approved-assets", "approved fixture inventory")
        return {
          summary: "Approved asset inventory saved.",
          observations: [
            {
              id: "O-001",
              asset: task.target,
              summary: "Fixture exposes one web surface and one API surface.",
              source: context.agentId,
              evidenceIds: [evidence.id],
            },
          ],
          findings: [],
          evidence: [evidence],
        }
      }
      case "web": {
        const evidence = this.#evidence("E-002", "fixture://web/security-headers", "fixture headers present")
        return {
          summary: "Web fixture assessed; no independently reportable issue produced.",
          observations: [
            {
              id: "O-002",
              asset: task.target,
              summary: "Web response controls recorded for comparison.",
              source: context.agentId,
              evidenceIds: [evidence.id],
            },
          ],
          findings: [],
          evidence: [evidence],
        }
      }
      case "api": {
        const request = this.#evidence("E-012", "fixture://api/request-metadata", "role A fixture request")
        const comparison = this.#evidence("E-013", "fixture://api/response-comparison", "role A and B response delta")
        return {
          summary: "API fixture assessed; one candidate queued for validation.",
          observations: [],
          findings: [
            {
              id: "F-001",
              title: "Object access control",
              asset: task.target,
              severity: "high",
              status: "candidate",
              summary: "Fixture responses differ across the supplied authorization boundary.",
              discoveredBy: context.agentId,
              evidenceIds: [request.id, comparison.id],
            },
          ],
          evidence: [request, comparison],
        }
      }
      case "validator": {
        const validation = this.#evidence("E-014", "fixture://validation/fresh-reproduction", "fresh fixture validation passed")
        return {
          summary: "Independent fixture reproduction passed.",
          observations: [],
          findings: [
            {
              id: "F-001",
              title: "Object access control",
              asset: task.target,
              severity: "high",
              status: "confirmed",
              summary: "Independent fixture reproduction confirmed the authorization mismatch.",
              discoveredBy: "api-t-003",
              validatedBy: context.agentId,
              evidenceIds: ["E-012", "E-013", validation.id],
            },
          ],
          evidence: [validation],
        }
      }
      case "reporter": {
        const report = [
          "# Cyrion Community fixture report",
          "",
          "One fixture finding was independently confirmed with three evidence records.",
          "This report contains synthetic lab data and is not a real assessment.",
        ].join("\n")
        const evidence = this.#evidence("E-015", "fixture://reports/ENG-0042.md", report)
        return { summary: "Evidence report prepared.", observations: [], findings: [], evidence: [evidence], report }
      }
    }
  }

  async cancel(agentId: string): Promise<void> {
    this.#cancelled.add(agentId)
  }

  async close(): Promise<void> {}

  #evidence(id: string, uri: string, content: string): EvidenceRef {
    return {
      id,
      kind: uri.includes("report") ? "report" : "fixture",
      uri,
      sha256: createHash("sha256").update(content).digest("hex"),
      capturedAt: new Date().toISOString(),
    }
  }
}
