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

    if (!roles.has("recon")) {
      return this.delegate("Establish the approved inventory before assessment.", [
        task({
          id: "T-001",
          key: "recon:demo.lab.test",
          role: "recon",
          objective: "Inventory the approved fixture assets and record provenance.",
          target: "demo.lab.test",
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
          key: "web:demo.lab.test",
          role: "web",
          objective: "Assess the approved fixture web surface.",
          target: "demo.lab.test",
          capabilities: ["fixture.read"],
          dependencies: ["T-001"],
          expectedOutput: "assessment",
        }),
        task({
          id: "T-003",
          key: "api:api.demo.lab.test",
          role: "api",
          objective: "Assess the approved fixture API surface and return evidence references.",
          target: "api.demo.lab.test",
          capabilities: ["fixture.read", "fixture.compare"],
          dependencies: ["T-001"],
          expectedOutput: "assessment",
        }),
      ])
    }

    if (this.completed(snapshot, "web") && this.completed(snapshot, "api") && !roles.has("validator")) {
      return this.delegate("Validate the candidate independently with fresh fixture evidence.", [
        task({
          id: "T-004",
          key: "validate:F-001",
          role: "validator",
          objective: "Independently validate candidate F-001 and return a bounded verdict.",
          target: "api.demo.lab.test",
          capabilities: ["fixture.read", "fixture.compare"],
          dependencies: ["T-002", "T-003"],
          expectedOutput: "validation",
        }),
      ])
    }

    if (this.completed(snapshot, "validator") && !roles.has("reporter")) {
      return this.delegate("Prepare a report from accepted records and evidence only.", [
        task({
          id: "T-005",
          key: "report:ENG-0042",
          role: "reporter",
          objective: "Render the fixture engagement report from structured records.",
          target: "demo.lab.test",
          capabilities: ["fixture.read"],
          dependencies: ["T-004"],
          expectedOutput: "report",
        }),
      ])
    }

    if (this.completed(snapshot, "reporter")) {
      return {
        version: CONTRACT_VERSION,
        action: { kind: "finish", rationale: "All fixture tasks and independent validation completed." },
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
