import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AssessmentRootPlanner, CapabilityWorkerRuntime, checkPlan } from "@cyrion/assessment"
import { CapabilityRegistry, buildStepArgv, redactArgv, redactTranscript, stepBudgetMs } from "@cyrion/capabilities"
import {
  POC_VERSION,
  pocBundleContractError,
  pocPlanContractError,
  type EngagementManifest,
  type EngagementSnapshot,
  type EvidenceStore,
  type Finding,
  type PocBundle,
  type PocPlan,
  type TaskSpec,
  type WorkerResult,
} from "@cyrion/contracts"
import { CyrionController, ScopedToolGateway, workerResultPolicyError } from "@cyrion/controller"
import { LocalEvidenceStore, MemoryEvidenceStore } from "@cyrion/evidence"
import { renderMarkdownReport } from "@cyrion/reporting"
import { LocalToolRunner } from "@cyrion/sandbox"
import { loadSkills, type Skill } from "@cyrion/skills"
import { startLab } from "../fixtures/lab/server"

const projectRoot = join(import.meta.dir, "..")
const lab = startLab()
const origin = `http://127.0.0.1:${lab.port}`
afterAll(() => lab.stop())

const skills: Skill[] = await loadSkills(join(projectRoot, "skills"))
const capabilities = ["dns.lookup", "http.probe", "poc.run"]

function manifestFor(targets: string[]): EngagementManifest {
  return {
    id: "ENG-POC-TEST",
    name: "Lab reproduction",
    objective: "Assess the approved lab surface and reproduce every candidate.",
    profile: "web-api",
    mode: "autonomous",
    scope: { targets, excluded: [], capabilities },
    budgets: {
      maxConcurrentAgents: 3, maxAgents: 40, maxDepth: 3, maxTasks: 40,
      maxDurationMs: 180_000, maxTokens: 100_000, maxCostUsd: 1,
    },
  }
}

function registryFor(manifest: EngagementManifest, evidence: EvidenceStore): CapabilityRegistry {
  return new CapabilityRegistry({
    runner: new LocalToolRunner({ allowedBinaries: ["curl"] }),
    scope: manifest.scope,
    evidence,
    capabilities: manifest.scope.capabilities,
  })
}

function headerPlan(url: string, headers: string[]): PocPlan {
  return {
    version: POC_VERSION,
    findingId: "F-HEADERS",
    title: "Missing browser protection headers",
    rationale: "The response must still omit the protections it omitted at discovery.",
    steps: [{
      id: "request",
      description: `Request ${url} and inspect the response headers`,
      method: "GET",
      url,
      expect: { status: [200], headersAbsent: headers },
    }],
  }
}

async function runPoc(
  manifest: EngagementManifest,
  plan: PocPlan,
  evidence: EvidenceStore,
  target = plan.steps[0]!.url,
) {
  return registryFor(manifest, evidence).execute({
    engagementId: manifest.id,
    taskId: "T-POC",
    agentId: "validator-t-poc",
    capability: "poc.run",
    target,
    timeoutMs: 30_000,
    maxOutputBytes: 500_000,
    input: { plan },
  }, new AbortController().signal)
}

