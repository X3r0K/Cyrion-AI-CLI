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
  formatFindings,
  formatLaunch,
  formatMission,
  formatRootDispatch,
  formatSwarm,
  formatTaskBoard,
  formatSettings,
  formatSettingsInspector,
  formatWorkerInspector,
  sanitizeTerminalText,
} from "../apps/cli/src/format"
import {
  activateView,
  createTerminalUiState,
  inspectSelection,
  isTextInputActive,
  moveSelection,
  viewNavigationDelta,
} from "../apps/cli/src/navigation"
import { createSettingsEditor } from "../apps/cli/src/settings-ui"
import { createLaunchState } from "../apps/cli/src/launch-ui"
import { defaultScanInput } from "../apps/cli/src/scan-config"

const projectRoot = join(import.meta.dir, "..")

describe("product terminal state", () => {
  test("never treats letter l as navigation and prioritizes focused text entry", () => {
    expect(viewNavigationDelta("l", false)).toBeUndefined()
    expect(viewNavigationDelta("l", true)).toBeUndefined()
    expect(viewNavigationDelta("]", true)).toBe(1)
    expect(isTextInputActive("dashboard", true)).toBe(true)
    expect(isTextInputActive("chat", false)).toBe(true)
    // A launch field owns the footer exactly as a settings field does, so its
    // value is applied rather than sent to Root chat.
    expect(isTextInputActive("launch", false)).toBe(true)
    expect(isTextInputActive("dashboard", false)).toBe(false)
  })

  test("offers a new assessment from Mission and says what starting one costs", async () => {
    const snapshot = await completedSnapshot()
    expect(plainText(formatMission(snapshot, undefined, 70))).toContain("[n] NEW ASSESSMENT")
    const form = plainText(formatLaunch(
      createLaunchState({ ...defaultScanInput, target: "https://example.com" }),
      70,
      "Starting this assessment cancels the engagement running here.",
    ))
    expect(form).toContain("NEW ASSESSMENT")
    expect(form).toContain("cancels the engagement running here")
    // Authorization is still a field the operator fills in, not one inherited
    // from the engagement they started this from.
    expect(form).toContain("Authorized by")
    expect(form).toContain("not set")
    expect(form).toContain("[s] start")
  })

  test("shows the configured runtime and provider without exposing credentials", async () => {
    const snapshot = await completedSnapshot()
    const output = plainText(formatEngagement(snapshot, {
      mode: "hybrid",
      planner: "opencode",
      workers: "opencode",
      provider: "openai/gpt-test (ACTIVE)",
    }, 44))
    expect(output).toContain("HYBRID")
    expect(output).toContain("Root          OPENCODE")
    expect(output).toContain("Workers       OPENCODE")
    expect(output).toContain("openai/gpt-test (ACTIVE)")
    expect(output).not.toContain("API_KEY")
    const mission = plainText(formatMission(snapshot, {
      mode: "hybrid",
      planner: "opencode",
      workers: "opencode",
      provider: "openai/gpt-test (ACTIVE)",
    }))
    expect(mission).toContain("HYBRID / ROOT OPENCODE / WORKERS OPENCODE / LLM openai/gpt-test (ACTIVE)")
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

  test("renders the task board as a ruled table with per-task elapsed time", async () => {
    const snapshot = await completedSnapshot()
    const board = plainText(formatTaskBoard(snapshot, "T-002", 78))
    expect(board).toContain("LIVE TASK BOARD")
    expect(board).toContain("AGENT")
    expect(board).toContain("ELAPSED")
    expect(board).toContain("┌")
    expect(board).toContain("│")
    expect(board).toMatch(/web-01\s+│/)
    expect(board).toMatch(/\d\d:\d\d/)
    expect(board).toContain("Isolated worker")
  })

  test("renders Root dispatch counters and the last handoff", async () => {
    const snapshot = await completedSnapshot()
    const dispatch = plainText(formatRootDispatch(snapshot, "T-002", 34))
    expect(dispatch).toContain("ROOT DISPATCH")
    expect(dispatch).toContain("Root owns the plan")
    expect(dispatch).toContain("LAST HANDOFF")
    expect(dispatch).toContain("Completed")
    expect(dispatch).toContain("WORKER")
  })

  test("renders findings as cards and the inspector as an evidence-linked record", async () => {
    const snapshot = await completedSnapshot()
    const list = plainText(formatFindings(snapshot, "F-001", 60))
    expect(list).toContain("F-001")
    expect(list).toContain("HIGH")
    expect(list).toContain("CONFIRMED")
    expect(list).toContain("┌")

    const detail = plainText(formatFindingDetail(snapshot, "F-001", 34, { mode: "fixture" }))
    expect(detail).toContain("Environment")
    expect(detail).toContain("LAB / FIXTURE")
    expect(detail).toContain("REPRODUCTION PASS")
    expect(detail).toContain("[e] ")
    expect(detail).toContain("[r] ")
  })

  test("renders the delegation tree with roles, activity and counts", async () => {
    const snapshot = await completedSnapshot()
    const swarm = plainText(formatSwarm(snapshot, "T-004", 30))
    expect(swarm).toMatch(/root-agent\s+COMPLETE/)
    // Nodes are named by the role they carry: what a specialist is *for* is
    // what tells an `idor` branch from an `xss` one at a glance.
    expect(swarm).toContain("recon")
    expect(swarm).toContain("validator")
    expect(swarm).toContain("└─")
    expect(swarm).toMatch(/\d+ active {2}\/ {2}\d+ agents?/)
  })

  test("reports mission activity in plain operator language, never raw payloads", async () => {
    const snapshot = await completedSnapshot()
    const mission = plainText(formatMission(snapshot, undefined, 70))
    expect(mission).toContain("MISSION CONTROL")
    expect(mission).toContain("ACTIVITY FEED")
    expect(mission).toContain("Result accepted")
    expect(mission).not.toContain("TASK / COMPLETED")
  })

  test("renders editable general settings without credential material", () => {
    const state = createSettingsEditor({
      providerID: "opencode",
      modelID: "zen-test",
      defaultPlanner: "opencode",
      defaultWorkers: "opencode",
      defaultMode: "autonomous",
      defaultFixture: "known-positive",
      colorMode: "auto",
      llmKind: "openai-compatible",
      llmBaseUrl: "",
      llmModel: "",
      llmApiKeyEnv: "",
    })
    const display = {
      environmentPath: "/workspace/.env",
      discovery: "ready" as const,
      providers: [{
        id: "opencode",
        name: "OpenCode Zen",
        source: "api" as const,
        modelCount: 1,
        models: [{ id: "zen-test", name: "Zen Test" }],
      }],
    }
    const settings = plainText(formatSettings(state, display))
    const inspector = plainText(formatSettingsInspector(state, display))
    expect(settings).toContain("GENERAL SETTINGS")
    expect(settings).toContain("OpenCode Zen / opencode")
    expect(settings).toContain("Root planner")
    expect(settings).toContain("Worker review")
    expect(settings).toContain("KNOWN POSITIVE")
    expect(inspector).toContain("CONNECTED")
    expect(collapse(inspector)).toContain("Credentials are managed by OpenCode and never rendered here.")
    expect(`${settings}${inspector}`).not.toContain("API_KEY")
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

function collapse(value: string): string {
  return value.replace(/\s+/g, " ")
}
