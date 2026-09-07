import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { CONTRACT_VERSION, assertManifest, type EngagementManifest, type EngagementSnapshot } from "@cyrion/contracts"
import { CyrionController, FixtureRootPlanner, ScopedToolGateway } from "@cyrion/controller"
import { MemoryEvidenceStore } from "@cyrion/evidence"
import { FixtureAgentRuntime, FixtureToolAdapter } from "@cyrion/runtime-opencode"
import {
  formatEvidenceInspector,
  formatEngagement,
  formatFindingDetail,
  formatMission,
  formatWorkerInspector,
  sanitizeTerminalText,
} from "../apps/cli/src/format"
import {
  activateView,
  createTerminalUiState,
  inspectSelection,
  moveSelection,
} from "../apps/cli/src/navigation"

const projectRoot = join(import.meta.dir, "..")

describe("product terminal state", () => {
  test("shows the configured runtime and provider without exposing credentials", async () => {
    const snapshot = await completedSnapshot()
    const output = plainText(formatEngagement(snapshot, {
      mode: "fixture",
      provider: "openai/gpt-test (CONFIGURED)",
    }))
    expect(output).toContain("FIXTURE")
    expect(output).toContain("openai/gpt-test (CONFIGURED)")
    expect(output).not.toContain("API_KEY")
    const mission = plainText(formatMission(snapshot, {
      mode: "fixture",
      provider: "openai/gpt-test (CONFIGURED)",
    }))
    expect(mission).toContain("FIXTURE / LLM openai/gpt-test (CONFIGURED)")
  })

  test("navigates workers, findings, and linked evidence without relying on color", async () => {
    const snapshot = await completedSnapshot()
    let state = createTerminalUiState(snapshot)

    state = activateView(state, "SWARM", snapshot)
    expect(state.selectedTaskId).toBe("T-001")
    for (const task of snapshot.tasks) {
      expect(state.selectedTaskId).toBe(task.id)
      const agent = snapshot.agents.find((item) => item.id === task.agentId)
      expect(plainText(formatWorkerInspector(snapshot, state.selectedTaskId))).toContain(agent?.name ?? task.role)
      state = moveSelection(state, snapshot, 1)
    }

    state = activateView(state, "FINDINGS", snapshot)
    expect(state.selectedFindingId).toBe("F-001")
    expect(plainText(formatFindingDetail(snapshot, state.selectedFindingId))).toContain("CONFIRMED")

    state = inspectSelection(state, snapshot)
    expect(state.activeView).toBe("EVIDENCE")
    expect(state.selectedEvidenceId).toBe("E-012")
    state = moveSelection(state, snapshot, 1)
    expect(state.selectedEvidenceId).toBe("E-013")
  })

  test("shows integrity state and strips terminal controls from artifact previews", async () => {
    const snapshot = await completedSnapshot()
    const malicious = "safe\u001b]52;c;clipboard\u0007\u001b[31mred"
    const safe = sanitizeTerminalText(malicious)
    expect(safe).not.toContain("\u001b")
    expect(safe).not.toContain("\u0007")

    const inspector = plainText(formatEvidenceInspector(snapshot, "E-012", safe, "verified"))
    expect(inspector).toContain("VERIFIED")
    expect(inspector).toContain("safe]52;c;clipboard[31mred")
  })

  test("records a visible Root reply for operator chat", async () => {
    const snapshot = await completedSnapshot(true)
    const replies = snapshot.events.filter((event) => event.type === "root.message")
    expect(replies).toHaveLength(1)
    expect((replies[0]?.payload as { content: string }).content).toContain("Mission complete")
    expect(plainText(formatMission(snapshot))).toContain("ROOT CHAT")
  })

  test("pauses and resumes dispatch through explicit controller events", async () => {
    const value: unknown = await Bun.file(join(projectRoot, "fixtures/demo/engagement.json")).json()
    assertManifest(value)
    const evidenceStore = new MemoryEvidenceStore()
    const adapter = new FixtureToolAdapter()
    const controller = new CyrionController(
      value,
      new FixtureAgentRuntime(),
      new FixtureRootPlanner(),
      join(projectRoot, "agents"),
      {
        toolGateway: new ScopedToolGateway(value, {
          "fixture.read": adapter,
          "fixture.compare": adapter,
        }),
        heartbeatIntervalMs: 50,
        evidenceStore,
      },
    )

    const run = controller.run()
    controller.pause()
    expect(controller.snapshot.status).toBe("paused")
    controller.resume()
    expect(controller.snapshot.status).toBe("running")
    const snapshot = await run
    expect(snapshot.status).toBe("completed")
    expect(snapshot.events.some((event) => event.type === "engagement.paused")).toBe(true)
    expect(snapshot.events.some((event) => event.type === "engagement.resumed")).toBe(true)
    controller.close()
  })

  test("renders a pending supervised delegation with non-color controls", async () => {
    const snapshot = await completedSnapshot()
    snapshot.status = "running"
    snapshot.pendingApproval = {
      id: "APPROVAL-UI",
      requestedAt: new Date().toISOString(),
      status: "pending",
      decision: {
        version: CONTRACT_VERSION,
        action: {
          kind: "delegate",
          rationale: "Review the bounded fixture task.",
          tasks: [{
            id: "T-APPROVAL",
            key: "approval:demo.lab.test",
            role: "web",
            objective: "Review one fixture.",
            target: "demo.lab.test",
            capabilities: ["fixture.read"],
            dependencies: [],
            depth: 1,
            expectedOutput: "assessment",
          }],
        },
      },
    }

    const mission = plainText(formatMission(snapshot))
    expect(mission).toContain("SUPERVISOR APPROVAL")
    expect(mission).toContain("[a] APPROVE")
    expect(mission).toContain("[x] DENY")
    expect(mission).toContain("fixture.read")
  })
})

async function completedSnapshot(withChat = false): Promise<EngagementSnapshot> {
  const value: unknown = await Bun.file(join(projectRoot, "fixtures/demo/engagement.json")).json()
  assertManifest(value)
  const manifest: EngagementManifest = value
  const evidenceStore = new MemoryEvidenceStore()
  const adapter = new FixtureToolAdapter()
  const controller = new CyrionController(
    manifest,
    new FixtureAgentRuntime(),
    new FixtureRootPlanner(),
    join(projectRoot, "agents"),
    {
      toolGateway: new ScopedToolGateway(manifest, {
        "fixture.read": adapter,
        "fixture.compare": adapter,
      }),
      heartbeatIntervalMs: 50,
      evidenceStore,
    },
  )
  await controller.run()
  if (withChat) controller.operatorMessage("Summarize the mission")
  const snapshot = controller.snapshot
  controller.close()
  return snapshot
}

function plainText(value: { chunks: Array<{ text: string }> }): string {
  return value.chunks.map((chunk) => chunk.text).join("")
}