describe("PoC plan contract", () => {
  const base = headerPlan(`${origin}/`, ["content-security-policy"])

  test("admits the methods and payloads an exploit needs", () => {
    expect(pocPlanContractError(base)).toBeUndefined()
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(pocPlanContractError({ ...base, steps: [{ ...base.steps[0]!, method }] })).toBeUndefined()
    }
    expect(pocPlanContractError({ ...base, steps: [{ ...base.steps[0]!, method: "POST", body: "id=1" }] }))
      .toBeUndefined()
    expect(pocPlanContractError({ ...base, steps: [{ ...base.steps[0]!, method: "TRACE" }] }))
      .toContain("method must be one of")
    // A body on a method that cannot carry one would be dropped silently and
    // the step would prove nothing, so it is named instead.
    expect(pocPlanContractError({ ...base, steps: [{ ...base.steps[0]!, body: "id=1" }] }))
      .toContain("cannot be sent with GET")
  })

  test("sends a credential, and refuses a malformed URL", () => {
    // Authenticating is the point: authorization cannot be tested without it.
    // The value is redacted where the bundle is written, not refused here.
    expect(pocPlanContractError({
      ...base,
      steps: [{ ...base.steps[0]!, headers: { Authorization: "Bearer secret" } }],
    })).toBeUndefined()
    expect(pocPlanContractError({ ...base, steps: [{ ...base.steps[0]!, url: `${origin}/api/*` }] }))
      .toContain("concrete URL")
    expect(pocPlanContractError({ ...base, steps: [{ ...base.steps[0]!, url: `http://user:pw@127.0.0.1/` }] }))
      .toContain("must not carry credentials")
    expect(pocPlanContractError({ ...base, steps: [{ ...base.steps[0]!, expect: {} }] }))
      .toContain("must state at least one condition")
  })

  test("fits every step inside the wall clock the gateway allowed", () => {
    // One step may take its own ceiling; eight must share the call's budget,
    // less the rate limit between them, so a full plan cannot outrun the gateway.
    expect(stepBudgetMs(30_000, 1)).toBe(15_000)
    const eight = stepBudgetMs(30_000, 8)
    expect(eight * 8 + 500 * 7).toBeLessThanOrEqual(30_000)
    expect(stepBudgetMs(2_000, 8)).toBe(1_000)
  })

  test("bounds a chain without cutting it short, each step with a distinct id", () => {
    // Long enough to log in, enumerate, escalate and prove the consequence;
    // bounded so a plan stays something an operator reads before running it.
    const chain = Array.from({ length: 64 }, (_, index) => ({ ...base.steps[0]!, id: `step${index}` }))
    expect(pocPlanContractError({ ...base, steps: chain })).toBeUndefined()
    expect(pocPlanContractError({
      ...base,
      steps: [...chain, { ...base.steps[0]!, id: "step64" }],
    })).toContain("1 to 64 steps")
    expect(pocPlanContractError({ ...base, steps: [base.steps[0]!, base.steps[0]!] }))
      .toContain("duplicate step id")
  })
})

describe("a credential an exploit sent", () => {
  test("is redacted everywhere the bundle will be read", () => {
    const argv = buildStepArgv({
      id: "s1",
      description: "Authenticated request",
      method: "GET",
      url: `${origin}/api/objects/42`,
      headers: { Authorization: "Bearer super-secret-token", "X-Trace": "abc" },
      expect: { status: [200] },
    }, [])
    // Sent for real...
    expect(argv).toContain("Authorization: Bearer super-secret-token")
    // ...and gone from anything written down.
    const safe = redactArgv(argv).join(" ")
    expect(safe).not.toContain("super-secret-token")
    expect(safe).toContain("Authorization: [redacted by cyrion]")
    // A header that is not a secret is left alone: the bundle still shows what
    // the request actually was.
    expect(safe).toContain("X-Trace: abc")
  })

  test("is stripped from a credential the server handed back", () => {
    const transcript = [
      "HTTP/1.1 302 Found",
      "Set-Cookie: session=abcd1234; HttpOnly",
      "Location: /dashboard",
      "Content-Type: text/html",
      "",
      "<html>ok</html>",
    ].join("\n")
    const safe = redactTranscript(transcript)
    // The proof that authentication worked, without a working session in it.
    expect(safe).not.toContain("abcd1234")
    expect(safe).toContain("Set-Cookie: [redacted by cyrion]")
    expect(safe).toContain("Location: /dashboard")
    expect(safe).toContain("<html>ok</html>")
  })
})

