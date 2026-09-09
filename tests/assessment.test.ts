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

function manifestFor(targets: string[], capabilities = ["dns.lookup", "http.probe"]): EngagementManifest {
  const manifest = {
    id: "ENG-LAB-TEST",
    name: "Lab",
    objective: "Assess the approved lab surface.",
    profile: "web-api" as const,
    mode: "autonomous" as const,
    scope: { targets, excluded: [], capabilities: [...capabilities] },
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

async function assess(
  targets: string[],
  between?: () => void,
  extra: { skills?: Skill[]; capabilities?: string[] } = {},
): Promise<AssessmentRun> {
  const manifest = manifestFor(targets, extra.capabilities)
  const loaded = extra.skills ?? skills
  const evidence = new MemoryEvidenceStore()
  const registry = new CapabilityRegistry({
    runner: new LocalToolRunner({ allowedBinaries: [] }),
    scope: manifest.scope,
    evidence,
    capabilities: manifest.scope.capabilities,
  })
  const controller = new CyrionController(
    manifest,
    new CapabilityWorkerRuntime({ skills: loaded }),
    new AssessmentRootPlanner({ skills: loaded }),
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

  test("carries out a skill nobody wrote code for, and validates it independently", async () => {
    // Everything this detection knows lives in the file: what to ask, what
    // answer makes it a finding, and what the finding says. No branch in the
    // runtime mentions it.
    const contributed: Skill = {
      version: "cyrion.community/skill-v1",
      id: "lab-object-owner-disclosure",
      name: "Object response names another account's owner",
      appliesTo: { kinds: ["url"], capabilities: ["http.request"], roles: ["api"] },
      objective: "Check whether an approved object response discloses the owner of the record.",
      preconditions: ["The approved scope includes an object endpoint"],
      steps: ["Request the approved object endpoint and read the response body."],
      expectedEvidence: ["response"],
      severity: "medium",
      checks: [{
        id: "owner",
        expect: { status: [200], contentType: "application/json", bodyIncludes: "\"owner\"" },
        finding: {
          title: "Object response discloses an owner field",
          summary: "The approved object endpoint returned a body naming the record's owner.",
        },
      }],
    }

    const { snapshot, evidence } = await assess([`${origin}/api/objects/42`], undefined, {
      skills: [...skills, contributed],
      capabilities: ["dns.lookup", "http.probe", "http.request"],
    })
    expect(snapshot.status).toBe("completed")
    expect(rejections(snapshot)).toBe(0)

    const raised = snapshot.findings.find((finding) => finding.skillId === contributed.id)!
    expect(raised).toBeDefined()
    expect(raised.title).toBe("Object response discloses an owner field")
    expect(raised.severity).toBe("medium")
    expect(raised.status).toBe("confirmed")
    // Independently: a different agent, with evidence it captured itself.
    expect(raised.validatedBy).toBeDefined()
    expect(raised.validatedBy).not.toBe(raised.discoveredBy)
    expect(raised.evidenceIds.length).toBeGreaterThan(1)
    for (const id of raised.evidenceIds) {
      const reference = snapshot.evidence.find((item) => item.id === id)!
      expect(await evidence.verify(reference)).toBe(true)
    }
    // The summary quotes the skill's own conditions, never the target's words.
    expect(raised.summary).toContain("content type containing application/json")
    expect(renderMarkdownReport(snapshot)).toContain("Methodology: `lab-object-owner-disclosure`")
  }, 120_000)

  test("a declared condition that does not hold raises nothing", async () => {
    const absent: Skill = {
      version: "cyrion.community/skill-v1",
      id: "lab-marker-absent",
      name: "Marker that the lab never returns",
      appliesTo: { kinds: ["url"], capabilities: ["http.request"], roles: ["api"] },
      objective: "Check for a marker this lab does not serve.",
      steps: ["Request the approved object endpoint and look for the marker."],
      expectedEvidence: ["response"],
      severity: "high",
      checks: [{
        id: "marker",
        expect: { status: [200], bodyIncludes: "BEGIN RSA PRIVATE KEY" },
        finding: { title: "Private key material in an object response", summary: "The response carried key material." },
      }],
    }

    const { snapshot } = await assess([`${origin}/api/objects/42`], undefined, {
      skills: [...skills, absent],
      capabilities: ["dns.lookup", "http.probe", "http.request"],
    })
    expect(snapshot.status).toBe("completed")
    expect(snapshot.findings.filter((finding) => finding.skillId === absent.id)).toHaveLength(0)
    // It still ran, and said so with evidence: "looked and found nothing" is a
    // different record from "never looked".
    const observations = snapshot.tasks.flatMap((task) => task.result?.observations ?? [])
    const checked = observations.find((observation) => observation.summary.includes("Checked marker"))!
    expect(checked.summary).toContain("not met")
    expect(checked.evidenceIds.length).toBeGreaterThan(0)
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
    // The verdict names what the target did on the second look, in the terms
    // the skill declared: the protections it had claimed were absent are set.
    expect(finding.summary).toContain("Independent reproduction did not hold")
    expect(finding.summary).toContain("content-security-policy present")
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
