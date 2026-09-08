import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { assertManifest, type EngagementManifest, type EngagementSnapshot } from "@cyrion/contracts"
import { CyrionController, ScopedToolGateway } from "@cyrion/controller"
import { MemoryEvidenceStore } from "@cyrion/evidence"
import { LlmRootPlanner, OpenAiCompatibleClient, type ModelEndpoint } from "@cyrion/llm"
import { FixtureAgentRuntime, FixtureToolAdapter } from "@cyrion/runtime-opencode"

const projectRoot = join(import.meta.dir, "..")

interface Fake {
  endpoint: ModelEndpoint
  stop(): void
}

/** Serves whatever a scripted planner would emit, valid or not. */
function serveDecisions(decisions: unknown[]): Fake {
  let index = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.json().catch(() => undefined)
      const decision = decisions[Math.min(index, decisions.length - 1)]
      index += 1
      return Response.json({
        choices: [{ message: { content: JSON.stringify(decision) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      })
    },
  })
  return {
    endpoint: { id: "local", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${server.port}` },
    stop: () => server.stop(true),
  }
}

async function runWithPlanner(decisions: unknown[]): Promise<EngagementSnapshot> {
  const value: unknown = await Bun.file(join(projectRoot, "fixtures/demo/engagement.json")).json()
  assertManifest(value)
  const manifest: EngagementManifest = value
  const fake = serveDecisions(decisions)
  const adapter = new FixtureToolAdapter()
  const controller = new CyrionController(
    manifest,
    new FixtureAgentRuntime(),
    new LlmRootPlanner(new OpenAiCompatibleClient({ endpoint: fake.endpoint, model: "stub" }), "root"),
    join(projectRoot, "agents"),
    {
      toolGateway: new ScopedToolGateway(manifest, { "fixture.read": adapter, "fixture.compare": adapter }),
      heartbeatIntervalMs: 50,
      evidenceStore: new MemoryEvidenceStore(),
    },
  )
  try {
    return await controller.run()
  } finally {
    controller.close()
    fake.stop()
  }
}

const task = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "T-001",
  key: "recon:demo.lab.test",
  role: "recon",
  objective: "Inventory the approved fixture assets.",
  target: "demo.lab.test",
  capabilities: ["fixture.read"],
  dependencies: [],
  depth: 1,
  expectedOutput: "inventory",
  ...overrides,
})

const delegate = (overrides?: Record<string, unknown>): unknown => ({
  version: "cyrion.community/v1",
  action: { kind: "delegate", rationale: "next step", tasks: [task(overrides)] },
})

const finish = { version: "cyrion.community/v1", action: { kind: "finish", rationale: "done" } }

describe("model-authored Root plans stay inside the controller's policy", () => {
  test("dispatches a valid authored plan and completes", async () => {
    const snapshot = await runWithPlanner([delegate(), finish])
    expect(snapshot.status).toBe("completed")
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.tasks[0]?.status).toBe("completed")
    expect(snapshot.usage.inputTokens).toBeGreaterThan(0)
  })

  test("rejects a target the manifest never approved", async () => {
    const snapshot = await runWithPlanner([delegate({ target: "customer.example.com" })])
    expect(snapshot.status).toBe("failed")
    expect(snapshot.tasks).toHaveLength(0)
    const rejection = snapshot.events.findLast((event) => event.type === "root.decision.rejected")
    expect(String((rejection?.payload as { rejection?: string }).rejection)).toContain("Out-of-scope target")
  })

  test("rejects a capability the manifest never granted", async () => {
    const snapshot = await runWithPlanner([delegate({ capabilities: ["shell.exec"] })])
    expect(snapshot.status).toBe("failed")
    const rejection = snapshot.events.findLast((event) => event.type === "root.decision.rejected")
    expect(String((rejection?.payload as { rejection?: string }).rejection)).toContain("Capability not granted")
  })

  test("rejects a role and output pairing the contract does not allow", async () => {
    const snapshot = await runWithPlanner([delegate({ role: "validator", expectedOutput: "inventory" })])
    expect(snapshot.status).toBe("failed")
    expect(snapshot.tasks).toHaveLength(0)
  })

  test("rejects a decision that is not a Root decision at all", async () => {
    const snapshot = await runWithPlanner([{ ok: true }])
    expect(snapshot.status).toBe("failed")
    const rejection = snapshot.events.findLast((event) => event.type === "root.decision.rejected")
    expect(String((rejection?.payload as { rejection?: string }).rejection)).toContain("unexpected field")
  })
})