describe("poc.run", () => {
  test("reproduces a claim, bundles the proof, and keeps the exchange as evidence", async () => {
    const manifest = manifestFor([`${origin}/`])
    const evidence = new MemoryEvidenceStore()
    const result = await runPoc(manifest, headerPlan(`${origin}/`, ["content-security-policy", "x-frame-options"]), evidence)
    const summary = result.summary as { verdict: string; bundleId: string; reproId: string; runner: string }

    expect(summary.verdict).toBe("reproduced")
    expect(summary.runner).toBe("local")
    // Raw exchange, machine-readable bundle, and a human reproduction.
    expect(result.evidence.map((item) => item.kind)).toEqual(["response", "poc", "poc"])
    for (const reference of result.evidence) expect(await evidence.verify(reference)).toBe(true)

    const bundleRef = result.evidence.find((item) => item.id === summary.bundleId)!
    const bundle = JSON.parse(new TextDecoder().decode(await evidence.read(bundleRef))) as PocBundle
    expect(pocBundleContractError(bundle)).toBeUndefined()
    expect(bundle.steps[0]!.argv[0]).toBe("curl")
    expect(bundle.steps[0]!.argv).toContain("--max-redirs")
    expect(bundle.pins[0]).toEqual({ hostname: "127.0.0.1", addresses: ["127.0.0.1"] })
    expect(bundle.steps[0]!.response?.status).toBe(200)
    expect(bundle.script).toContain("curl")

    const repro = result.evidence.find((item) => item.id === summary.reproId)!
    const document = new TextDecoder().decode(await evidence.read(repro))
    expect(document).toContain("# Reproduction — F-HEADERS")
    expect(document).toContain("Verdict: **REPRODUCED**")
    expect(document).toContain("## Reproduce by hand")
  }, 60_000)

  test("does not reproduce a claim the target no longer supports", async () => {
    const manifest = manifestFor([`${origin}/hardened`])
    const plan = { ...headerPlan(`${origin}/hardened`, ["content-security-policy"]) }
    plan.steps[0]!.url = `${origin}/hardened`
    plan.steps[0]!.description = "Request the hardened page"
    const result = await runPoc(manifest, plan, new MemoryEvidenceStore())
    const summary = result.summary as { verdict: string; steps: Array<{ detail: string }> }

    expect(summary.verdict).toBe("not-reproduced")
    expect(summary.steps[0]!.detail).toContain("content-security-policy present")
  }, 60_000)

  test("records an unreachable target as inconclusive rather than as a failed claim", async () => {
    // Port 1 is reserved and nothing listens there, so the connection is refused.
    const target = "http://127.0.0.1:1/"
    const manifest = manifestFor([target])
    const result = await runPoc(manifest, headerPlan(target, ["content-security-policy"]), new MemoryEvidenceStore())
    const summary = result.summary as { verdict: string; steps: Array<{ detail: string }> }

    expect(summary.verdict).toBe("inconclusive")
    expect(summary.steps[0]!.detail).toContain("inconclusive")
  }, 60_000)

  test("refuses a plan that reaches past the assigned target or the approved scope", async () => {
    const manifest = manifestFor([`${origin}/`])
    const evidence = new MemoryEvidenceStore()

    const escaping = headerPlan(`${origin}/`, ["content-security-policy"])
    escaping.steps.push({
      id: "second",
      description: "Reach a host the engagement never approved",
      method: "GET",
      url: "http://127.0.0.2:8123/",
      expect: { status: [200] },
    })
    expect(runPoc(manifest, escaping, evidence)).rejects.toThrow(/not covered by the approved scope/)

    // A plan whose first step is not the assigned target is refused even when
    // every URL in it happens to be inside the scope.
    const wide = manifestFor([`${origin}/`, `${origin}/hardened`])
    expect(runPoc(wide, headerPlan(`${origin}/hardened`, ["x-frame-options"]), evidence, `${origin}/`))
      .rejects.toThrow(/first step must exercise the assigned target/)
  }, 60_000)
})

