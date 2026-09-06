import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import {
  CONTRACT_VERSION,
  assertManifest,
  type AgentRuntime,
  type EngagementManifest,
  type RootPlanner,
  type TaskSpec,
} from "@cyrion/contracts"
import {
  CyrionController,
  FixtureRootPlanner,
  ScopedToolGateway,
  SQLiteEngagementStore,
  taskInputHash,
} from "@cyrion/controller"
import { FixtureAgentRuntime, FixtureToolAdapter } from "@cyrion/runtime-opencode"

const projectRoot = join(import.meta.dir, "..")

async function manifest(): Promise<EngagementManifest> {
  const value: unknown = await Bun.file(join(projectRoot, "fixtures/demo/engagement.json")).json()
  assertManifest(value)
  return value
}

function fixtureGateway(value: EngagementManifest, adapter = new FixtureToolAdapter()): ScopedToolGateway {
  return new ScopedToolGateway(value, {
    "fixture.read": adapter,
    "fixture.compare": adapter,
  })
}

describe("community orchestration slice", () => {
  test("runs root to parallel workers to independent validation and report", async () => {
    const engagement = await manifest()
    const controller = new CyrionController(
      engagement,
      new FixtureAgentRuntime(),
      new FixtureRootPlanner(),
      join(projectRoot, "agents"),
      { toolGateway: fixtureGateway(engagement), heartbeatIntervalMs: 50 },
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
    expect(result.events.filter((event) => event.type === "tool.request.completed")).toHaveLength(5)

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

  test("recovers a persisted running task and completes without duplicate task identity", async () => {
    const engagement = await manifest()
    const temp = await mkdtemp("/tmp/cyrion-community-")
    const databasePath = join(temp, "state.sqlite")
    const firstStore = new SQLiteEngagementStore(databasePath, engagement.id)
    const recon: TaskSpec = {
      id: "T-001",
      key: "recon:demo.lab.test",
      role: "recon",
      objective: "Inventory the approved fixture assets and record provenance.",
      target: "demo.lab.test",
      capabilities: ["fixture.read"],
      dependencies: [],
      expectedOutput: "inventory",
      depth: 1,
    }
    const startedAt = new Date().toISOString()
    firstStore.saveSnapshot({
      manifest: engagement,
      status: "running",
      startedAt,
      agents: [
        { id: "root-agent", role: "root", name: "root-agent", status: "running", startedAt },
        {
          id: "recon-t-001",
          role: "recon",
          name: "recon-01",
          taskId: "T-001",
          parentId: "root-agent",
          status: "running",
          startedAt,
        },
      ],
      tasks: [{
        ...recon,
        status: "running",
        agentId: "recon-t-001",
        inputHash: taskInputHash(recon),
        attempt: 1,
        lease: {
          ownerId: "recon-t-001",
          acquiredAt: startedAt,
          heartbeatAt: startedAt,
          expiresAt: new Date(Date.now() + 5_000).toISOString(),
        },
      }],
      findings: [],
      evidence: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      events: [],
    })
    firstStore.close()

    const recoveredStore = new SQLiteEngagementStore(databasePath, engagement.id)
    const controller = new CyrionController(
      engagement,
      new FixtureAgentRuntime(),
      new FixtureRootPlanner(),
      join(projectRoot, "agents"),
      {
        store: recoveredStore,
        toolGateway: fixtureGateway(engagement),
        heartbeatIntervalMs: 50,
      },
    )
    const result = await controller.run()

    expect(result.status).toBe("completed")
    expect(result.tasks.map((task) => task.id)).toEqual(["T-001", "T-002", "T-003", "T-004", "T-005"])
    expect(new Set(result.tasks.map((task) => task.inputHash)).size).toBe(5)
    expect(result.tasks.find((task) => task.id === "T-001")?.attempt).toBe(2)
    expect(result.agents.filter((agent) => agent.id === "recon-t-001")).toHaveLength(1)
    expect(result.events.some((event) => event.type === "engagement.recovered")).toBe(true)
    expect(result.events.some((event) => event.type === "task.reconciled" && event.taskId === "T-001")).toBe(true)
    controller.close()

    const verificationStore = new SQLiteEngagementStore(databasePath, engagement.id)
    expect(verificationStore.loadSnapshot()?.status).toBe("completed")
    const sequences = verificationStore.list().map((event) => event.sequence)
    expect(sequences).toEqual(sequences.map((_, index) => index + 1))
    verificationStore.close()
  })

  test("replays a durable completion event instead of repeating an interrupted side effect", async () => {
    const engagement = await manifest()
    const temp = await mkdtemp("/tmp/cyrion-event-replay-")
    const databasePath = join(temp, "state.sqlite")
    const store = new SQLiteEngagementStore(databasePath, engagement.id)
    const startedAt = new Date().toISOString()
    const recon: TaskSpec = {
      id: "T-001",
      key: "recon:demo.lab.test",
      role: "recon",
      objective: "Inventory the approved fixture assets and record provenance.",
      target: "demo.lab.test",
      capabilities: ["fixture.read"],
      dependencies: [],
      expectedOutput: "inventory",
      depth: 1,
    }
    store.saveSnapshot({
      manifest: engagement,
      status: "running",
      startedAt,
      agents: [
        { id: "root-agent", role: "root", name: "root-agent", status: "running", startedAt },
        {
          id: "recon-t-001",
          role: "recon",
          name: "recon-01",
          taskId: "T-001",
          parentId: "root-agent",
          status: "running",
          startedAt,
        },
      ],
      tasks: [{
        ...recon,
        status: "running",
        agentId: "recon-t-001",
        inputHash: taskInputHash(recon),
        attempt: 1,
      }],
      findings: [],
      evidence: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      events: [],
    })
    const replayedResult = {
      summary: "Already completed before process interruption.",
      observations: [],
      findings: [],
      evidence: [{
        id: "E-001",
        kind: "fixture" as const,
        uri: "fixture://inventory/approved-assets",
        sha256: "a".repeat(64),
        capturedAt: startedAt,
      }],
    }
    store.append({
      engagementId: engagement.id,
      type: "task.completed",
      agentId: "recon-t-001",
      taskId: "T-001",
      payload: { summary: replayedResult.summary, result: replayedResult },
    })
    store.close()

    const adapter = new FixtureToolAdapter()
    const recoveredStore = new SQLiteEngagementStore(databasePath, engagement.id)
    const controller = new CyrionController(
      engagement,
      new FixtureAgentRuntime(),
      new FixtureRootPlanner(),
      join(projectRoot, "agents"),
      { store: recoveredStore, toolGateway: fixtureGateway(engagement, adapter), heartbeatIntervalMs: 50 },
    )
    const result = await controller.run()

    expect(result.status).toBe("completed")
    expect(result.tasks.find((task) => task.id === "T-001")?.attempt).toBe(1)
    expect(adapter.calls.some((request) => request.taskId === "T-001")).toBe(false)
    expect(adapter.calls).toHaveLength(4)
    expect(result.evidence.filter((evidence) => evidence.id === "E-001")).toHaveLength(1)
    expect(result.events.some((event) =>
      event.type === "task.reconciled"
      && (event.payload as { action?: string }).action === "accept-completed-event"
    )).toBe(true)
    controller.close()
  })

  test("binds tool calls to the assigned target, capability, timeout, and output budget", async () => {
    const engagement = await manifest()
    const adapter = new FixtureToolAdapter()
    const gateway = fixtureGateway(engagement, adapter)
    const events: string[] = []
    const auditPayloads: unknown[] = []
    const task: TaskSpec = {
      id: "T-GATEWAY",
      key: "gateway:demo.lab.test",
      role: "web",
      objective: "Read the approved fixture.",
      target: "demo.lab.test",
      capabilities: ["fixture.read"],
      dependencies: [],
      expectedOutput: "assessment",
      depth: 1,
    }
    const bound = gateway.bind({
      engagementId: engagement.id,
      agentId: "web-gateway",
      task,
      emit: (type, payload) => {
        events.push(type)
        auditPayloads.push(payload)
      },
    })

    const accepted = await bound.execute({
      capability: "fixture.read",
      target: "demo.lab.test",
      timeoutMs: 500,
      maxOutputBytes: 1_024,
      input: { operation: "read" },
    })
    expect(accepted.outputBytes).toBeGreaterThan(0)
    expect(adapter.calls).toHaveLength(1)
    expect(events).toEqual(["tool.request.accepted", "tool.request.completed"])

    await expect(bound.execute({
      capability: "fixture.read",
      target: "outside.example",
      timeoutMs: 500,
      maxOutputBytes: 1_024,
      input: { secret: "must-not-be-persisted" },
    })).rejects.toThrow("does not match assigned task")
    await expect(bound.execute({
      capability: "fixture.compare",
      target: "demo.lab.test",
      timeoutMs: 500,
      maxOutputBytes: 1_024,
      input: {},
    })).rejects.toThrow("not assigned to this task")
    expect(adapter.calls).toHaveLength(1)
    expect(JSON.stringify(auditPayloads)).not.toContain("must-not-be-persisted")
  })

  test("cancels an active worker without misreporting the engagement as failed", async () => {
    const engagement = await manifest()
    const controller = new CyrionController(
      engagement,
      new FixtureAgentRuntime(),
      new FixtureRootPlanner(),
      join(projectRoot, "agents"),
      { toolGateway: fixtureGateway(engagement), heartbeatIntervalMs: 50 },
    )
    const running = controller.run()
    while (!controller.snapshot.events.some((event) => event.type === "task.started")) await Bun.sleep(5)
    await controller.cancel()
    const result = await running

    expect(result.status).toBe("cancelled")
    expect(result.events.some((event) => event.type === "engagement.cancelled")).toBe(true)
    expect(result.events.some((event) => event.type === "task.cancelled")).toBe(true)
    expect(result.events.some((event) => event.type === "engagement.failed")).toBe(false)
  })

  test("records measured usage and stops when a worker exhausts the token budget", async () => {
    const engagement = await manifest()
    engagement.budgets.maxTokens = 5
    const runtime: AgentRuntime = {
      async runTask() {
        return {
          summary: "Budget fixture",
          observations: [],
          findings: [],
          evidence: [],
          usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.01 },
        }
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
            rationale: "Exercise the worker budget.",
            tasks: [{
              id: "T-BUDGET",
              key: "budget:demo.lab.test",
              role: "recon" as const,
              objective: "Return measured fixture usage.",
              target: "demo.lab.test",
              capabilities: ["fixture.read"],
              dependencies: [],
              depth: 1,
              expectedOutput: "inventory" as const,
            }],
          },
        }
      },
      async close() {},
    }
    const controller = new CyrionController(engagement, runtime, planner, join(projectRoot, "agents"))
    const result = await controller.run()

    expect(result.status).toBe("failed")
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 2, costUsd: 0.01 })
    expect(result.events.some((event) => event.type === "budget.exceeded")).toBe(true)
    expect(result.tasks.at(0)?.status).toBe("failed")
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
