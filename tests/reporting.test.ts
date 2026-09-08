import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { assertManifest, type EngagementManifest, type EngagementSnapshot } from "@cyrion/contracts"
import { CyrionController, FixtureRootPlanner, ScopedToolGateway } from "@cyrion/controller"
import { MemoryEvidenceStore } from "@cyrion/evidence"
import {
  buildCommunityReport,
  evaluateGate,
  renderCsvReport,
  renderHtmlReport,
  renderJUnitReport,
  renderJsonReport,
  renderMarkdownReport,
  renderSarifReport,
  REPORT_VERSION,
} from "@cyrion/reporting"
import { FixtureAgentRuntime, FixtureToolAdapter } from "@cyrion/runtime-opencode"

const projectRoot = join(import.meta.dir, "..")

describe("public report export", () => {
  test("renders a versioned report with findings and evidence metadata but no artifact bodies", async () => {
    const value: unknown = await Bun.file(join(projectRoot, "fixtures/demo/engagement.json")).json()
    assertManifest(value)
    const snapshot = await runFixture(value)
    const document = buildCommunityReport(snapshot)

    expect(document.version).toBe(REPORT_VERSION)
    expect(document.summary.confirmed).toBe(1)
    expect(document.summary.artifacts).toBe(6)
    expect(document.findings[0]).toEqual(expect.objectContaining({ id: "F-001", status: "confirmed" }))
    expect(document.evidence[0]).toEqual(expect.objectContaining({ id: "E-001", sha256: expect.any(String) }))

    const markdown = renderMarkdownReport(snapshot)
    expect(markdown).toContain("## Evidence index")
    expect(markdown).toContain("**CONFIRMED**")
    expect(markdown).not.toContain("objectBoundaryMismatch")

    const json = JSON.parse(renderJsonReport(snapshot)) as { version: string; evidence: unknown[] }
    expect(json.version).toBe(REPORT_VERSION)
    expect(json.evidence).toHaveLength(6)
  })

  test("uses the versioned fixture manifest as the release expectation source", async () => {
    const fixtureManifest = await Bun.file(join(projectRoot, "fixtures/manifest.json")).json() as {
      fixtureVersion: string
      scenarios: Record<string, { findingStatus: string | null; tasks: number; evidence: number }>
    }
    expect(fixtureManifest.fixtureVersion).toMatch(/^\d{4}\.\d{2}\.\d+$/)
    expect(fixtureManifest.scenarios["known-positive"]).toEqual(expect.objectContaining({
      findingStatus: "confirmed",
      tasks: 5,
      evidence: 6,
    }))
    expect(fixtureManifest.scenarios.clean).toEqual(expect.objectContaining({
      findingStatus: null,
      tasks: 4,
      evidence: 5,
    }))
  })
})