describe("validation by reproduction", () => {
  interface Run {
    snapshot: EngagementSnapshot
    evidence: LocalEvidenceStore
    artifacts: string
  }

  async function assess(targets: string[], between?: () => void): Promise<Run> {
    const manifest = manifestFor(targets)
    const artifacts = await mkdtemp(join(tmpdir(), "cyrion-poc-"))
    const evidence = new LocalEvidenceStore(artifacts)
    const registry = registryFor(manifest, evidence)
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
    const unsubscribe = between
      ? controller.events.subscribe((event) => {
        if (event.type === "finding.updated") between()
      })
      : undefined
    const snapshot = await controller.run()
    unsubscribe?.()
    controller.close()
    return { snapshot, evidence, artifacts }
  }

  test("confirms only with a bundle whose verdict backs the status, and says so in the report", async () => {
    const { snapshot, evidence, artifacts } = await assess([`${origin}/`, `${origin}/api/objects/42`])
    try {
      expect(snapshot.status).toBe("completed")
      expect(snapshot.events.filter((event) => event.type === "task.result.rejected")).toHaveLength(0)

      const validator = snapshot.tasks.find((task) => task.role === "validator")!
      expect(validator.skillId).toBe("validate-poc-reproduction")
      expect(validator.capabilities).toContain("poc.run")

      const confirmed = snapshot.findings.filter((finding) => finding.status === "confirmed")
      expect(confirmed).toHaveLength(3)
      for (const finding of confirmed) {
        const record = finding.reproduction!
        expect(record.verdict).toBe("reproduced")
        expect(record.runner).toBe("local")
        // The bundle is an artifact this engagement accepted, not a claim.
        expect(finding.evidenceIds).toContain(record.bundleId)
        const bundleRef = snapshot.evidence.find((item) => item.id === record.bundleId)!
        expect(bundleRef.kind).toBe("poc")
        expect(await evidence.verify(bundleRef)).toBe(true)
      }

      const report = renderMarkdownReport(snapshot)
      expect(report).toContain("reproduced independently")
      expect(report).toContain("Every confirmed finding carries a proof bundle")
    } finally {
      await rm(artifacts, { recursive: true, force: true })
    }
  }, 180_000)

  test("rejects a candidate whose bundle no longer reproduces", async () => {
    lab.harden(false)
    let flipped = false
    const { snapshot, artifacts } = await assess([`${origin}/`], () => {
      if (flipped) return
      flipped = true
      lab.harden(true)
    })
    lab.harden(false)
    try {
      const finding = snapshot.findings.at(0) as Finding
      expect(finding.status).toBe("rejected")
      expect(finding.reproduction?.verdict).toBe("not-reproduced")
      expect(finding.summary).toContain("did not reproduce the claim")
    } finally {
      await rm(artifacts, { recursive: true, force: true })
    }
  }, 180_000)

  test("replays every confirmed finding from its bundle alone, with a fresh store", async () => {
    const { snapshot, evidence, artifacts } = await assess([`${origin}/api/objects/42`])
    const replayArtifacts = await mkdtemp(join(tmpdir(), "cyrion-replay-"))
    try {
      const confirmed = snapshot.findings.filter((finding) => finding.status === "confirmed")
      expect(confirmed.length).toBeGreaterThan(0)

      for (const finding of confirmed) {
        const bundleRef = snapshot.evidence.find((item) => item.id === finding.reproduction!.bundleId)!
        const bundle = JSON.parse(new TextDecoder().decode(await evidence.read(bundleRef))) as PocBundle
        expect(pocBundleContractError(bundle)).toBeUndefined()

        // Nothing from the original run is carried over: a new manifest, a new
        // artifact root, a new registry, and the bundle's own plan.
        const replayManifest = manifestFor([finding.asset])
        const replayed = await runPoc(replayManifest, bundle.plan, new LocalEvidenceStore(replayArtifacts))
        expect((replayed.summary as { verdict: string }).verdict).toBe(bundle.verdict)
      }

      // Bundles are written where `cyrion replay` looks for them.
      const stored = await readdir(join(artifacts, snapshot.manifest.id))
      expect(stored.some((entry) => entry.endsWith(".md"))).toBe(true)
    } finally {
      await rm(artifacts, { recursive: true, force: true })
      await rm(replayArtifacts, { recursive: true, force: true })
    }
  }, 180_000)
})

