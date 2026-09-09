import { afterAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { ScopePolicy } from "@cyrion/contracts"
import { CapabilityRegistry, judge } from "@cyrion/capabilities"
import { MemoryEvidenceStore } from "@cyrion/evidence"
import { LocalToolRunner } from "@cyrion/sandbox"
import { checkNeedsRequest, loadSkills, skillContractError, type Skill, type SkillCheck } from "@cyrion/skills"
import {
  checkCapability,
  checkFindingId,
  checkFor,
  checkPlan,
  checkResponse,
  checkStep,
  conditionText,
  matchedText,
} from "@cyrion/assessment"
import { startLab } from "../fixtures/lab/server"

const projectRoot = join(import.meta.dir, "..")

function skill(overrides: Partial<Skill> = {}): Record<string, unknown> {
  return {
    version: "cyrion.community/skill-v1",
    id: "example-check",
    name: "Example",
    appliesTo: { kinds: ["url"], capabilities: ["http.request"], roles: ["api"] },
    objective: "Check one thing about an approved endpoint.",
    steps: ["Ask the endpoint and read the answer."],
    expectedEvidence: ["response"],
    severity: "medium",
    checks: [{
      id: "example",
      expect: { status: [200] },
      finding: { title: "Something is true", summary: "The endpoint answered as described." },
    }],
    ...overrides,
  }
}

/** Replaces the single check with one the test is about. */
function withCheck(check: Record<string, unknown>, applies?: Record<string, unknown>): Record<string, unknown> {
  const value = skill()
  value.checks = [check]
  if (applies) value.appliesTo = { ...(value.appliesTo as object), ...applies }
  return value
}

describe("a skill that states its own checks", () => {
  test("accepts a complete check and rejects an unknown field", () => {
    expect(skillContractError(skill())).toBeUndefined()
    expect(skillContractError(withCheck({
      id: "example",
      expect: { status: [200] },
      finding: { title: "t", summary: "s" },
      whenever: "never",
    }))).toContain("unexpected field whenever")
  })

  test("refuses a body claim a probe could not decide", () => {
    // A body condition needs the typed request capability. Saying so at load
    // is the difference between a refusal an author can fix and a run that
    // fails halfway through.
    const error = skillContractError(withCheck(
      {
        id: "marker",
        expect: { status: [200], bodyIncludes: "root:x:0:0" },
        finding: { title: "t", summary: "s" },
      },
      { capabilities: ["http.probe"] },
    ))!
    expect(error).toContain("http.request")
    expect(checkNeedsRequest({
      id: "marker",
      expect: { status: [200], bodyIncludes: "x" },
      finding: { title: "t", summary: "s" },
    })).toBe(true)
  })

  test("refuses a path that leaves the approved target", () => {
    for (const path of ["../admin", "//evil.test/admin", "/api/../../etc/passwd"]) {
      expect(skillContractError(withCheck({
        id: "walk",
        request: { path },
        expect: { status: [200] },
        finding: { title: "t", summary: "s" },
      }))).toBeDefined()
    }
    expect(skillContractError(withCheck({
      id: "ok",
      request: { path: "/api/objects/42" },
      expect: { status: [200] },
      finding: { title: "t", summary: "s" },
    }))).toBeUndefined()
  })

  test("may authenticate and may change state, and still refuses nonsense", () => {
    // Testing authorization means authenticating; the credential is redacted
    // where the exchange is written rather than refused where it is declared.
    expect(skillContractError(withCheck({
      id: "auth",
      request: { headers: { authorization: "Bearer token" } },
      expect: { status: [200] },
      finding: { title: "t", summary: "s" },
    }))).toBeUndefined()
    expect(skillContractError(withCheck({
      id: "write",
      request: { method: "POST" },
      expect: { status: [200] },
      finding: { title: "t", summary: "s" },
    }))).toBeUndefined()
    expect(skillContractError(withCheck({
      id: "bogus",
      request: { method: "TRACE" },
      expect: { status: [200] },
      finding: { title: "t", summary: "s" },
    }))).toContain("must be one of")
  })

  test("refuses checks on a role or target kind that never runs them", () => {
    expect(skillContractError(withCheck(
      { id: "example", expect: { status: [200] }, finding: { title: "t", summary: "s" } },
      { roles: ["recon"] },
    ))).toContain("web or api")
    expect(skillContractError(withCheck(
      { id: "example", expect: { status: [200] }, finding: { title: "t", summary: "s" } },
      { kinds: ["repo"] },
    ))).toContain("url targets only")
  })

  test("requires at least one condition, and refuses duplicate check ids", () => {
    expect(skillContractError(withCheck({
      id: "empty",
      expect: {},
      finding: { title: "t", summary: "s" },
    }))).toContain("at least one condition")
    const duplicated = skill()
    duplicated.checks = [
      { id: "same", expect: { status: [200] }, finding: { title: "t", summary: "s" } },
      { id: "same", expect: { status: [404] }, finding: { title: "t", summary: "s" } },
    ]
    expect(skillContractError(duplicated)).toContain("duplicate id: same")
  })

  test("offers alternatives, bounded and one level deep", () => {
    const alternatives = withCheck({
      id: "headers",
      expect: {
        anyOf: [
          { headersAbsent: ["content-security-policy"] },
          { headersAbsent: ["x-frame-options"] },
        ],
      },
      finding: { title: "t", summary: "s" },
    })
    expect(skillContractError(alternatives)).toBeUndefined()

    // One alternative is not a choice, and a nested tree is not something a
    // reader can check at a glance.
    expect(skillContractError(withCheck({
      id: "one",
      expect: { anyOf: [{ status: [200] }] },
      finding: { title: "t", summary: "s" },
    }))).toContain("2 to 8 alternatives")
    expect(skillContractError(withCheck({
      id: "nested",
      expect: { anyOf: [{ status: [200] }, { anyOf: [{ status: [404] }, { status: [500] }] }] },
      finding: { title: "t", summary: "s" },
    }))).toContain("unexpected field anyOf")
  })

  test("the shipped skills are all carried out from their files", async () => {
    const skills = await loadSkills(join(projectRoot, "skills"))
    // Every shipped detection is data. A skill with no checks raises nothing,
    // so a methodology that can raise a finding is one anybody can read.
    const detections = skills.filter((skill) =>
      skill.appliesTo.roles.some((role) => role === "web" || role === "api"))
    expect(detections.length).toBeGreaterThan(0)
    for (const skill of detections) expect(skill.checks?.length).toBeGreaterThan(0)
  })

  test("the shipped object-boundary skill is carried out from its file", async () => {
    const skills = await loadSkills(join(projectRoot, "skills"))
    const boundary = skills.find((entry) => entry.id === "api-object-boundary")!
    expect(boundary.checks).toHaveLength(1)
    const check = boundary.checks![0]!
    // The identifier the check raises is the one the release has always used,
    // so a stored bundle and an old report still name the same finding.
    expect(checkFindingId(check, "https://app.lab.test/api/objects/42"))
      .toStartWith("F-OBJECT-")
    expect(checkNeedsRequest(check)).toBe(false)
    expect(checkCapability(check, ["http.probe"])).toBe("http.probe")
    expect(checkCapability(check, ["http.request"])).toBe("http.request")
    expect(conditionText(check)).toBe("status 200; content type containing application/json")
  })
})

describe("a claim with alternatives", () => {
  const headers: SkillCheck = {
    id: "headers",
    expect: {
      anyOf: [
        { headersAbsent: ["content-security-policy"] },
        { headersAbsent: ["x-frame-options"] },
      ],
    },
    finding: { title: "Missing browser protection headers", summary: "Protections are missing." },
  }
  const step = checkStep(headers, "https://app.lab.test/")!

  test("holds when one alternative holds, and names the one that did", () => {
    const outcome = judge(step, {
      status: 200,
      headers: { "content-type": "text/html", "x-frame-options": "DENY" },
      body: "",
    }, false)
    expect(outcome.met).toBe(true)
    // Which of them was absent is what a reader needs; the other is not a claim.
    expect(matchedText(outcome)).toBe("content-security-policy absent")
  })

  test("fails only when every alternative fails, and says what it found", () => {
    const outcome = judge(step, {
      status: 200,
      headers: { "content-security-policy": "default-src 'self'", "x-frame-options": "DENY" },
      body: "",
    }, false)
    expect(outcome.met).toBe(false)
    expect(outcome.conclusive).toBe(true)
    expect(outcome.detail).toContain("content-security-policy present")
    expect(outcome.detail).toContain("x-frame-options present")
  })

  test("cannot decide a body alternative from a truncated response", () => {
    const marker: SkillCheck = {
      id: "marker",
      expect: { anyOf: [{ bodyIncludes: "root:x:0:0" }, { bodyIncludes: "BEGIN RSA" }] },
      finding: { title: "t", summary: "s" },
    }
    const outcome = judge(checkStep(marker, "https://app.lab.test/")!, {
      status: 200,
      headers: {},
      body: "nothing here",
    }, true)
    // Not "the marker is absent": a body nobody read in full cannot say that.
    expect(outcome.met).toBe(false)
    expect(outcome.conclusive).toBe(false)
    expect(outcome.detail).toContain("truncated")
  })

  test("a body claim inside an alternative still needs the typed request", () => {
    // A probe reports no body at all. Decided against an empty string, a
    // `bodyExcludes` alternative would *hold* — a candidate raised from a body
    // nobody fetched — so the rule has to reach inside the alternatives.
    const hidden = {
      id: "marker",
      expect: { anyOf: [{ bodyExcludes: "consent-banner" }, { bodyIncludes: "root:x:0:0" }] },
      finding: { title: "t", summary: "s" },
    }
    expect(checkNeedsRequest(hidden as unknown as SkillCheck)).toBe(true)
    expect(skillContractError(withCheck(hidden, { capabilities: ["http.probe"] })))
      .toContain("http.request")
    // And nothing dispatches it under a probe even if a pack loaded some other way.
    expect(checkCapability(hidden as unknown as SkillCheck, ["http.probe"])).toBeUndefined()
    // Alternatives about the response line and its headers are still a probe's job.
    expect(checkNeedsRequest(headers)).toBe(false)
    expect(skillContractError(withCheck(
      {
        id: "headers",
        expect: { anyOf: [{ headersAbsent: ["x-frame-options"] }, { status: [500] }] },
        finding: { title: "t", summary: "s" },
      },
      { capabilities: ["http.probe"] },
    ))).toBeUndefined()
  })

  test("reads as the claim it is", () => {
    expect(conditionText(headers))
      .toBe("any of: content-security-policy absent / x-frame-options absent")
  })
})

describe("one check, three moments", () => {
  const check: SkillCheck = {
    id: "owner",
    request: { method: "GET", path: "/api/objects/42" },
    expect: { status: [200], contentType: "application/json", bodyIncludes: "\"owner\"" },
    finding: { title: "Object response discloses an owner field", summary: "It named the owner." },
  }

  test("discovery, validation, and the proof bundle assert the same thing", () => {
    const asset = "https://app.lab.test/"
    const step = checkStep(check, asset)!
    expect(step.url).toBe("https://app.lab.test/api/objects/42")
    expect(step.expect).toEqual(check.expect)

    const plan = checkPlan({
      id: checkFindingId(check, asset),
      title: check.finding.title,
      asset,
      severity: "medium",
      status: "candidate",
      summary: check.finding.summary,
      discoveredBy: "api-t-1",
      evidenceIds: ["E-1"],
      skillId: "example-check",
    }, check)!
    // The plan a validator executes carries the check's conditions unchanged:
    // a bundle cannot prove something the methodology never claimed.
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]!.expect).toEqual(check.expect)
    expect(plan.findingId).toBe(checkFindingId(check, asset))
  })

  test("a candidate finds its way back to the check that raised it", () => {
    const skills: Skill[] = [{
      version: "cyrion.community/skill-v1",
      id: "example-check",
      name: "Example",
      appliesTo: { kinds: ["url"], capabilities: ["http.request"], roles: ["api"] },
      objective: "o",
      steps: ["s"],
      expectedEvidence: ["response"],
      severity: "medium",
      checks: [check],
    }]
    const candidate = {
      id: checkFindingId(check, "https://app.lab.test/"),
      title: check.finding.title,
      asset: "https://app.lab.test/",
      severity: "medium" as const,
      status: "candidate" as const,
      summary: check.finding.summary,
      discoveredBy: "api-t-1",
      evidenceIds: ["E-1"],
      skillId: "example-check",
    }
    expect(checkFor(skills, candidate)?.check.id).toBe("owner")
    // A record naming a check that no longer exists resolves to nothing rather
    // than to the wrong statement.
    expect(checkFor(skills, { ...candidate, id: "F-GONE-x" })).toBeUndefined()
  })

  test("reads a probe's answer and a request's answer through one shape", () => {
    const fromProbe = checkResponse({ status: 200, headerNames: ["content-type"], contentType: "application/json" })!
    expect(fromProbe.headers["content-type"]).toBe("application/json")
    expect(fromProbe.body).toBe("")
    const fromRequest = checkResponse({
      status: 401,
      headers: { "content-type": "application/json", server: "lab" },
      body: "{\"error\":\"unauthorized\"}",
      bodyTruncated: false,
    })!
    expect(fromRequest.status).toBe(401)
    expect(fromRequest.body).toContain("unauthorized")
    expect(checkResponse({})).toBeUndefined()
  })
})

