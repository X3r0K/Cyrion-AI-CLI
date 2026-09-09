import { afterAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { AssessmentRootPlanner, CapabilityWorkerRuntime } from "@cyrion/assessment"
import { CapabilityRegistry, links } from "@cyrion/capabilities"
import type { EngagementManifest, EngagementSnapshot, ScopePolicy } from "@cyrion/contracts"
import { assertManifest, assertWorkerResult } from "@cyrion/contracts"
import { CyrionController, ScopedToolGateway, workerResultPolicyError } from "@cyrion/controller"
import { MemoryEvidenceStore } from "@cyrion/evidence"
import { LocalToolRunner } from "@cyrion/sandbox"
import { loadSkills, type Skill } from "@cyrion/skills"
import { startLinkedLab } from "../fixtures/lab/server"

const projectRoot = join(import.meta.dir, "..")
const lab = startLinkedLab()
const origin = `http://127.0.0.1:${lab.port}`
afterAll(() => lab.stop())

const skills: Skill[] = await loadSkills(join(projectRoot, "skills"))

async function crawl(target: string, scope: ScopePolicy, input: Record<string, unknown> = {}) {
  const registry = new CapabilityRegistry({
    runner: new LocalToolRunner({ allowedBinaries: [] }),
    scope,
    evidence: new MemoryEvidenceStore(),
    capabilities: ["http.crawl"],
  })
  return registry.execute({
    engagementId: "ENG-CRAWL",
    taskId: "T-1",
    agentId: "recon-1",
    capability: "http.crawl",
    target,
    timeoutMs: 30_000,
    maxOutputBytes: 500_000,
    input,
  }, new AbortController().signal)
}

describe("reading the links a site publishes", () => {
  test("takes href, src, and form actions, and leaves everything else alone", () => {
    const base = new URL("https://app.lab.test/app/")
    const found = links(
      '<a href="/app/one">a</a><img src="/img/logo.png"><form action="/app/search">'
      + '<a href="mailto:x@y.test">m</a><a href="javascript:alert(1)">j</a>'
      + '<a href="#top">t</a><a href="https://elsewhere.test/x">e</a>',
      base,
    ).map((url) => url.toString())
    expect(found).toEqual([
      "https://app.lab.test/app/one",
      "https://app.lab.test/img/logo.png",
      "https://app.lab.test/app/search",
    ])
  })
})

describe("crawling an approved origin", () => {
  test("follows what the scope covers, counts what it does not, and never fetches it", async () => {
    const before = lab.requested.length
    const scope: ScopePolicy = { targets: [`${origin}/app/*`], excluded: [], capabilities: ["http.crawl"] }
    const result = await crawl(`${origin}/app/`, scope)
    const summary = result.summary as {
      pages: number
      endpoints: string[]
      outOfScopeLinks: number
      statuses: Record<string, number>
    }

    // /app/, /app/one, /app/two, /app/three — every page reachable in scope.
    expect(summary.endpoints.sort()).toEqual([
      `${origin}/app/`,
      `${origin}/app/one`,
      `${origin}/app/three`,
      `${origin}/app/two`,
    ])
    expect(summary.pages).toBe(4)
    expect(summary.statuses["200"]).toBe(4)
    // `/admin` is linked from the page and is not in the approved scope. It is
    // counted as a fact about the site, and never requested.
    expect(summary.outOfScopeLinks).toBeGreaterThanOrEqual(1)
    expect(lab.requested.slice(before)).not.toContain("/admin")
    // An off-origin link, a mailto, and an anchor are not endpoints at all.
    expect(summary.endpoints.every((url) => url.startsWith(origin))).toBe(true)

    // The whole walk is one artifact: pages, limits, and what was refused.
    expect(result.evidence).toHaveLength(1)
    expect(result.outcome).toContain("4 pages")
  }, 60_000)

  test("stops at the page budget and says the walk was cut short", async () => {
    const scope: ScopePolicy = { targets: [`${origin}/app/*`], excluded: [], capabilities: ["http.crawl"] }
    const result = await crawl(`${origin}/app/`, scope, { maxPages: 2 })
    const summary = result.summary as { pages: number; truncated: boolean }
    expect(summary.pages).toBe(2)
    expect(summary.truncated).toBe(true)
  }, 60_000)

  test("stays at the starting page when the depth budget is one page deep", async () => {
    const scope: ScopePolicy = { targets: [`${origin}/app/*`], excluded: [], capabilities: ["http.crawl"] }
    const result = await crawl(`${origin}/app/`, scope, { maxDepth: 0 })
    const summary = result.summary as { pages: number; endpoints: string[] }
    expect(summary.pages).toBe(1)
    expect(summary.endpoints).toEqual([`${origin}/app/`])
  }, 60_000)

  test("refuses a starting point the scope does not cover", async () => {
    const scope: ScopePolicy = { targets: [`${origin}/app/*`], excluded: [], capabilities: ["http.crawl"] }
    expect(crawl(`${origin}/admin`, scope)).rejects.toThrow(/http\.crawl refused/)
  })
})

describe("what a worker may report as discovered", () => {
  const manifest: EngagementManifest = (() => {
    const value = {
      id: "ENG-DISCOVER",
      name: "Discovery",
      objective: "Assess an approved origin and what it links to.",
      profile: "web-api" as const,
      mode: "autonomous" as const,
      scope: { targets: [`${origin}/app/*`], excluded: [], capabilities: ["http.crawl", "http.probe"] },
      budgets: {
        maxConcurrentAgents: 2, maxAgents: 10, maxDepth: 3, maxTasks: 10,
        maxDurationMs: 60_000, maxTokens: 10_000, maxCostUsd: 1,
      },
    }
    assertManifest(value)
    return value
  })()

  const snapshot = {
    manifest,
    status: "running",
    startedAt: "2026-09-08T00:00:00.000Z",
    agents: [],
    tasks: [],
    findings: [],
    evidence: [{
      id: "E-1",
      kind: "log" as const,
      uri: `artifact://ENG-DISCOVER/E-1.json`,
      sha256: "a".repeat(64),
      capturedAt: "2026-09-08T00:00:00.000Z",
      source: "recon-1",
      contentType: "application/json",
      sizeBytes: 12,
    }],
    events: [],
    budgetUsage: { agents: 1, tasks: 1, tokens: 0, costUsd: 0 },
  } as unknown as EngagementSnapshot

  const task = {
    id: "T-RECON-1",
    key: "recon:1",
    role: "recon" as const,
    objective: "Inventory",
    target: `${origin}/app/`,
    capabilities: ["http.crawl"],
    dependencies: [],
    depth: 1,
    expectedOutput: "inventory" as const,
  }

  function resultWith(assets: string[]) {
    return {
      summary: "Inventoried the approved origin.",
      observations: [{
        id: "O-recon-1-crawl",
        asset: `${origin}/app/`,
        summary: "Walked the approved section.",
        source: "recon-1",
        evidenceIds: ["E-1"],
        assets,
      }],
      findings: [],
      evidence: [],
    }
  }

  test("the contract accepts discovered addresses, bounded", () => {
    expect(() => assertWorkerResult(resultWith([`${origin}/app/one`]))).not.toThrow()
    expect(() => assertWorkerResult(resultWith(Array.from({ length: 201 }, (_, index) => `${origin}/app/${index}`))))
      .toThrow(/at most 200/)
  })

  test("the controller refuses an address the manifest never approved", () => {
    expect(workerResultPolicyError(resultWith([`${origin}/app/one`]), task, snapshot, "recon-1")).toBeUndefined()
    // The same worker, one link further: reporting it is not permission to look.
    const error = workerResultPolicyError(resultWith([`${origin}/admin`]), task, snapshot, "recon-1")!
    expect(error).toContain("out-of-scope asset")
    expect(error).toContain("/admin")
    expect(workerResultPolicyError(resultWith(["https://elsewhere.test/"]), task, snapshot, "recon-1"))
      .toContain("out-of-scope asset")
  })
})

describe("assessing what recon discovered", () => {
  test("runs the skills against endpoints nobody typed into the manifest", async () => {
    const manifest = {
      id: "ENG-CRAWL-RUN",
      name: "Crawl then assess",
      objective: "Assess every endpoint the approved section links to.",
      profile: "web-api" as const,
      mode: "autonomous" as const,
      scope: {
        targets: [`${origin}/app/*`],
        excluded: [],
        capabilities: ["dns.lookup", "http.probe", "http.crawl"],
      },
      budgets: {
        maxConcurrentAgents: 3, maxAgents: 40, maxDepth: 3, maxTasks: 40,
        maxDurationMs: 120_000, maxTokens: 100_000, maxCostUsd: 1,
      },
    }
    assertManifest(manifest)

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
    const snapshot = await controller.run()
    controller.close()

    expect(snapshot.status).toBe("completed")
    const assessed = new Set(snapshot.tasks
      .filter((task) => task.role === "web" || task.role === "api")
      .map((task) => task.target))
    // The manifest named one section; the run assessed the pages it links to.
    expect(assessed.has(`${origin}/app/one`)).toBe(true)
    expect(assessed.has(`${origin}/app/three`)).toBe(true)
    expect([...assessed].every((target) => target.startsWith(`${origin}/app/`))).toBe(true)
    // The scope pattern itself is not an endpoint. Once the pages under it are
    // known, assessing it too would report one page's issue twice.
    expect(assessed.has(`${origin}/app/*`)).toBe(false)

    // Every finding is about a page that was actually reached, and rests on an
    // artifact captured for it.
    for (const finding of snapshot.findings) {
      expect(finding.asset.startsWith(`${origin}/app/`)).toBe(true)
      expect(finding.evidenceIds.length).toBeGreaterThan(0)
    }
    expect(snapshot.events.filter((event) => event.type === "task.result.rejected")).toHaveLength(0)
  }, 120_000)
})
