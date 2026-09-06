import {
  CONTRACT_VERSION,
  type EngagementSnapshot,
  type RootDecision,
  type RootPlanner,
  type TaskSpec,
} from "@cyrion/contracts"

const task = (spec: Omit<TaskSpec, "depth">): TaskSpec => ({ ...spec, depth: 1 })

export class FixtureRootPlanner implements RootPlanner {
  async decide(snapshot: EngagementSnapshot): Promise<RootDecision> {
    const roles = new Set(snapshot.tasks.map((item) => item.role))
    const primaryTarget = snapshot.manifest.scope.targets[0]!
    const apiTarget = snapshot.manifest.scope.targets.find((target) => target.startsWith("api.")) ?? primaryTarget

    if (!roles.has("recon")) {
      return this.delegate("Establish the approved inventory before assessment.", [
        task({
          id: "T-001",
          key: `recon:${primaryTarget}`,
          role: "recon",
          objective: "Inventory the approved fixture assets and record provenance.",
          target: primaryTarget,
          capabilities: ["fixture.read"],
          dependencies: [],
          expectedOutput: "inventory",
        }),
      ])
    }

    if (this.completed(snapshot, "recon") && !roles.has("web")) {
      return this.delegate("Assess the independent web and API surfaces concurrently.", [
        task({
          id: "T-002",
          key: `web:${primaryTarget}`,
          role: "web",
          objective: "Assess the approved fixture web surface.",
          target: primaryTarget,
          capabilities: ["fixture.read"],
          dependencies: ["T-001"],
          expectedOutput: "assessment",
        }),
        task({
          id: "T-003",
          key: `api:${apiTarget}`,
          role: "api",
          objective: "Assess the approved fixture API surface and return evidence references.",
          target: apiTarget,
          capabilities: ["fixture.read", "fixture.compare"],
          dependencies: ["T-001"],
          expectedOutput: "assessment",
        }),
      ])
    }

    const assessmentComplete = this.completed(snapshot, "web") && this.completed(snapshot, "api")
    const candidate = snapshot.findings.find((finding) => finding.status === "candidate")
    if (assessmentComplete && candidate && !roles.has("validator")) {
      return this.delegate("Validate the candidate independently with fresh fixture evidence.", [
        task({
          id: "T-004",
          key: `validate:${candidate.id}`,
          role: "validator",
          objective: `Independently validate candidate ${candidate.id} and return a bounded verdict.`,
          target: candidate.asset,
          capabilities: ["fixture.read", "fixture.compare"],
          dependencies: ["T-002", "T-003"],
          expectedOutput: "validation",
          findingId: candidate.id,
        }),
      ])
    }

    const readyToReport = assessmentComplete && (!roles.has("validator") || this.completed(snapshot, "validator"))
    if (readyToReport && !roles.has("reporter")) {
      const dependencies = roles.has("validator") ? ["T-004"] : ["T-002", "T-003"]
      return this.delegate("Prepare a report from accepted records and evidence only.", [
        task({
          id: "T-005",
          key: `report:${snapshot.manifest.id}`,
          role: "reporter",
          objective: "Render the fixture engagement report from structured records.",
          target: primaryTarget,
          capabilities: ["fixture.read"],
          dependencies,
          expectedOutput: "report",
        }),
      ])
    }

    if (this.completed(snapshot, "reporter")) {
      return {
        version: CONTRACT_VERSION,
        action: { kind: "finish", rationale: "Assessment, validation gates, and reporting completed." },
      }
    }

    return {
      version: CONTRACT_VERSION,
      action: { kind: "stop", reason: "policy", rationale: "No valid next transition exists." },
    }
  }

  async close(): Promise<void> {}

  private completed(snapshot: EngagementSnapshot, role: TaskSpec["role"]): boolean {
    return snapshot.tasks.some((item) => item.role === role && item.status === "completed")
  }

  private delegate(rationale: string, tasks: TaskSpec[]): RootDecision {
    return { version: CONTRACT_VERSION, action: { kind: "delegate", rationale, tasks } }
  }
}
