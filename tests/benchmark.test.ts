import { describe, expect, test } from "bun:test"
import type { EngagementSnapshot, Finding } from "@cyrion/contracts"
import {
  BENCHMARK_VERSION,
  renderBenchmarkMarkdown,
  scoreRun,
  summarize,
  type LabGroundTruth,
} from "@cyrion/benchmark"
import { AssessmentRootPlanner, CapabilityWorkerRuntime } from "@cyrion/assessment"
import { CapabilityRegistry } from "@cyrion/capabilities"
import { CyrionController, ScopedToolGateway } from "@cyrion/controller"
import { MemoryEvidenceStore } from "@cyrion/evidence"
import { LocalToolRunner } from "@cyrion/sandbox"
import { loadSkills } from "@cyrion/skills"
import { join } from "node:path"
import { PARTIAL_LAB_ANSWERS, startCleanLab, startPartialLab } from "../fixtures/labs/servers"

const origin = "http://127.0.0.1:9000"

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-1",
    title: "Missing browser protection headers",
    asset: `${origin}/`,
    severity: "low",
    status: "confirmed",
    summary: "The response omits content-security-policy.",
    discoveredBy: "web-1",
    validatedBy: "validator-1",
    evidenceIds: ["E-1"],
    skillId: "web-security-headers",
    ...overrides,
  }
}

function snapshot(findings: Finding[], overrides: Partial<EngagementSnapshot> = {}): EngagementSnapshot {
  return {
    manifest: {
      id: "ENG-BENCH",
      name: "b",
      objective: "o",
      profile: "web-api",
      mode: "autonomous",
      scope: { targets: [`${origin}/`], excluded: [], capabilities: ["http.probe"] },
      budgets: {
        maxConcurrentAgents: 1, maxAgents: 8, maxDepth: 2, maxTasks: 8,
        maxDurationMs: 60_000, maxTokens: 100, maxCostUsd: 1,
      },
    },
    status: "completed",
    startedAt: "2026-09-08T00:00:00.000Z",
    finishedAt: "2026-09-08T00:00:30.000Z",
    agents: [],
    tasks: [],
    findings,
    evidence: [],
    usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.02 },
    events: [],
    ...overrides,
  }
}

const truth: LabGroundTruth = {
  id: "imperfect",
  name: "n",
  purpose: "p",
  targets: [`${origin}/`],
  expected: [{ skillId: "web-security-headers", asset: `${origin}/`, severity: "low" }],
  confirmable: true,
}

