import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { assertManifest, type EngagementManifest, type FindingStatus } from "@cyrion/contracts"
import { CyrionController, FixtureRootPlanner, ScopedToolGateway } from "@cyrion/controller"
import { LocalEvidenceStore } from "@cyrion/evidence"
import { FixtureAgentRuntime, FixtureToolAdapter, type FixtureScenario } from "@cyrion/runtime-opencode"

const projectRoot = join(import.meta.dir, "..")

describe("controlled assessment workflow", () => {
  test("produces confirmed, rejected, inconclusive, and clean outcomes with verifiable evidence", async () => {
    const cases: Array<{ scenario: FixtureScenario; expected?: FindingStatus }> = [
      { scenario: "known-positive", expected: "confirmed" },
      { scenario: "rejected", expected: "rejected" },
      { scenario: "incomplete", expected: "inconclusive" },
      { scenario: "clean" },
    ]

    for (const item of cases) {
      const manifest = await scenarioManifest(item.scenario)
      const artifacts = await mkdtemp(`/tmp/cyrion-${item.scenario}-`)
      const evidenceStore = new LocalEvidenceStore(artifacts)
      const adapter = new FixtureToolAdapter()
      const gateway = new ScopedToolGateway(manifest, {
        "fixture.read": adapter,
        "fixture.compare": adapter,
      })
      const controller = new CyrionController(
        manifest,
        new FixtureAgentRuntime({ scenario: item.scenario, evidenceStore }),
        new FixtureRootPlanner(),
        join(projectRoot, "agents"),
        { toolGateway: gateway, heartbeatIntervalMs: 50 },
      )
      const result = await controller.run()

      expect(result.status).toBe("completed")
      expect(result.findings.at(0)?.status).toBe(item.expected)
      expect(result.tasks.some((task) => task.role === "validator")).toBe(item.scenario !== "clean")
      expect(result.tasks.some((task) => task.role === "reporter" && task.status === "completed")).toBe(true)
      expect(result.evidence.every((reference) => reference.uri.startsWith(`artifact://${manifest.id}/`))).toBe(true)
      expect(result.evidence.every((reference) => reference.source && reference.contentType && reference.sizeBytes)).toBe(true)
      for (const reference of result.evidence) expect(await evidenceStore.verify(reference)).toBe(true)

      const report = result.tasks.find((task) => task.role === "reporter")?.result?.report
      expect(report).toContain(`Scenario: ${item.scenario}`)
      if (item.scenario === "clean") {
        expect(result.findings).toHaveLength(0)
        expect(result.tasks).toHaveLength(4)
      } else {
        expect(result.tasks).toHaveLength(5)
        expect(result.events.some((event) =>
          event.type === "finding.updated"
          && (event.payload as { finding?: { status?: string } }).finding?.status === "validating"
        )).toBe(true)
      }
    }
  })

  test("detects artifact tampering and rejects path traversal identifiers", async () => {
    const root = await mkdtemp("/tmp/cyrion-evidence-")
    const store = new LocalEvidenceStore(root)
    const reference = await store.capture({
      engagementId: "ENG-TEST",
      id: "E-TEST",
      kind: "log",
      content: "trusted fixture content",
      contentType: "text/plain",
      source: "test-worker",
    })
    expect(await store.verify(reference)).toBe(true)

    await Bun.write(join(root, "ENG-TEST", "E-TEST.txt"), "tampered content")
    expect(await store.verify(reference)).toBe(false)

    await expect(store.capture({
      engagementId: "ENG-TEST",
      id: "../escape",
      kind: "log",
      content: "blocked",
      contentType: "text/plain",
      source: "test-worker",
    })).rejects.toThrow("Invalid evidence ID")
  })
})

async function scenarioManifest(scenario: FixtureScenario): Promise<EngagementManifest> {
  const path = scenario === "known-positive"
    ? join(projectRoot, "fixtures/demo/engagement.json")
    : join(projectRoot, "fixtures/scenarios", `${scenario}.json`)
  const value: unknown = await Bun.file(path).json()
  assertManifest(value)
  return value
}
