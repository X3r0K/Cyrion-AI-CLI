import { createHash } from "node:crypto"
import {
  POC_VERSION,
  type Finding,
  type PocExpectation,
  type PocPlan,
  type PocStep,
  type Severity,
} from "@cyrion/contracts"
import { checkNeedsRequest, type Skill, type SkillCheck } from "@cyrion/skills"
import { concreteUrl } from "./poc-plan"

/**
 * A methodology carried out from its own file.
 *
 * A skill's checks state what to ask an approved asset and what answer makes it
 * a candidate. The same statement drives all three moments a claim passes
 * through — discovery, independent validation, and the proof bundle — so a
 * contributed skill cannot disagree with itself, and adding a detection stops
 * meaning editing a worker.
 */

/** What one check asks of `http.request`, or of `http.probe` when it can. */
export interface CheckRequestInput {
  method: PocStep["method"]
  path?: string
  headers?: Record<string, string>
}

/** The response as either capability reports it, in one shape. */
export interface CheckResponse {
  status: number
  headers: Record<string, string>
  body: string
  truncated: boolean
}

export function checkRequestInput(check: SkillCheck): CheckRequestInput {
  return {
    method: check.request?.method ?? "GET",
    ...(check.request?.path ? { path: check.request.path } : {}),
    ...(check.request?.headers ? { headers: check.request.headers } : {}),
  }
}

/** The capability a check needs, given what it asks and what it asserts. */
export function checkCapability(check: SkillCheck, granted: readonly string[]): string | undefined {
  if (checkNeedsRequest(check)) return granted.includes("http.request") ? "http.request" : undefined
  if (granted.includes("http.request")) return "http.request"
  return granted.includes("http.probe") ? "http.probe" : undefined
}

/**
 * The finding a check raises, named after the check that raised it.
 *
 * The name is how a validator gets back to the statement it has to re-test
 * from the record alone: the candidate carries its skill, and the identifier
 * says which of that skill's checks produced it. Nothing about the discovering
 * worker is needed to make that connection.
 */
export function checkFindingId(check: SkillCheck, asset: string): string {
  const name = check.id.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return `F-${name || "CHECK"}-${short(asset)}`
}

/** The skill and check a candidate came from, resolved from the record alone. */
export function checkFor(
  skills: readonly Skill[],
  candidate: Finding,
): { skill: Skill; check: SkillCheck } | undefined {
  const skill = skills.find((item) => item.id === candidate.skillId)
  const check = skill?.checks?.find((entry) => checkFindingId(entry, candidate.asset) === candidate.id)
  return skill && check ? { skill, check } : undefined
}

export function checkSeverity(skill: Skill, check: SkillCheck): Severity {
  return check.finding.severity ?? skill.severity
}

/**
 * The check as a proof step.
 *
 * Discovery and reproduction assert the same conditions because they are the
 * same object: a bundle built from this cannot claim something the check never
 * claimed, and an operator reading `REPRO.md` sees the methodology's own words.
 */
export function checkStep(check: SkillCheck, asset: string): PocStep | undefined {
  const base = concreteUrl(asset)
  if (!base.startsWith("http://") && !base.startsWith("https://")) return undefined
  let url: string
  try {
    const resolved = new URL(check.request?.path ?? "", base)
    if (resolved.origin !== new URL(base).origin) return undefined
    url = resolved.toString()
  } catch {
    return undefined
  }
  return {
    id: check.id,
    description: `${check.finding.title} on ${url}`,
    method: check.request?.method ?? "GET",
    url,
    ...(check.request?.headers ? { headers: { ...check.request.headers } } : {}),
    expect: { ...check.expect },
  }
}

/** The plan that reproduces a declarative candidate, from the check that raised it. */
export function checkPlan(candidate: Finding, check: SkillCheck): PocPlan | undefined {
  const step = checkStep(check, candidate.asset)
  if (!step) return undefined
  return {
    version: POC_VERSION,
    findingId: candidate.id,
    title: `${candidate.title} on ${step.url}`,
    rationale:
      `The finding states the conditions this methodology declared: ${conditionText(check)}. `
      + "One bounded read repeats the request and requires every one of them to still hold.",
    steps: [step],
  }
}

/**
 * The conditions in the operator's own words.
 *
 * Written from the skill file rather than from the response, so nothing a
 * target chose ends up in a finding's summary.
 */
export function conditionText(check: SkillCheck): string {
  return expectationText(check.expect) || "no condition"
}

function expectationText(expect: PocExpectation): string {
  const parts: string[] = []
  if (expect.status?.length) parts.push(`status ${expect.status.join(" or ")}`)
  if (expect.headersPresent?.length) parts.push(`${expect.headersPresent.join(", ")} present`)
  if (expect.headersAbsent?.length) parts.push(`${expect.headersAbsent.join(", ")} absent`)
  if (expect.contentType) parts.push(`content type containing ${expect.contentType}`)
  if (expect.bodyIncludes !== undefined) parts.push("the declared marker in the body")
  if (expect.bodyExcludes !== undefined) parts.push("the declared text absent from the body")
  if (expect.anyOf?.length) {
    parts.push(`any of: ${expect.anyOf.map((entry) => expectationText(entry)).join(" / ")}`)
  }
  return parts.join("; ")
}

/**
 * What actually held, named the way the skill named it.
 *
 * With alternatives, the declared statement and the reason are no longer the
 * same sentence: "any of five headers absent" is the claim, and *which* of
 * them were absent is what a reader needs. Both come from the skill file, so
 * neither is written by the target.
 */
export function matchedText(outcome: { matched: readonly string[] }): string {
  return outcome.matched.join("; ") || "no condition"
}

/**
 * The response, from whichever capability answered.
 *
 * `http.probe` reports header names and the content type but no values and no
 * body, which is exactly the set of conditions a skill may assert under it —
 * the loader refuses a body claim that a probe could not decide.
 */
export function checkResponse(summary: Record<string, unknown>): CheckResponse | undefined {
  const status = summary.status
  if (typeof status !== "number") return undefined
  const headers: Record<string, string> = {}
  const reported = summary.headers
  if (reported && typeof reported === "object" && !Array.isArray(reported)) {
    for (const [name, value] of Object.entries(reported as Record<string, unknown>)) {
      if (typeof value === "string") headers[name.toLowerCase()] = value
    }
  } else {
    // A probe answers with names only. Presence is still decidable, and the
    // content type is reported on its own.
    for (const name of (summary.headerNames as string[] | undefined) ?? []) headers[name.toLowerCase()] = ""
    if (typeof summary.contentType === "string") headers["content-type"] = summary.contentType
  }
  return {
    status,
    headers,
    body: typeof summary.body === "string" ? summary.body : "",
    truncated: summary.bodyTruncated === true,
  }
}

/**
 * Deterministic, identifier-safe suffix for a finding id.
 *
 * The readable part is truncated, so a digest of the full target is appended:
 * two sibling endpoints must never collapse onto one finding id, which the
 * controller would reject as a duplicate mid-engagement.
 */
export function short(target: string): string {
  const clean = target.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  const digest = createHash("sha256").update(target).digest("hex").slice(0, 8)
  return `${clean.slice(0, 20) || "asset"}-${digest}`
}