describe("the typed request capability", () => {
  const lab = startLab()
  const origin = `http://127.0.0.1:${lab.port}`
  afterAll(() => lab.stop())

  async function request(target: string, input: Record<string, unknown>, scope?: ScopePolicy) {
    const policy: ScopePolicy = scope
      ?? { targets: [`${origin}/api/objects/42`], excluded: [], capabilities: ["http.request"] }
    const registry = new CapabilityRegistry({
      runner: new LocalToolRunner({ allowedBinaries: [] }),
      scope: policy,
      evidence: new MemoryEvidenceStore(),
      capabilities: ["http.request"],
    })
    return registry.execute({
      engagementId: "ENG-REQ",
      taskId: "T-1",
      agentId: "api-1",
      capability: "http.request",
      target,
      timeoutMs: 20_000,
      maxOutputBytes: 500_000,
      input,
    }, new AbortController().signal)
  }

  test("answers with the body and headers a check needs, and stores the exchange", async () => {
    const result = await request(`${origin}/api/objects/42`, {})
    const summary = result.summary as { status: number; body: string; headers: Record<string, string> }
    expect(summary.status).toBe(200)
    expect(summary.body).toContain("owner")
    expect(summary.headers["content-type"]).toContain("application/json")
    expect(result.evidence).toHaveLength(1)
    expect(result.outcome).toContain("→ 200")
  })

  test("refuses a path outside the approved scope, and carries a session", async () => {
    expect(request(`${origin}/api/objects/42`, { path: "/api/private/9" }))
      .rejects.toThrow(/http\.request refused/)
    // A session cookie is how an authenticated check reaches anything at all.
    const authenticated = await request(`${origin}/api/objects/42`, { headers: { cookie: "session=1" } })
    expect((authenticated.summary as { status: number }).status).toBe(200)
  })

  test("follows a path within the approved subtree", async () => {
    const scope: ScopePolicy = {
      targets: [`${origin}/api/*`],
      excluded: [],
      capabilities: ["http.request"],
    }
    const result = await request(`${origin}/api/*`, { path: "/api/objects/7" }, scope)
    const summary = result.summary as { status: number; url: string }
    expect(summary.status).toBe(200)
    expect(summary.url).toBe(`${origin}/api/objects/7`)
  })
})
