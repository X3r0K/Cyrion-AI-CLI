import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngagementSnapshot, ScopePolicy, TaskSpec, WorkerResult } from "@cyrion/contracts"
import { CapabilityRegistry, countSeverities, parseGrypeMatches, parseSemgrepResults } from "@cyrion/capabilities"
import { workerResultPolicyError } from "@cyrion/controller"
import { MemoryEvidenceStore } from "@cyrion/evidence"
import { LocalToolRunner } from "@cyrion/sandbox"
import { buildScanManifest, normalizeTarget, scanInputError, defaultScanInput } from "../apps/cli/src/scan-config"

async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cyrion-repo-"))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture" }))
  await writeFile(join(root, "index.ts"), "export const a = 1\n")
  await writeFile(join(root, "server.ts"), "export const b = 2\n")
  await writeFile(join(root, "main.py"), "print('hi')\n")
  await writeFile(join(root, ".env"), "SECRET=x\n")
  await mkdir(join(root, "src"))
  await writeFile(join(root, "src", "app.ts"), "export const c = 3\n")
  // Vendored code the project did not write, and build output.
  await mkdir(join(root, "node_modules", "left-pad"), { recursive: true })
  await writeFile(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1\n")
  await mkdir(join(root, "dist"))
  await writeFile(join(root, "dist", "bundle.js"), "1\n")
  return root
}

async function inventory(root: string, scopeRoot = root) {
  const evidence = new MemoryEvidenceStore()
  const scope: ScopePolicy = { targets: [`repo:${scopeRoot}`], excluded: [], capabilities: ["repo.inventory"] }
  const registry = new CapabilityRegistry({
    runner: new LocalToolRunner({ allowedBinaries: [] }),
    scope,
    evidence,
    capabilities: ["repo.inventory"],
  })
  return registry.execute({
    engagementId: "ENG-REPO",
    taskId: "T-1",
    agentId: "recon-1",
    capability: "repo.inventory",
    target: `repo:${root}`,
    timeoutMs: 30_000,
    maxOutputBytes: 1_000_000,
    input: {},
  }, new AbortController().signal)
}

