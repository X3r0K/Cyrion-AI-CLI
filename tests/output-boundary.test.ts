import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import {
  CONTRACT_VERSION,
  assertManifest,
  type AgentRuntime,
  type EngagementManifest,
  type EngagementSnapshot,
  type RootDecision,
  type RootPlanner,
  type TaskSpec,
  type WorkerResult,
} from "@cyrion/contracts"
import {
  CyrionController,
  SQLiteEngagementStore,
  taskInputHash,
  workerResultPolicyError,
} from "@cyrion/controller"

const projectRoot = join(import.meta.dir, "..")

async function fixtureManifest(): Promise<EngagementManifest> {
  const value: unknown = await Bun.file(join(projectRoot, "fixtures/demo/engagement.json")).json()
  assertManifest(value)
  return value
}

describe("untrusted model output boundary", () => {
  test("rejects malformed Root output without persisting opaque fields", async () => {
    const marker = "provider-private-output-must-not-be-recorded"
    let workerCalls = 0
    const runtime: AgentRuntime = {
      async runTask() {
        workerCalls += 1
        return emptyResult()
      },
      async cancel() {},
      async close() {},
    }
    const planner: RootPlanner = {
      async decide() {
        return {
          version: CONTRACT_VERSION,
          action: {
            kind: "delegate",
            rationale: "Malformed provider fixture.",
            tasks: [assessmentTask()],
            opaque: marker,
          },
        } as unknown as RootDecision
      },
      async close() {},
    }
    const controller = new CyrionController(await fixtureManifest(), runtime, planner, join(projectRoot, "agents"))
    const result = await controller.run()

    expect(result.status).toBe("failed")
    expect(workerCalls).toBe(0)
    expect(result.events.some((event) => event.type === "root.decision.rejected")).toBe(true)
    expect(result.events.some((event) => event.type === "root.decision.proposed")).toBe(false)
    expect(JSON.stringify(result.events)).not.toContain(marker)
  })

  test("rejects forged worker provenance before accepting evidence", async () => {
    const runtime: AgentRuntime = {
      async runTask(_task, context) {
        return {
          ...emptyResult(),
          evidence: [{
            id: "E-FORGED",
            kind: "response",
            uri: `artifact://${context.engagementId}/E-FORGED.json`,
            sha256: "a".repeat(64),
            capturedAt: new Date().toISOString(),
            source: "root-agent",
            contentType: "application/json",
            sizeBytes: 2,
          }],
        }
      },
      async cancel() {},
      async close() {},
    }
    const controller = new CyrionController(
      await fixtureManifest(),
      runtime,
      singleTaskPlanner(assessmentTask()),
      join(projectRoot, "agents"),
    )
    const result = await controller.run()

    expect(result.status).toBe("failed")
    expect(result.evidence).toHaveLength(0)
    expect(result.events.some((event) => event.type === "task.result.rejected")).toBe(true)
    expect(result.events.some((event) => event.type === "task.completed")).toBe(false)
  })

  test("does not persist opaque fields from a malformed worker result", async () => {
    const marker = "opaque-worker-output-must-not-be-recorded"
    const runtime: AgentRuntime = {
      async runTask() {
        return { ...emptyResult(), opaque: marker } as unknown as WorkerResult
      },
      async cancel() {},
      async close() {},
    }
    const controller = new CyrionController(
      await fixtureManifest(),
      runtime,
      singleTaskPlanner(assessmentTask()),
      join(projectRoot, "agents"),
    )
    const result = await controller.run()

    expect(result.status).toBe("failed")
    expect(result.events.some((event) => event.type === "task.result.rejected")).toBe(true)
    expect(JSON.stringify(result.events)).not.toContain(marker)
  })

  test("prevents a discovery worker from bypassing independent validation", async () => {
    const runtime: AgentRuntime = {
      async runTask(task, context) {
        const evidenceId = "E-DISCOVERY"
        return {
          summary: "Attempted final verdict.",
          observations: [],
          evidence: [{
            id: evidenceId,
            kind: "response",
            uri: `artifact://${context.engagementId}/${evidenceId}.json`,
            sha256: "b".repeat(64),
            capturedAt: new Date().toISOString(),
            source: context.agentId,
            contentType: "application/json",
            sizeBytes: 2,
          }],
          findings: [{
            id: "F-BYPASS",
            title: "Unvalidated claim",
            asset: task.target,
            severity: "high",
            status: "confirmed",
            summary: "A discovery worker attempted to self-confirm.",
            discoveredBy: context.agentId,
            validatedBy: context.agentId,
            evidenceIds: [evidenceId],
          }],
        }
      },
      async cancel() {},
      async close() {},
    }
    const controller = new CyrionController(
      await fixtureManifest(),
      runtime,
      singleTaskPlanner(assessmentTask()),
      join(projectRoot, "agents"),
    )
    const result = await controller.run()

    expect(result.status).toBe("failed")
    expect(result.findings).toHaveLength(0)
    expect(result.events.find((event) => event.type === "task.result.rejected")?.payload)
      .toEqual(expect.objectContaining({ reason: expect.stringContaining("must begin as a candidate") }))
  })

  test("validates manifests beyond their TypeScript shape", async () => {
    const manifest = await fixtureManifest()
    expect(() => assertManifest({ ...manifest, hiddenPolicy: true })).toThrow("unexpected field")
    expect(() => assertManifest({
      ...manifest,
      budgets: { ...manifest.budgets, maxCostUsd: Number.POSITIVE_INFINITY },
    })).toThrow("maxCostUsd")
  })

  test("rejects cyclic Root task graphs before dispatch", async () => {
    let workerCalls = 0
    const runtime: AgentRuntime = {
      async runTask() {
        workerCalls += 1
        return emptyResult()
      },
      async cancel() {},
      async close() {},
    }
    const first = assessmentTask()
    first.id = "T-CYCLE-A"
    first.key = "cycle-a"
    first.dependencies = ["T-CYCLE-B"]
    const second = { ...assessmentTask(), id: "T-CYCLE-B", key: "cycle-b", dependencies: ["T-CYCLE-A"] }
    const planner: RootPlanner = {
      async decide() {
        return {
          version: CONTRACT_VERSION,
          action: { kind: "delegate" as const, rationale: "Cyclic fixture.", tasks: [first, second] },
        }
      },
      async close() {},
    }
    const controller = new CyrionController(await fixtureManifest(), runtime, planner, join(projectRoot, "agents"))
    const result = await controller.run()

    expect(result.status).toBe("failed")
    expect(workerCalls).toBe(0)
    expect(result.events.find((event) => event.type === "root.decision.rejected")?.payload)
      .toEqual(expect.objectContaining({ rejection: "Task dependency cycle rejected" }))
  })

  test("requires validators to preserve the candidate and attach fresh evidence", async () => {
    const engagement = await fixtureManifest()
    const candidate = {
      id: "F-BOUNDARY",
      title: "Candidate title",
      asset: "api.demo.lab.test",
      severity: "high" as const,
      status: "validating" as const,
      summary: "Candidate summary.",
      discoveredBy: "api-t-discovery",
      evidenceIds: ["E-OLD"],
    }
    const snapshot: EngagementSnapshot = {
      manifest: engagement,
      status: "running",
      agents: [],
      tasks: [],
      findings: [candidate],
      evidence: [{
        id: "E-OLD",
        kind: "response",
        uri: `artifact://${engagement.id}/E-OLD.json`,
        sha256: "c".repeat(64),
        capturedAt: new Date().toISOString(),
        source: "api-t-discovery",
      }],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      events: [],
    }
    const task: TaskSpec = {
      id: "T-VALIDATE",
      key: "validate:F-BOUNDARY",
      role: "validator",
      objective: "Validate one candidate.",
      target: candidate.asset,
      capabilities: ["fixture.compare"],
      dependencies: [],
      depth: 1,
      expectedOutput: "validation",
      findingId: candidate.id,
    }
    const result: WorkerResult = {
      summary: "Validator verdict.",
      observations: [],
      evidence: [],
      findings: [{
        ...candidate,
        status: "confirmed",
        validatedBy: "validator-t-validate",
      }],
    }

    expect(workerResultPolicyError(result, task, snapshot, "validator-t-validate"))
      .toBe("Validator did not attach fresh evidence")
    result.findings[0]!.severity = "critical"
    expect(workerResultPolicyError(result, task, snapshot, "validator-t-validate"))
      .toBe("Validator changed immutable candidate fields")
  })

  test("requeues a persisted completion when its result fails provenance checks", async () => {
    const engagement = await fixtureManifest()
    const task = assessmentTask()
    const agentId = "web-t-boundary"
    const startedAt = new Date().toISOString()
    const directory = await mkdtemp("/tmp/cyrion-output-replay-")
    const databasePath = join(directory, "state.sqlite")
    const firstStore = new SQLiteEngagementStore(databasePath, engagement.id)
    firstStore.saveSnapshot({
      manifest: engagement,
      status: "running",
      startedAt,
      agents: [
        { id: "root-agent", role: "root", name: "root-agent", status: "running", startedAt },
        { id: agentId, role: "web", name: "web-01", taskId: task.id, parentId: "root-agent", status: "running", startedAt },
      ],
      tasks: [{ ...task, status: "running", inputHash: taskInputHash(task), attempt: 1, agentId }],
      findings: [],
      evidence: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      events: [],
    })
    const forged = {
      ...emptyResult(),
      evidence: [{
        id: "E-REPLAY",
        kind: "response" as const,
        uri: `artifact://${engagement.id}/E-REPLAY.json`,
        sha256: "d".repeat(64),
        capturedAt: startedAt,
        source: "root-agent",
      }],
    }
    firstStore.append({
      engagementId: engagement.id,
      type: "task.completed",
      agentId,
      taskId: task.id,
      payload: { summary: forged.summary, result: forged },
    })
    firstStore.close()

    let workerCalls = 0
    const runtime: AgentRuntime = {
      async runTask() {
        workerCalls += 1
        return emptyResult()
      },
      async cancel() {},
      async close() {},
    }
    const recoveredStore = new SQLiteEngagementStore(databasePath, engagement.id)
    const controller = new CyrionController(
      engagement,
      runtime,
      singleTaskPlanner(task),
      join(projectRoot, "agents"),
      { store: recoveredStore },
    )
    const result = await controller.run()

    expect(result.status).toBe("completed")
    expect(workerCalls).toBe(1)
    expect(result.tasks[0]?.attempt).toBe(2)
    expect(result.events.some((event) => event.type === "task.result.rejected")).toBe(true)
    expect(result.events.some((event) =>
      event.type === "task.reconciled"
      && (event.payload as { action?: string }).action === "requeue"
    )).toBe(true)
    controller.close()
  })
})

function assessmentTask(): TaskSpec {
  return {
    id: "T-BOUNDARY",
    key: "boundary:demo.lab.test",
    role: "web",
    objective: "Exercise the untrusted output boundary.",
    target: "demo.lab.test",
    capabilities: ["fixture.read"],
    dependencies: [],
    depth: 1,
    expectedOutput: "assessment",
  }
}

function singleTaskPlanner(task: TaskSpec): RootPlanner {
  return {
    async decide(snapshot: EngagementSnapshot) {
      if (!snapshot.tasks.length) {
        return {
          version: CONTRACT_VERSION,
          action: { kind: "delegate" as const, rationale: "Exercise one bounded worker.", tasks: [task] },
        }
      }
      return { version: CONTRACT_VERSION, action: { kind: "finish" as const, rationale: "Done." } }
    },
    async close() {},
  }
}

function emptyResult(): WorkerResult {
  return { summary: "Empty fixture result.", observations: [], findings: [], evidence: [] }
}
