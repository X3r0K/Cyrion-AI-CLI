import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import {
  CONTRACT_VERSION,
  assertManifest,
  type AgentRuntime,
  type EngagementManifest,
  type EngagementSnapshot,
  type EvidenceCapture,
  type RootPlanner,
  type TaskSpec,
  type WorkerResult,
} from "@cyrion/contracts"
import { CyrionController, SQLiteEngagementStore, taskInputHash } from "@cyrion/controller"
import { LocalEvidenceStore, MemoryEvidenceStore } from "@cyrion/evidence"

const projectRoot = join(import.meta.dir, "..")

describe("controller evidence admission", () => {
  test("rejects a well-formed reference that is absent from the configured store", async () => {
    const evidenceStore = new MemoryEvidenceStore()
    const runtime: AgentRuntime = runtimeFrom(async (context) => ({
      ...emptyResult(),
      evidence: [{
        id: "E-MISSING",
        kind: "response",
        uri: `artifact://${context.engagementId}/E-MISSING.json`,
        sha256: "a".repeat(64),
        capturedAt: new Date().toISOString(),
        source: context.agentId,
        contentType: "application/json",
        sizeBytes: 2,
      }],
    }))
    const result = await runSingle(runtime, evidenceStore)

    expect(result.status).toBe("failed")
    expect(result.evidence).toHaveLength(0)
    expect(rejectionReason(result)).toContain("missing from the configured store")
    expect(result.events.some((event) => event.type === "task.completed")).toBe(false)
  })

  test("rejects worker metadata that differs from the store's canonical reference", async () => {
    const evidenceStore = new MemoryEvidenceStore()
    const runtime: AgentRuntime = runtimeFrom(async (context) => {
      const canonical = await context.evidenceStore.capture({
        engagementId: context.engagementId,
        id: "E-FORGED-METADATA",
        kind: "response",
        content: "{}",
        contentType: "application/json",
        source: context.agentId,
      })
      return { ...emptyResult(), evidence: [{ ...canonical, contentType: "text/plain" }] }
    })
    const result = await runSingle(runtime, evidenceStore)

    expect(result.status).toBe("failed")
    expect(result.evidence).toHaveLength(0)
    expect(rejectionReason(result)).toContain("metadata does not match the store")
  })

  test("rejects an artifact changed after capture and before admission", async () => {
    const root = await mkdtemp("/tmp/cyrion-admission-tamper-")
    const evidenceStore = new LocalEvidenceStore(root)
    const runtime: AgentRuntime = runtimeFrom(async (context) => {
      const reference = await context.evidenceStore.capture({
        engagementId: context.engagementId,
        id: "E-TAMPERED",
        kind: "response",
        content: "trusted fixture content",
        contentType: "application/json",
        source: context.agentId,
      })
      await Bun.write(join(root, context.engagementId, "E-TAMPERED.json"), "changed after capture")
      return { ...emptyResult(), evidence: [reference] }
    })
    const result = await runSingle(runtime, evidenceStore)

    expect(result.status).toBe("failed")
    expect(result.evidence).toHaveLength(0)
    expect(rejectionReason(result)).toContain("failed integrity verification")
  })

  test("rechecks durable completion evidence during recovery and requeues missing artifacts", async () => {
    const engagement = await fixtureManifest()
    const task = assessmentTask()
    const agentId = `web-${task.id.toLowerCase()}`
    const startedAt = new Date().toISOString()
    const directory = await mkdtemp("/tmp/cyrion-evidence-replay-")
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
    const replayed = {
      ...emptyResult(),
      evidence: [{
        id: "E-MISSING-REPLAY",
        kind: "response" as const,
        uri: `artifact://${engagement.id}/E-MISSING-REPLAY.json`,
        sha256: "b".repeat(64),
        capturedAt: startedAt,
        source: agentId,
        contentType: "application/json",
        sizeBytes: 2,
      }],
    }
    firstStore.append({
      engagementId: engagement.id,
      type: "task.completed",
      agentId,
      taskId: task.id,
      payload: { summary: replayed.summary, result: replayed },
    })
    firstStore.close()

    let workerCalls = 0
    const runtime: AgentRuntime = runtimeFrom(async () => {
      workerCalls += 1
      return emptyResult()
    })
    const recoveredStore = new SQLiteEngagementStore(databasePath, engagement.id)
    const controller = new CyrionController(
      engagement,
      runtime,
      singleTaskPlanner(task),
      join(projectRoot, "agents"),
      { store: recoveredStore, evidenceStore: new MemoryEvidenceStore() },
    )
    const result = await controller.run()

    expect(result.status).toBe("completed")
    expect(workerCalls).toBe(1)
    expect(result.tasks[0]?.attempt).toBe(2)
    expect(rejectionReason(result)).toContain("missing from the configured store")
    expect(result.events.some((event) =>
      event.type === "task.reconciled"
      && (event.payload as { action?: string }).action === "requeue"
    )).toBe(true)
    controller.close()
  })

  test("returns canonical metadata when identical content is captured again", async () => {
    const evidenceStore = new MemoryEvidenceStore()
    const input: EvidenceCapture = {
      engagementId: "ENG-CANONICAL",
      id: "E-CANONICAL",
      kind: "response",
      content: "same content",
      contentType: "text/plain",
      source: "web-t-canonical",
    }
    const first = await evidenceStore.capture(input)
    await Bun.sleep(2)
    const second = await evidenceStore.capture(input)

    expect(second).toEqual(first)
    expect(await evidenceStore.metadata(second)).toEqual(first)
  })
})

async function fixtureManifest(): Promise<EngagementManifest> {
  const value: unknown = await Bun.file(join(projectRoot, "fixtures/demo/engagement.json")).json()
  assertManifest(value)
  return value
}

function assessmentTask(): TaskSpec {
  return {
    id: "T-EVIDENCE",
    key: "evidence:demo.lab.test",
    role: "web",
    objective: "Exercise evidence admission using a bounded fixture.",
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
          action: { kind: "delegate" as const, rationale: "Exercise evidence admission.", tasks: [task] },
        }
      }
      return { version: CONTRACT_VERSION, action: { kind: "finish" as const, rationale: "Done." } }
    },
    async close() {},
  }
}

function runtimeFrom(
  run: (context: Parameters<AgentRuntime["runTask"]>[1]) => Promise<WorkerResult>,
): AgentRuntime {
  return {
    async runTask(_task, context) {
      return run(context)
    },
    async cancel() {},
    async close() {},
  }
}

async function runSingle(runtime: AgentRuntime, evidenceStore: MemoryEvidenceStore | LocalEvidenceStore) {
  const engagement = await fixtureManifest()
  const controller = new CyrionController(
    engagement,
    runtime,
    singleTaskPlanner(assessmentTask()),
    join(projectRoot, "agents"),
    { evidenceStore },
  )
  const result = await controller.run()
  controller.close()
  return result
}

function emptyResult(): WorkerResult {
  return { summary: "Evidence admission fixture.", observations: [], findings: [], evidence: [] }
}

function rejectionReason(snapshot: EngagementSnapshot): string {
  const rejected = snapshot.events.find((event) => event.type === "task.result.rejected")
  return (rejected?.payload as { reason?: string } | undefined)?.reason ?? ""
}
