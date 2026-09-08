import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AssessmentRootPlanner, CapabilityWorkerRuntime } from "@cyrion/assessment"
import { CapabilityRegistry } from "@cyrion/capabilities"
import type { EngagementManifest, EngagementSnapshot, Finding } from "@cyrion/contracts"
import { assertManifest } from "@cyrion/contracts"
import { CyrionController, ScopedToolGateway } from "@cyrion/controller"
import { MemoryEvidenceStore } from "@cyrion/evidence"
import { LocalToolRunner } from "@cyrion/sandbox"
import { renderMarkdownReport } from "@cyrion/reporting"
import { loadSkills, type Skill } from "@cyrion/skills"
import { startLab } from "../fixtures/lab/server"

const projectRoot = join(import.meta.dir, "..")
const lab = startLab()
const origin = `http://127.0.0.1:${lab.port}`
afterAll(() => lab.stop())

const skills: Skill[] = await loadSkills(join(projectRoot, "skills"))

function manifestFor(targets: string[]): EngagementManifest {
  const manifest = {
    id: "ENG-LAB-TEST",
    name: "Lab",
    objective: "Assess the approved lab surface.",
    profile: "web-api" as const,
    mode: "autonomous" as const,
    scope: { targets, excluded: [], capabilities: ["dns.lookup", "http.probe"] },
    budgets: {
      maxConcurrentAgents: 3, maxAgents: 40, maxDepth: 3, maxTasks: 40,
      maxDurationMs: 120_000, maxTokens: 100_000, maxCostUsd: 1,
    },
  }
  assertManifest(manifest)
  return manifest
}

interface AssessmentRun {
  snapshot: EngagementSnapshot
  evidence: MemoryEvidenceStore
}

async function assess(targets: string[], between?: () => void): Promise<AssessmentRun> {
  const manifest = manifestFor(targets)
  const evidence = new MemoryEvidenceStore()
  const registry = new CapabilityRegistry({
    runner: new LocalToolRunner({ allowedBinaries: [] }),
    scope: manifest.scope,
    evidence,
    capabilities: manifest.scope.capabilities,
  })
  const controller = new CyrionController(
    manifest,
    new CapabilityWorkerRuntime({ skills }),
    new AssessmentRootPlanner({ skills }),
    join(projectRoot, "agents"),
    {
      toolGateway: new ScopedToolGateway(manifest, registry.toolAdapters()),
      heartbeatIntervalMs: 50,
      evidenceStore: evidence,
    },
  )
  if (between) {
    const unsubscribe = controller.events.subscribe((event) => {
      // Change the target once the first candidate exists, before validation runs.
      if (event.type === "finding.updated") between()
    })
    const snapshot = await controller.run()
    unsubscribe()
    controller.close()
    return { snapshot, evidence }
  }
  const snapshot = await controller.run()
  controller.close()
  return { snapshot, evidence }
}

const rejections = (snapshot: EngagementSnapshot): number =>
  snapshot.events.filter((event) =>
    event.type === "tool.request.rejected"
    || event.type === "root.decision.rejected"
    || event.type === "task.result.rejected").length

describe("assessment against a controlled lab", () => {
  test("finds both known issues, confirms them with fresh evidence, and violates no scope", async () => {
    const { snapshot, evidence } = await assess([`${origin}/`, `${origin}/api/objects/42`])
    expect(snapshot.status).toBe("completed")
    expect(rejections(snapshot)).toBe(0)

    const confirmed = snapshot.findings.filter((finding) => finding.status === "confirmed")
    expect(confirmed).toHaveLength(3)
    expect(confirmed.map((finding) => finding.skillId).sort())
      .toEqual(["api-object-boundary", "web-security-headers", "web-security-headers"])

    for (const finding of confirmed) {
      // Validation must be independent: a different agent, with evidence it captured itself.
      expect(finding.validatedBy).toBeDefined()
      expect(finding.validatedBy).not.toBe(finding.discoveredBy)
      expect(finding.evidenceIds.length).toBeGreaterThan(1)
      for (const id of finding.evidenceIds) {
        const reference = snapshot.evidence.find((item) => item.id === id)
        expect(reference).toBeDefined()
        // The artifact behind every claim exists and still matches its digest.
        expect(await evidence.verify(reference!)).toBe(true)
      }
    }

    const report = snapshot.tasks.find((task) => task.role === "reporter")?.result?.report
    expect(report).toContain("ENG-LAB-TEST")

    // The exported report states how each finding was produced.
    const rendered = renderMarkdownReport(snapshot)
    expect(rendered).toContain("Methodology: `web-security-headers`")
    expect(rendered).toContain("Methodology: `api-object-boundary`")
  }, 120_000)

  test("raises nothing against an endpoint that behaves correctly", async () => {
    const { snapshot } = await assess([`${origin}/hardened`, `${origin}/api/private/9`])
    expect(snapshot.status).toBe("completed")
    expect(snapshot.findings).toHaveLength(0)
    expect(rejections(snapshot)).toBe(0)
  }, 120_000)

  test("rejects a candidate the target no longer reproduces", async () => {
    lab.harden(false)
    let flipped = false
    const { snapshot } = await assess([`${origin}/`], () => {
      if (flipped) return
      flipped = true
      lab.harden(true)
    })
    lab.harden(false)

    const finding = snapshot.findings.at(0) as Finding
    expect(finding.status).toBe("rejected")
    expect(finding.summary).toContain("every header present")
    expect(finding.validatedBy).toBeDefined()
  }, 120_000)

  test("every task names the skill that produced it, and stays inside the grant", async () => {
    const { snapshot } = await assess([`${origin}/`])
    const assessment = snapshot.tasks.filter((task) => task.role === "web" || task.role === "api")
    expect(assessment.length).toBeGreaterThan(0)
    for (const task of snapshot.tasks) {
      if (task.role !== "reporter") expect(task.skillId).toBeDefined()
      for (const capability of task.capabilities) {
        expect(snapshot.manifest.scope.capabilities).toContain(capability)
      }
      expect(snapshot.manifest.scope.targets).toContain(task.target)
    }
  }, 120_000)
})

describe("skills", () => {
  test("selects only skills whose kind, role, and capabilities all match", () => {
    const forUrl = skills.filter((skill) => skill.appliesTo.kinds.includes("url"))
    expect(forUrl.length).toBeGreaterThan(0)
    const planner = new AssessmentRootPlanner({ skills })
    expect(planner).toBeDefined()

    const restricted = skills.filter((skill) => skill.appliesTo.capabilities.every((c) => c === "http.probe"))
    expect(restricted.map((skill) => skill.id)).toContain("web-security-headers")
  })

  test("refuses a malformed skill rather than loading a partial set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyrion-skills-"))
    try {
      const valid = skills[0]!
      await Bun.write(join(directory, "good.skill.json"), JSON.stringify(valid))
      expect(await loadSkills(directory)).toHaveLength(1)

      await Bun.write(join(directory, "bad.skill.json"), JSON.stringify({ ...valid, severity: "catastrophic" }))
      expect(loadSkills(directory)).rejects.toThrow(/severity is invalid/)

      await Bun.write(join(directory, "bad.skill.json"), JSON.stringify({ ...valid, id: valid.id }))
      expect(loadSkills(directory)).rejects.toThrow(/Duplicate skill id/)

      await Bun.write(join(directory, "bad.skill.json"), "{ not json")
      expect(loadSkills(directory)).rejects.toThrow(/not valid JSON/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