describe("inventorying a repository", () => {
  test("counts the project's own code and skips what it vendored", async () => {
    const root = await fixtureRepo()
    try {
      const result = await inventory(root)
      const summary = result.summary as {
        files: number
        languages: Array<{ language: string; files: number }>
        manifests: string[]
        entrypoints: string[]
        configuration: string[]
      }
      // package.json, index.ts, server.ts, main.py, .env, src/app.ts — and
      // nothing from node_modules or dist, which hold code the project did not
      // write and would inflate every total.
      expect(summary.files).toBe(6)
      expect(summary.languages).toEqual([
        { language: "TypeScript", files: 3 },
        { language: "Python", files: 1 },
      ])
      expect(summary.manifests).toEqual(["package.json"])
      expect(summary.entrypoints).toEqual(["index.ts", "main.py", "server.ts", "src/app.ts"])
      expect(summary.configuration).toEqual([".env"])
      expect(result.evidence).toHaveLength(1)
      expect(result.outcome).toContain("TypeScript")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("does not follow a symlink out of the approved root", async () => {
    const root = await fixtureRepo()
    const outside = await mkdtemp(join(tmpdir(), "cyrion-outside-"))
    try {
      await writeFile(join(outside, "secret.ts"), "export const leaked = true\n")
      await symlink(outside, join(root, "linked"))
      const summary = (await inventory(root)).summary as { files: number }
      // The linked directory is not walked, so its file is never counted and
      // the total is the same as without the link.
      expect(summary.files).toBe(6)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("refuses a repository the scope does not admit", async () => {
    const root = await fixtureRepo()
    const other = await mkdtemp(join(tmpdir(), "cyrion-other-"))
    try {
      expect(inventory(root, other)).rejects.toThrow(/refused/)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(other, { recursive: true, force: true })
    }
  })
})

describe("a repository finding is a static claim", () => {
  test("cannot be confirmed, because nothing in a checkout is running", () => {
    const root = "/srv/checkout"
    const snapshot = {
      manifest: {
        id: "ENG-REPO",
        name: "r",
        objective: "o",
        profile: "repository",
        mode: "autonomous",
        scope: { targets: [`repo:${root}`], excluded: [], capabilities: ["repo.inventory"] },
        budgets: {
          maxConcurrentAgents: 1, maxAgents: 4, maxDepth: 2, maxTasks: 4,
          maxDurationMs: 60_000, maxTokens: 100, maxCostUsd: 1,
        },
      },
      status: "running",
      agents: [],
      tasks: [],
      findings: [],
      evidence: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      events: [],
    } as unknown as EngagementSnapshot
    const task: TaskSpec = {
      id: "T-1",
      key: "repo:1",
      role: "web",
      objective: "Look at the checkout.",
      target: `repo:${root}`,
      capabilities: ["repo.inventory"],
      dependencies: [],
      depth: 1,
      expectedOutput: "assessment",
    }
    const finding = {
      id: "F-STATIC",
      title: "Vulnerable dependency",
      asset: `repo:${root}`,
      severity: "high" as const,
      summary: "A lockfile pins a version with a known advisory.",
      discoveredBy: "web-t-1",
      evidenceIds: ["E-1"],
    }
    const evidence = {
      id: "E-1",
      kind: "log" as const,
      uri: "artifact://ENG-REPO/E-1.json",
      sha256: "a".repeat(64),
      capturedAt: new Date().toISOString(),
      source: "web-t-1",
    }
    const result = (status: "candidate" | "confirmed"): WorkerResult => ({
      summary: "Looked at the checkout.",
      observations: [],
      evidence: [evidence],
      findings: [{ ...finding, status }],
    })

    expect(workerResultPolicyError(result("candidate"), task, snapshot, "web-t-1")).toBeUndefined()
    expect(workerResultPolicyError(result("confirmed"), task, snapshot, "web-t-1"))
      .toContain("static claim about a repository and cannot be confirmed")
  })
})

describe("reading what the external scanners report", () => {
  test("takes the fields a report can carry from grype", () => {
    const matches = parseGrypeMatches(JSON.stringify({
      matches: [
        {
          vulnerability: { id: "CVE-2024-0001", severity: "High", fix: { versions: ["1.2.4"] } },
          artifact: { name: "left-pad", version: "1.2.3" },
        },
        { vulnerability: { id: "GHSA-xxxx", severity: "Low" }, artifact: { name: "tar", version: "6.0.0" } },
        { artifact: { name: "no-vulnerability" } },
      ],
    }))
    expect(matches).toEqual([
      { id: "CVE-2024-0001", severity: "high", package: "left-pad", version: "1.2.3", fixedIn: "1.2.4" },
      { id: "GHSA-xxxx", severity: "low", package: "tar", version: "6.0.0" },
    ])
    expect(countSeverities(matches)).toEqual(expect.objectContaining({ high: 1, low: 1, critical: 0 }))
    expect(parseGrypeMatches("not json")).toEqual([])
  })

  test("keeps semgrep's rule and location without quoting the source", () => {
    const results = parseSemgrepResults(JSON.stringify({
      results: [{
        check_id: "python.lang.security.audit.eval-detected",
        path: "/srv/app/handlers.py",
        start: { line: 42 },
        extra: { severity: "ERROR", message: "eval() on user input", lines: "eval(request.body)" },
      }],
    }), "/srv/app")
    expect(results).toEqual([{
      ruleId: "python.lang.security.audit.eval-detected",
      path: "handlers.py",
      line: 42,
      severity: "error",
      message: "eval() on user input",
    }])
    // The matched source itself never leaves the repository.
    expect(JSON.stringify(results)).not.toContain("request.body")
  })
})

describe("configuring a repository scan", () => {
  test("resolves a checkout once, so scope and capability agree on what was approved", () => {
    expect(normalizeTarget("./packages/scope")).toBe(`repo:${join(process.cwd(), "packages/scope")}`)
    expect(normalizeTarget(".")).toBe(`repo:${process.cwd()}`)
    expect(normalizeTarget("/srv/app")).toBe("repo:/srv/app")
    // A bare name is still a website.
    expect(normalizeTarget("example.com")).toBe("https://example.com/")
  })

  test("matches capabilities to the kind of target", () => {
    // A mismatch is no longer a refusal to correct. The capabilities that do
    // not apply are dropped when the manifest is built, so naming a checkout
    // and naming a site both just work.
    const repo = { ...defaultScanInput, target: "." }
    expect(scanInputError({ ...repo, capabilities: ["http.probe"] })).toBeUndefined()
    expect(buildScanManifest({ ...repo, capabilities: ["http.probe", "repo.inventory"] })
      .scope.capabilities).toEqual(["repo.inventory"])
    expect(buildScanManifest({
      ...defaultScanInput,
      target: "https://example.com",
      capabilities: ["repo.inventory", "http.probe"],
    }).scope.capabilities).toEqual(["http.probe"])
  })

  test("builds a repository engagement with the repository profile", () => {
    const manifest = buildScanManifest({
      ...defaultScanInput,
      target: "/srv/app",
      capabilities: ["repo.inventory"],
      attestation: "self-assessment of my own checkout",
    })
    expect(manifest.profile).toBe("repository")
    expect(manifest.scope.targets).toEqual(["repo:/srv/app"])
    expect(manifest.id).toMatch(/^ENG-app-[a-f0-9]{8}$/)
    expect(manifest.objective).toContain("Inventory the approved repository")
  })
})