describe("scoring a benchmark run", () => {
  test("counts only confirmed findings as claims", () => {
    // A candidate nobody validated is not an assertion about the target, so it
    // must not earn a true positive — nor be counted against precision.
    const candidate = scoreRun(snapshot([finding({ status: "candidate" })]), truth, { wallClockMs: 100 })
    expect(candidate.truePositives).toBe(0)
    expect(candidate.falsePositives).toBe(0)
    expect(candidate.falseNegatives).toBe(1)
    expect(candidate.recall).toBe(0)

    const confirmed = scoreRun(snapshot([finding()]), truth, { wallClockMs: 100 })
    expect(confirmed).toEqual(expect.objectContaining({ truePositives: 1, falsePositives: 0, precision: 1, recall: 1 }))
  })

  test("treats a claim the lab does not contain as a false positive", () => {
    const wrong = scoreRun(
      snapshot([finding({ id: "F-2", asset: `${origin}/hardened` })]),
      truth,
      { wallClockMs: 100 },
    )
    expect(wrong.falsePositives).toBe(1)
    expect(wrong.falseNegatives).toBe(1)
    expect(wrong.precision).toBe(0)
  })

  test("leaves precision undefined rather than zero when nothing was claimed", () => {
    const quiet = scoreRun(snapshot([]), { ...truth, expected: [] }, { wallClockMs: 100 })
    expect(quiet.precision).toBeUndefined()
    expect(quiet.recall).toBeUndefined()
  })

  test("reports inconclusive on its own line, not as a right or wrong answer", () => {
    const unsure = scoreRun(snapshot([finding({ status: "inconclusive" })]), truth, { wallClockMs: 100 })
    expect(unsure.inconclusive).toBe(1)
    expect(unsure.truePositives).toBe(0)
    expect(unsure.falsePositives).toBe(0)
    expect(unsure.inconclusiveRate).toBe(1)
  })

  test("catches a run that confirmed against a lab which cannot support one", () => {
    const guessed = scoreRun(snapshot([finding()]), { ...truth, confirmable: false }, { wallClockMs: 100 })
    expect(guessed.overconfident).toBe(1)
    const honest = scoreRun(snapshot([finding({ status: "rejected" })]), { ...truth, confirmable: false }, { wallClockMs: 100 })
    expect(honest.overconfident).toBe(0)
    expect(honest.rejected).toBe(1)
  })

  test("separates reproduction from confirmation", () => {
    const observed = scoreRun(snapshot([finding()]), truth, { wallClockMs: 100 })
    expect(observed.reproduced).toBe(0)
    expect(observed.reproductionRate).toBe(0)

    const replayed = scoreRun(
      snapshot([finding({
        reproduction: { verdict: "reproduced", bundleId: "E-2", steps: 1, runner: "local", at: "2026-09-08T00:00:10.000Z" },
      })]),
      truth,
      { wallClockMs: 100 },
    )
    expect(replayed.reproductionRate).toBe(1)
  })

  test("scores per class, so one weak methodology cannot hide behind a strong one", () => {
    const both: LabGroundTruth = {
      ...truth,
      expected: [
        { skillId: "web-security-headers", asset: `${origin}/`, severity: "low" },
        { skillId: "api-object-boundary", asset: `${origin}/api/1`, severity: "high" },
      ],
    }
    const metrics = scoreRun(snapshot([finding()]), both, { wallClockMs: 100 })
    const headers = metrics.classes.find((entry) => entry.skillId === "web-security-headers")!
    const boundary = metrics.classes.find((entry) => entry.skillId === "api-object-boundary")!
    expect(headers).toEqual(expect.objectContaining({ truePositives: 1, recall: 1 }))
    expect(boundary).toEqual(expect.objectContaining({ truePositives: 0, falseNegatives: 1, recall: 0 }))
    // The aggregate hides it; the per-class row does not.
    expect(metrics.recall).toBe(0.5)
  })

  test("records the cost of a confirmed finding, and nothing when there are none", () => {
    const found = scoreRun(snapshot([finding()]), truth, { wallClockMs: 4_000 })
    expect(found.msPerConfirmed).toBe(4_000)
    expect(found.usdPerConfirmed).toBe(0.02)
    expect(scoreRun(snapshot([]), truth, { wallClockMs: 4_000 }).msPerConfirmed).toBeUndefined()
  })

  test("counts a refused tool request as a scope violation", () => {
    const violated = scoreRun(
      snapshot([], {
        events: [{
          sequence: 1,
          id: "e1",
          engagementId: "ENG-BENCH",
          type: "tool.request.rejected",
          timestamp: "2026-09-08T00:00:05.000Z",
          payload: {},
        }],
      }),
      truth,
      { wallClockMs: 100 },
    )
    expect(violated.scopeViolations).toBe(1)
  })
})

describe("the benchmark report", () => {
  test("states what produced the numbers and what they do not say", () => {
    const report = summarize(
      [scoreRun(snapshot([finding()]), truth, { wallClockMs: 1_000 })],
      {
        cliVersion: "0.1.0-alpha.2",
        fixtureVersion: "2026.09.1",
        planner: "assessment",
        workers: "capability",
        sandbox: "local",
        deterministic: true,
      },
    )
    expect(report.version).toBe(BENCHMARK_VERSION)
    expect(report.totals).toEqual(expect.objectContaining({ truePositives: 1, precision: 1, scopeViolations: 0 }))

    const markdown = renderBenchmarkMarkdown(report)
    expect(markdown).toContain("| Fixtures | `2026.09.1` |")
    expect(markdown).toContain("the same input gives the same numbers")
    expect(markdown).toContain("What these numbers do not say")
    // A reader has to be told this is a regression measure, not a coverage claim.
    expect(markdown).toContain("not a claim about finding unknown classes of issue")
  })

  test("says plainly when a model makes the numbers a sample", () => {
    const report = summarize([], {
      cliVersion: "0.1.0-alpha.2",
      fixtureVersion: "2026.09.1",
      planner: "llm",
      workers: "llm",
      sandbox: "local",
      deterministic: false,
      models: [{ role: "planner", endpoint: "deepseek", model: "v4-pro" }],
    })
    const markdown = renderBenchmarkMarkdown(report)
    expect(markdown).toContain("these numbers are a sample")
    expect(markdown).toContain("`v4-pro`")
  })
})

