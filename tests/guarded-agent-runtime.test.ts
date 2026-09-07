import { describe, expect, test } from "bun:test"
import type {
  AgentRuntime,
  RuntimeContext,
  TaskSpec,
  WorkerResult,
} from "@cyrion/contracts"
import {
  GuardedAgentRuntime,
  type WorkerResultReviewer,
} from "@cyrion/runtime-opencode"

describe("guarded OpenCode worker review", () => {
  test("changes only the public summary and adds measured provider usage", async () => {
    const canonical = canonicalResult()
    const runtime = runtimeFor(canonical)
    const reviewer = reviewerFor("accept", "Provider-reviewed bounded inventory.")
    const guarded = new GuardedAgentRuntime(runtime, reviewer)

    const result = await guarded.runTask(task(), context())

    expect(result.summary).toBe("Canonical inventory captured.\n[PROVIDER REVIEW] Provider-reviewed bounded inventory.")
    expect(result.observations).toEqual(canonical.observations)
    expect(result.findings).toEqual(canonical.findings)
    expect(result.evidence).toEqual(canonical.evidence)
    expect(result.report).toBe(canonical.report)
    expect(result.usage).toEqual({ inputTokens: 13, outputTokens: 6, costUsd: 0.002 })
    await guarded.cancel("recon-t-001")
    await guarded.close()
    expect(runtime.cancelled).toBe(true)
    expect(reviewer.cancelled).toBe(true)
    expect(runtime.closed).toBe(true)
    expect(reviewer.closed).toBe(true)
  })

  test("preserves the canonical result when the provider flags it", async () => {
    const canonical = canonicalResult()
    const guarded = new GuardedAgentRuntime(
      runtimeFor(canonical),
      reviewerFor("flag", "The result needs operator attention."),
    )
    const result = await guarded.runTask(task(), context())
    expect(result.summary).toBe("Canonical inventory captured.\n[PROVIDER FLAG] The result needs operator attention.")
    expect(result.evidence).toEqual(canonical.evidence)
  })
})

function runtimeFor(result: WorkerResult): AgentRuntime & { cancelled: boolean; closed: boolean } {
  return {
    cancelled: false,
    closed: false,
    async runTask() { return structuredClone(result) },
    async cancel() { this.cancelled = true },
    async close() { this.closed = true },
  }
}

function reviewerFor(
  verdict: "accept" | "flag",
  summary: string,
): WorkerResultReviewer & { cancelled: boolean; closed: boolean } {
  return {
    cancelled: false,
    closed: false,
    async reviewTask() {
      return {
        review: { verdict, summary },
        usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.001 },
      }
    },
    async cancel() { this.cancelled = true },
    async close() { this.closed = true },
  }
}

function canonicalResult(): WorkerResult {
  return {
    summary: "Canonical inventory captured.",
    observations: [{
      id: "O-001",
      asset: "demo.lab.test",
      summary: "One approved target.",
      source: "recon-t-001",
      evidenceIds: ["E-001"],
    }],
    findings: [],
    evidence: [{
      id: "E-001",
      kind: "fixture",
      uri: "artifact://ENG-0042/E-001.json",
      sha256: "a".repeat(64),
      capturedAt: "2026-09-07T00:00:00.000Z",
      source: "recon-t-001",
      contentType: "application/json",
      sizeBytes: 10,
    }],
    report: "Canonical report body.",
    usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.001 },
  }
}

function task(): TaskSpec {
  return {
    id: "T-001",
    key: "recon:demo.lab.test",
    role: "recon",
    objective: "Inventory the approved fixture.",
    target: "demo.lab.test",
    capabilities: ["fixture.read"],
    dependencies: [],
    depth: 1,
    expectedOutput: "inventory",
  }
}

function context(): RuntimeContext {
  return {
    engagementId: "ENG-0042",
    agentId: "recon-t-001",
    role: "recon",
    systemPrompt: "Review only the supplied bounded result.",
    scope: { targets: ["demo.lab.test"], excluded: [], capabilities: ["fixture.read"] },
    remainingBudget: {
      maxConcurrentAgents: 1,
      maxAgents: 2,
      maxDepth: 1,
      maxTasks: 2,
      maxDurationMs: 60_000,
      maxTokens: 10_000,
      maxCostUsd: 1,
    },
    tools: { async execute() { throw new Error("not used") } },
    evidenceStore: {
      async capture() { throw new Error("not used") },
      async metadata() { return undefined },
      async read() { return new Uint8Array() },
      async verify() { return false },
    },
  }
}