describe("reproduction provenance", () => {
  const manifest = manifestFor([`${origin}/`])
  const candidate: Finding = {
    id: "F-CLAIM",
    title: "Missing browser protection headers",
    asset: `${origin}/`,
    severity: "low",
    status: "validating",
    summary: "The response omits content-security-policy.",
    discoveredBy: "web-t-discovery",
    evidenceIds: ["E-OLD"],
  }
  const snapshot: EngagementSnapshot = {
    manifest,
    status: "running",
    agents: [],
    tasks: [],
    findings: [candidate],
    evidence: [{
      id: "E-OLD",
      kind: "response",
      uri: `artifact://${manifest.id}/E-OLD.json`,
      sha256: "a".repeat(64),
      capturedAt: new Date().toISOString(),
      source: "web-t-discovery",
    }],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    events: [],
  }
  const task: TaskSpec = {
    id: "T-VAL",
    key: "validate:F-CLAIM",
    role: "validator",
    objective: "Reproduce the candidate.",
    target: candidate.asset,
    capabilities: ["http.probe", "poc.run"],
    dependencies: [],
    depth: 1,
    expectedOutput: "validation",
    findingId: candidate.id,
  }
  const fresh = {
    id: "E-NEW",
    kind: "poc" as const,
    uri: `artifact://${manifest.id}/E-NEW.json`,
    sha256: "b".repeat(64),
    capturedAt: new Date().toISOString(),
    source: "validator-t-val",
  }
  const validation = (reproduction: Finding["reproduction"], status: Finding["status"]): WorkerResult => ({
    summary: "Validator verdict.",
    observations: [],
    evidence: [fresh],
    findings: [{
      ...candidate,
      status,
      validatedBy: "validator-t-val",
      evidenceIds: ["E-OLD", "E-NEW"],
      ...(reproduction ? { reproduction } : {}),
    }],
  })
  const record = {
    verdict: "reproduced" as const,
    bundleId: "E-NEW",
    steps: 1,
    runner: "local" as const,
    at: new Date().toISOString(),
  }

  test("accepts a verdict its own bundle supports", () => {
    expect(workerResultPolicyError(validation(record, "confirmed"), task, snapshot, "validator-t-val"))
      .toBeUndefined()
  })

  test("refuses a status the bundle does not support, or a bundle it never captured", () => {
    expect(workerResultPolicyError(validation(record, "inconclusive"), task, snapshot, "validator-t-val"))
      .toBe("Reproduction verdict reproduced does not support status inconclusive")
    expect(workerResultPolicyError(
      validation({ ...record, bundleId: "E-OLD" }, "confirmed"),
      task,
      snapshot,
      "validator-t-val",
    )).toBe("Reproduction bundle E-OLD was not captured by this validation")
  })

  test("refuses a discovering worker that claims a reproduction it never ran", () => {
    const discovery: TaskSpec = { ...task, id: "T-WEB", key: "headers", role: "web", expectedOutput: "assessment" }
    delete discovery.findingId
    const result: WorkerResult = {
      summary: "Discovery.",
      observations: [],
      evidence: [{ ...fresh, source: "web-t-web" }],
      findings: [{
        id: "F-NEW",
        title: "Missing browser protection headers",
        asset: candidate.asset,
        severity: "low",
        status: "candidate",
        summary: "The response omits content-security-policy.",
        discoveredBy: "web-t-web",
        evidenceIds: ["E-NEW"],
        reproduction: record,
      }],
    }
    expect(workerResultPolicyError(result, discovery, snapshot, "web-t-web"))
      .toBe("Worker finding F-NEW cannot claim a reproduction it did not run")
  })
})

describe("plan authoring", () => {
  test("states the claim as the skill's own conditions, and declines what it cannot request", () => {
    const candidate: Finding = {
      id: "F-HEADERS-1",
      title: "Missing browser protection headers",
      asset: `${origin}/`,
      severity: "low",
      status: "candidate",
      summary: "The response omits content-security-policy.",
      discoveredBy: "web-1",
      evidenceIds: ["E-1"],
      skillId: "web-security-headers",
    }
    const check = {
      id: "headers",
      expect: {
        anyOf: [
          { headersAbsent: ["content-security-policy"] },
          { headersAbsent: ["x-frame-options"] },
        ],
      },
      finding: { title: "Missing browser protection headers", summary: "…" },
    }

    // The plan carries the check unchanged: a bundle cannot prove a condition
    // the methodology never stated, and cannot quietly drop one either.
    const plan = checkPlan(candidate, check)!
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]!.expect.anyOf).toEqual(check.expect.anyOf)
    expect(plan.steps[0]!.url).toBe(`${origin}/`)
    expect(plan.rationale).toContain("any of")

    // A repository target has no runtime to reproduce against.
    expect(checkPlan({ ...candidate, asset: "repo:/srv/app" }, check)).toBeUndefined()
  })
})
