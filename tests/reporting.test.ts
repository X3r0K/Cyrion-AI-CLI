import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { assertManifest, type EngagementManifest } from "@cyrion/contracts"
import { CyrionController, FixtureRootPlanner, ScopedToolGateway } from "@cyrion/controller"
import { MemoryEvidenceStore } from "@cyrion/evidence"
import { buildCommunityReport, renderJsonReport, renderMarkdownReport, REPORT_VERSION } from "@cyrion/reporting"
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
