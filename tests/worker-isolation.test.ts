import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { ToolExecutionRequest } from "@cyrion/contracts"
import { IsolatedFixtureToolAdapter } from "@cyrion/runtime-opencode"

const workerPath = join(import.meta.dir, "../workers/fixture-worker.ts")

describe("isolated fixture worker", () => {
  test("executes in a scrubbed environment and returns no credential values", async () => {
    const adapter = new IsolatedFixtureToolAdapter(workerPath, ["demo.lab.test"])
    const result = await adapter.execute(request(), new AbortController().signal) as {
      accepted: boolean
      environmentKeys: string[]
    }

    expect(result.accepted).toBe(true)
    expect(result.environmentKeys).toContain("CYRION_WORKER_KIND")
    expect(result.environmentKeys.some((key) => /SECRET|TOKEN|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY/.test(key))).toBe(false)
  })

  test("rejects a target independently of the controller gateway", async () => {
    const adapter = new IsolatedFixtureToolAdapter(workerPath, ["demo.lab.test"])
    await expect(adapter.execute(request({ target: "outside.example" }), new AbortController().signal))
      .rejects.toThrow("target rejected")
  })

  test("terminates output that exceeds the task budget", async () => {
    const adapter = new IsolatedFixtureToolAdapter(workerPath, ["demo.lab.test"])
    await expect(adapter.execute(request({ input: { paddingBytes: 8_192 }, maxOutputBytes: 512 }), new AbortController().signal))
      .rejects.toThrow("output budget exceeded")
  })

  test("terminates the child process when the tool signal is aborted", async () => {
    const adapter = new IsolatedFixtureToolAdapter(workerPath, ["demo.lab.test"])
    const controller = new AbortController()
    const operation = adapter.execute(request({ input: { delayMs: 2_000 } }), controller.signal)
    setTimeout(() => controller.abort(new Error("test cancellation")), 25)
    await expect(operation).rejects.toThrow("test cancellation")
  })
})

function request(overrides: Partial<ToolExecutionRequest> = {}): ToolExecutionRequest {
  return {
    engagementId: "ENG-TEST",
    taskId: "T-TEST",
    agentId: "web-test",
    capability: "fixture.read",
    target: "demo.lab.test",
    timeoutMs: 1_000,
    maxOutputBytes: 4_096,
    input: { fixture: "known-positive" },
    ...overrides,
  }
}