describe("export formats", () => {
  const snapshot = (): EngagementSnapshot => ({
    manifest: {
      id: "ENG-FMT",
      name: "Format fixture",
      objective: "Exercise every export.",
      profile: "web-api",
      mode: "autonomous",
      scope: { targets: ["https://app.lab.test/"], excluded: [], capabilities: ["http.probe"] },
      budgets: {
        maxConcurrentAgents: 2, maxAgents: 8, maxDepth: 3, maxTasks: 8,
        maxDurationMs: 60_000, maxTokens: 1_000, maxCostUsd: 1,
      },
    },
    status: "completed",
    startedAt: "2026-09-08T00:00:00.000Z",
    finishedAt: "2026-09-08T00:01:00.000Z",
    agents: [],
    tasks: [],
    findings: [{
      id: "F-HIGH",
      title: "Object endpoint answers an unauthenticated request",
      asset: "https://app.lab.test/api/objects/42",
      severity: "high",
      status: "confirmed",
      // Hostile text: a formula prefix for CSV, markup for HTML and XML.
      summary: "=cmd|calc <script>alert(1)</script> & \"quoted\"",
      discoveredBy: "api-1",
      validatedBy: "validator-1",
      evidenceIds: ["E-1"],
      skillId: "api-object-boundary",
      reproduction: { verdict: "reproduced", bundleId: "E-2", steps: 1, runner: "local", at: "2026-09-08T00:00:30.000Z" },
    }, {
      id: "F-LOW",
      title: "Missing browser protection headers",
      asset: "https://app.lab.test/",
      severity: "low",
      status: "rejected",
      summary: "Every header was present during reproduction.",
      discoveredBy: "web-1",
      validatedBy: "validator-2",
      evidenceIds: ["E-1"],
    }],
    evidence: [{
      id: "E-1",
      kind: "response",
      uri: "artifact://ENG-FMT/E-1.json",
      sha256: "b".repeat(64),
      capturedAt: "2026-09-08T00:00:10.000Z",
      source: "api-1",
      contentType: "application/json",
      sizeBytes: 128,
    }],
    usage: { inputTokens: 20, outputTokens: 10, costUsd: 0.002 },
    events: [],
  })

  test("carries authorization, methodology, and reproducibility into the record", () => {
    const report = buildCommunityReport(snapshot(), {
      attestation: "Authorized by ticket SEC-1042",
      sandbox: "local",
      runtime: { planner: "assessment", workers: "capability" },
      models: [
        { role: "worker", endpoint: "deepseek", model: "one-model" },
        { role: "validator", endpoint: "deepseek", model: "one-model" },
      ],
      tools: [{ name: "curl", version: "curl 8.5.0" }],
    })
    expect(report.scope.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(report.scope.attestation).toBe("Authorized by ticket SEC-1042")
    expect(report.methodology).toEqual([])
    expect(report.summary.reproduced).toBe(1)
    expect(report.severities.high).toBe(1)
    expect(report.validations).toHaveLength(2)
    // Discovery and validation shared a model, so the report has to say so.
    expect(report.limitations.join(" ")).toContain("tends to be wrong the same way")
  })

  test("SARIF keeps a rejected candidate visible as a passing result", () => {
    const sarif = JSON.parse(renderSarifReport(snapshot())) as {
      version: string
      runs: Array<{ results: Array<{ kind: string; level: string; properties: { reproduction: string } }> }>
    }
    expect(sarif.version).toBe("2.1.0")
    const [high, low] = sarif.runs[0]!.results
    expect(high).toEqual(expect.objectContaining({ kind: "fail", level: "error" }))
    expect(high!.properties.reproduction).toBe("reproduced")
    expect(low).toEqual(expect.objectContaining({ kind: "pass", level: "none" }))
  })

  test("JUnit fails only on confirmed findings at or above the gate", () => {
    const strict = renderJUnitReport(snapshot(), { failOn: "high" })
    expect(strict).toContain('failures="1"')
    expect(strict).toContain("<failure")
    // The same run, gated at critical, blocks nothing.
    expect(renderJUnitReport(snapshot(), { failOn: "critical" })).toContain('failures="0"')
    // Markup in a finding summary must not escape into the XML.
    expect(strict).not.toContain("<script>")
    expect(strict).toContain("&lt;script&gt;")
  })

  test("the gate counts confirmed findings, not unvalidated candidates", () => {
    const base = snapshot()
    expect(evaluateGate(base, { failOn: "high" }).passed).toBe(false)
    expect(evaluateGate(base, { failOn: "critical" }).passed).toBe(true)

    const candidate = snapshot()
    candidate.findings = [{ ...candidate.findings[0]!, status: "candidate" }]
    expect(evaluateGate(candidate, { failOn: "high" }).passed).toBe(true)
    expect(evaluateGate(candidate, { failOn: "high", failOnUnresolved: true }).passed).toBe(false)

    const abandoned = snapshot()
    abandoned.status = "failed"
    expect(evaluateGate(abandoned, { failOn: "critical" }).reasons.join(" ")).toContain("ended as failed")
  })

  test("CSV neutralizes a formula and keeps reproduction in its own column", () => {
    const csv = renderCsvReport(snapshot())
    const [header, first] = csv.trim().split("\r\n")
    expect(header).toContain("reproduction")
    // A leading = would execute in a spreadsheet, so it is quoted out.
    expect(first).toContain("\"'=cmd|calc")
    expect(first).toContain("reproduced")
  })

  test("HTML is self-contained and escapes untrusted finding text", () => {
    const html = renderHtmlReport(snapshot(), { attestation: "Authorized by ticket SEC-1042" })
    expect(html).toContain("<!doctype html>")
    expect(html).toContain("Authorized by ticket SEC-1042")
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;")
    // No network at open time: no external stylesheet, script, or image.
    expect(html).not.toMatch(/(?:src|href)="https?:/)
  })
})

async function runFixture(manifest: EngagementManifest) {
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
  const snapshot = await controller.run()
  controller.close()
  return snapshot
}
