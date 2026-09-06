import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  CONTRACT_VERSION,
  assertManifest,
  type AgentRuntime,
  type EngagementManifest,
  type RootPlanner,
} from "@cyrion/contracts"
import { CyrionController, FixtureRootPlanner } from "@cyrion/controller"
import { FixtureAgentRuntime } from "@cyrion/runtime-opencode"

const projectRoot = join(import.meta.dir, "..")

async function manifest(): Promise<EngagementManifest> {
  const value: unknown = await Bun.file(join(projectRoot, "fixtures/demo/engagement.json")).json()
  assertManifest(value)
  return value
}

describe("community orchestration slice", () => {
  test("runs root to parallel workers to independent validation and report", async () => {
    const controller = new CyrionController(
      await manifest(),
      new FixtureAgentRuntime(),
      new FixtureRootPlanner(),
      join(projectRoot, "agents"),
    )
    const result = await controller.run()

    expect(result.status).toBe("completed")
    expect(result.agents).toHaveLength(6)
    expect(result.tasks).toHaveLength(5)
    expect(result.tasks.every((task) => task.status === "completed")).toBe(true)
    expect(result.findings).toEqual([
      expect.objectContaining({ id: "F-001", status: "confirmed", validatedBy: "validator-t-004" }),
    ])
    expect(result.evidence).toHaveLength(6)

    const webStarted = result.events.find((event) => event.type === "task.started" && event.taskId === "T-002")!
    const apiStarted = result.events.find((event) => event.type === "task.started" && event.taskId === "T-003")!
    const firstParallelCompletion = result.events.find(
      (event) => event.type === "task.completed" && ["T-002", "T-003"].includes(event.taskId ?? ""),
    )!
    expect(webStarted.sequence).toBeLessThan(firstParallelCompletion.sequence)
    expect(apiStarted.sequence).toBeLessThan(firstParallelCompletion.sequence)

    for (const completed of result.events.filter((event) => event.type === "task.completed")) {
      const started = result.events.find((event) => event.type === "task.started" && event.taskId === completed.taskId)
      expect(started?.sequence).toBeLessThan(completed.sequence)
    }
  })

  test("rejects a Root decision that widens scope before invoking a worker", async () => {
    let workerCalls = 0
    const runtime: AgentRuntime = {
      async runTask() {
        workerCalls += 1
        throw new Error("must not run")
      },
      async cancel() {},
      async close() {},
    }
    const planner: RootPlanner = {
      async decide() {
        return {
          version: CONTRACT_VERSION,
          action: {
            kind: "delegate" as const,
            rationale: "invalid fixture decision",
            tasks: [{
              id: "BAD-001",
              key: "bad:outside.example",
              role: "web" as const,
              objective: "Leave the approved scope.",
              target: "outside.example",
              capabilities: ["fixture.read"],
              dependencies: [],
              depth: 1,
              expectedOutput: "assessment" as const,
            }],
          },
        }
      },
      async close() {},
    }
    const controller = new CyrionController(await manifest(), runtime, planner, join(projectRoot, "agents"))
    const result = await controller.run()

    expect(result.status).toBe("failed")
    expect(workerCalls).toBe(0)
    expect(result.events.some((event) => event.type === "root.decision.rejected")).toBe(true)
  })
})