describe("the labs", () => {
  test("the clean lab raises nothing to find", async () => {
    const lab = startCleanLab()
    try {
      const response = await fetch(`http://127.0.0.1:${lab.port}/`)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-security-policy")).toBeTruthy()
      const api = await fetch(`http://127.0.0.1:${lab.port}/api/objects/42`)
      expect(api.status).toBe(401)
    } finally {
      lab.stop()
    }
  })

  test("the partial lab answers discovery and then refuses a validator", async () => {
    const lab = startPartialLab()
    try {
      const path = `http://127.0.0.1:${lab.port}/api/flaky/7`
      for (let look = 1; look <= PARTIAL_LAB_ANSWERS; look += 1) {
        expect((await fetch(path)).status).toBe(200)
      }
      // Everything a validator sees afterwards disagrees with discovery.
      expect((await fetch(path)).status).toBe(401)
      expect((await fetch(path)).status).toBe(401)
    } finally {
      lab.stop()
    }
  })
})

describe("the benchmark against the real labs", () => {
  /** One lab, end to end, exactly as `cyrion bench` runs it. */
  async function measure(labId: "imperfect" | "clean" | "partial") {
    const { labs } = await import("../fixtures/labs/catalog")
    const definition = labs[labId]!
    const server = definition.start()
    const truth = definition.truth(`http://127.0.0.1:${server.port}`)
    try {
      const manifest = {
        id: `ENG-BENCH-${labId.toUpperCase()}`,
        name: truth.name,
        objective: truth.purpose,
        profile: "web-api" as const,
        mode: "autonomous" as const,
        scope: { targets: [...truth.targets], excluded: [], capabilities: ["dns.lookup", "http.probe", "poc.run"] },
        budgets: {
          maxConcurrentAgents: 3, maxAgents: 60, maxDepth: 3, maxTasks: 60,
          maxDurationMs: 180_000, maxTokens: 100_000, maxCostUsd: 1,
        },
      }
      const evidence = new MemoryEvidenceStore()
      const skills = await loadSkills(join(import.meta.dir, "..", "skills"))
      const registry = new CapabilityRegistry({
        runner: new LocalToolRunner({ allowedBinaries: ["curl"] }),
        scope: manifest.scope,
        evidence,
        capabilities: manifest.scope.capabilities,
      })
      const controller = new CyrionController(
        manifest,
        new CapabilityWorkerRuntime({ skills }),
        new AssessmentRootPlanner({ skills }),
        join(import.meta.dir, "..", "agents"),
        {
          toolGateway: new ScopedToolGateway(manifest, registry.toolAdapters()),
          heartbeatIntervalMs: 50,
          evidenceStore: evidence,
        },
      )
      const started = performance.now()
      const result = await controller.run()
      controller.close()
      return scoreRun(result, truth, { wallClockMs: Math.round(performance.now() - started) })
    } finally {
      server.stop()
    }
  }

  test("finds everything the imperfect lab contains, and replays each of them", async () => {
    const metrics = await measure("imperfect")
    expect(metrics.status).toBe("completed")
    expect(metrics.precision).toBe(1)
    expect(metrics.recall).toBe(1)
    expect(metrics.reproductionRate).toBe(1)
    expect(metrics.scopeViolations).toBe(0)
  }, 180_000)

  test("raises nothing against a lab where everything is correct", async () => {
    const metrics = await measure("clean")
    expect(metrics.status).toBe("completed")
    expect(metrics.confirmed).toBe(0)
    expect(metrics.falsePositives).toBe(0)
    expect(metrics.scopeViolations).toBe(0)
  }, 180_000)

  test("refuses to confirm what a second look contradicts", async () => {
    const metrics = await measure("partial")
    expect(metrics.status).toBe("completed")
    // The honesty path has to be exercised, not merely not-failed: discovery
    // raised something and independent validation threw it out.
    expect(metrics.rejected + metrics.inconclusive).toBeGreaterThan(0)
    expect(metrics.confirmed).toBe(0)
    expect(metrics.overconfident).toBe(0)
  }, 180_000)
})
