import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import {
  CONTRACT_VERSION,
  assertManifest,
  type AgentRuntime,
  type EngagementManifest,
  type PendingApproval,
  type RootPlanner,
  type TaskSpec,
} from "@cyrion/contracts"
import { CyrionController, FixtureRootPlanner, ScopedToolGateway, SQLiteEngagementStore } from "@cyrion/controller"
import { MemoryEvidenceStore } from "@cyrion/evidence"
import { FixtureAgentRuntime, FixtureToolAdapter } from "@cyrion/runtime-opencode"

const projectRoot = join(import.meta.dir, "..")

describe("supervised delegation", () => {
  test("waits for approval before every Root delegation", async () => {
    const { controller, adapter } = await supervisedController()
    controller.events.subscribe((event) => {
      if (event.type === "root.decision.awaiting_approval") queueMicrotask(() => controller.approvePending())
    })
    const result = await controller.run()

    const requested = result.events.filter((event) => event.type === "root.decision.awaiting_approval")
    const approved = result.events.filter((event) => event.type === "root.decision.approved")
    expect(result.status).toBe("completed")
    expect(requested).toHaveLength(4)
    expect(approved).toHaveLength(4)
    expect(adapter.calls).toHaveLength(5)
    for (const request of requested) {
      const payload = request.payload as { approvalId: string; tasks: Array<{ id: string }> }
      const approval = approved.find((event) =>
        (event.payload as { approvalId?: string }).approvalId === payload.approvalId
      )
      expect(approval).toBeDefined()
      for (const task of payload.tasks) {
        const queued = result.events.find((event) => event.type === "task.queued" && event.taskId === task.id)
        expect(approval!.sequence).toBeLessThan(queued!.sequence)
      }
    }
    controller.close()
  })

  test("denial cancels the engagement without dispatching the proposal", async () => {
    const { controller, adapter } = await supervisedController()
    const running = controller.run()
    await waitFor(() => controller.snapshot.pendingApproval?.status === "pending")

    expect(controller.snapshot.tasks).toHaveLength(0)
    expect(controller.denyPending("Operator declined this delegation.")).toBe(true)
    const result = await running

    expect(result.status).toBe("cancelled")
    expect(adapter.calls).toHaveLength(0)
    expect(result.tasks).toHaveLength(0)
    expect(result.events.some((event) => event.type === "root.decision.denied")).toBe(true)
    expect(result.events.some((event) => event.type === "engagement.cancelled")).toBe(true)
    controller.close()
  })

  test("resumes a durable pending approval and preserves task identity", async () => {
    const manifest = await supervisedManifest()
    const directory = await mkdtemp("/tmp/cyrion-supervised-")
    const databasePath = join(directory, "state.sqlite")
    const store = new SQLiteEngagementStore(databasePath, manifest.id)
    const startedAt = new Date().toISOString()
    const task = reconTask()
    const approval: PendingApproval = {
      id: "APPROVAL-RECOVERY",
      requestedAt: startedAt,
      status: "pending",
      decision: {
        version: CONTRACT_VERSION,
        action: { kind: "delegate", rationale: "Recover this approved fixture proposal.", tasks: [task] },
      },
    }
    store.saveSnapshot({
      manifest,
      status: "running",
      startedAt,
      agents: [{ id: "root-agent", role: "root", name: "root-agent", status: "running", startedAt }],
      tasks: [],
      findings: [],
      evidence: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      pendingApproval: approval,
      events: [],
    })
    store.close()

    const evidenceStore = new MemoryEvidenceStore()
    const adapter = new FixtureToolAdapter()
    const recoveredStore = new SQLiteEngagementStore(databasePath, manifest.id)
    const controller = new CyrionController(
      manifest,
      new FixtureAgentRuntime(),
      new FixtureRootPlanner(),
      join(projectRoot, "agents"),
      {
        store: recoveredStore,
        toolGateway: fixtureGateway(manifest, adapter),
        heartbeatIntervalMs: 50,
        autoApprove: true,
        evidenceStore,
      },
    )
    const result = await controller.run()

    expect(result.status).toBe("completed")
    expect(result.tasks.find((item) => item.id === task.id)?.attempt).toBe(1)
    expect(result.events.some((event) =>
      event.type === "root.decision.approved"
      && (event.payload as { approvalId?: string }).approvalId === approval.id
    )).toBe(true)
    expect(result.pendingApproval).toBeUndefined()
    controller.close()
  })

  test("rejects a stored approval whose target no longer satisfies policy", async () => {
    const manifest = await supervisedManifest()
    const directory = await mkdtemp("/tmp/cyrion-supervised-policy-")
    const databasePath = join(directory, "state.sqlite")
    const store = new SQLiteEngagementStore(databasePath, manifest.id)
    const startedAt = new Date().toISOString()
    const approval: PendingApproval = {
      id: "APPROVAL-TAMPERED",
      requestedAt: startedAt,
      status: "approved",
      decision: {
        version: CONTRACT_VERSION,
        action: {
          kind: "delegate",
          rationale: "Stored out-of-scope proposal.",
          tasks: [{ ...reconTask(), target: "outside.example", key: "recon:outside.example" }],
        },
      },
    }
    store.saveSnapshot({
      manifest,
      status: "running",
      startedAt,
      agents: [{ id: "root-agent", role: "root", name: "root-agent", status: "running", startedAt }],
      tasks: [],
      findings: [],
      evidence: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      pendingApproval: approval,
      events: [],
    })
    store.close()

    let workerCalls = 0
    const runtime: AgentRuntime = {
      async runTask() {
        workerCalls += 1
        throw new Error("must not dispatch")
      },
      async cancel() {},
      async close() {},
    }
    const recoveredStore = new SQLiteEngagementStore(databasePath, manifest.id)
    const controller = new CyrionController(
      manifest,
      runtime,
      new FixtureRootPlanner(),
      join(projectRoot, "agents"),
      { store: recoveredStore, autoApprove: true },
    )
    const result = await controller.run()

    expect(result.status).toBe("failed")
    expect(workerCalls).toBe(0)
    expect(result.tasks).toHaveLength(0)
    expect(result.pendingApproval).toBeUndefined()
    expect(result.events.find((event) => event.type === "root.decision.rejected")?.payload)
      .toEqual(expect.objectContaining({
        rejection: "Out-of-scope target: outside.example (target is not covered by the approved scope)",
      }))
    controller.close()
  })

  test("reconstructs an event-first approval when the snapshot write was interrupted", async () => {
    const manifest = await supervisedManifest()
    const directory = await mkdtemp("/tmp/cyrion-supervised-event-")
    const databasePath = join(directory, "state.sqlite")
    const store = new SQLiteEngagementStore(databasePath, manifest.id)
    const startedAt = new Date().toISOString()
    const task = reconTask()
    const decision = {
      version: CONTRACT_VERSION,
      action: { kind: "delegate" as const, rationale: "Event-first approval fixture.", tasks: [task] },
    }
    store.saveSnapshot({
      manifest,
      status: "running",
      startedAt,
      agents: [{ id: "root-agent", role: "root", name: "root-agent", status: "running", startedAt }],
      tasks: [],
      findings: [],
      evidence: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      events: [],
    })
    store.append({ engagementId: manifest.id, type: "root.decision.proposed", agentId: "root-agent", payload: decision })
    store.append({
      engagementId: manifest.id,
      type: "root.decision.awaiting_approval",
      agentId: "root-agent",
      payload: { approvalId: "APPROVAL-EVENT", rationale: decision.action.rationale, tasks: [{ id: task.id }] },
    })
    store.close()

    const evidenceStore = new MemoryEvidenceStore()
    const adapter = new FixtureToolAdapter()
    const recoveredStore = new SQLiteEngagementStore(databasePath, manifest.id)
    const controller = new CyrionController(
      manifest,
      new FixtureAgentRuntime(),
      new FixtureRootPlanner(),
      join(projectRoot, "agents"),
      {
        store: recoveredStore,
        toolGateway: fixtureGateway(manifest, adapter),
        heartbeatIntervalMs: 50,
        autoApprove: true,
        evidenceStore,
      },
    )
    const result = await controller.run()

    expect(result.status).toBe("completed")
    expect(result.tasks.find((item) => item.id === task.id)?.attempt).toBe(1)
    expect(result.events.some((event) =>
      event.type === "root.decision.approved"
      && (event.payload as { approvalId?: string }).approvalId === "APPROVAL-EVENT"
    )).toBe(true)
    controller.close()
  })

  test("restores an event-first cancellation before any planner or worker can run", async () => {
    const manifest = await supervisedManifest()
    const directory = await mkdtemp("/tmp/cyrion-supervised-cancel-")
    const databasePath = join(directory, "state.sqlite")
    const store = new SQLiteEngagementStore(databasePath, manifest.id)
    const startedAt = new Date().toISOString()
    store.saveSnapshot({
      manifest,
      status: "running",
      startedAt,
      agents: [{ id: "root-agent", role: "root", name: "root-agent", status: "waiting", startedAt }],
      tasks: [],
      findings: [],
      evidence: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      events: [],
    })
    store.append({
      engagementId: manifest.id,
      type: "engagement.cancelled",
      agentId: "root-agent",
      payload: { reason: "supervisor-denied" },
    })
    store.close()

    let runtimeCalls = 0
    let plannerCalls = 0
    const runtime: AgentRuntime = {
      async runTask() {
        runtimeCalls += 1
        throw new Error("must not dispatch")
      },
      async cancel() {},
      async close() {},
    }
    const planner: RootPlanner = {
      async decide() {
        plannerCalls += 1
        throw new Error("must not plan")
      },
      async close() {},
    }
    const recoveredStore = new SQLiteEngagementStore(databasePath, manifest.id)
    const controller = new CyrionController(manifest, runtime, planner, join(projectRoot, "agents"), { store: recoveredStore })
    const result = await controller.run()

    expect(result.status).toBe("cancelled")
    expect(runtimeCalls).toBe(0)
    expect(plannerCalls).toBe(0)
    expect(result.agents[0]?.status).toBe("cancelled")
    controller.close()
  })
})

async function supervisedController(): Promise<{ controller: CyrionController; adapter: FixtureToolAdapter }> {
  const manifest = await supervisedManifest()
  const evidenceStore = new MemoryEvidenceStore()
  const adapter = new FixtureToolAdapter()
  return {
    adapter,
    controller: new CyrionController(
      manifest,
      new FixtureAgentRuntime(),
      new FixtureRootPlanner(),
      join(projectRoot, "agents"),
      { toolGateway: fixtureGateway(manifest, adapter), heartbeatIntervalMs: 50, evidenceStore },
    ),
  }
}

async function supervisedManifest(): Promise<EngagementManifest> {
  const value: unknown = await Bun.file(join(projectRoot, "fixtures/demo/engagement.json")).json()
  assertManifest(value)
  return { ...value, mode: "supervised" }
}

function fixtureGateway(manifest: EngagementManifest, adapter: FixtureToolAdapter): ScopedToolGateway {
  return new ScopedToolGateway(manifest, { "fixture.read": adapter, "fixture.compare": adapter })
}

function reconTask(): TaskSpec {
  return {
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
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for supervised approval")
    await Bun.sleep(5)
  }
}
