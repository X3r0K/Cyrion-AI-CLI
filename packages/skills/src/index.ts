import { readdir } from "node:fs/promises"
import { join } from "node:path"
import {
  POC_METHODS,
  pocExpectationContractError,
  pocHeadersContractError,
  type AgentRole,
  type PocExpectation,
  type PocMethod,
  type Severity,
} from "@cyrion/contracts"

export const SKILL_VERSION = "cyrion.community/skill-v1" as const

export type SkillTargetKind = "url" | "host" | "repo"

export interface SkillApplicability {
  kinds: SkillTargetKind[]
  /** Every capability listed must be granted before the skill is selected. */
  capabilities: string[]
  roles: Array<Exclude<AgentRole, "root">>
}

/** Checks a skill may declare, so a methodology is executable as data. */
export const SKILL_MAX_CHECKS = 8

export interface SkillCheckRequest {
  /** Reads only. The vocabulary has no method that changes state. */
  method?: PocMethod
  /** Resolved against the approved target, and re-checked against scope. */
  path?: string
  /** Sent with the request. Never a credential; those are refused by name. */
  headers?: Record<string, string>
}

/**
 * One executable claim: what to ask an asset, and what answer makes it a
 * finding.
 *
 * The conditions are the same vocabulary a proof-of-concept step states, so a
 * check that raises a candidate compiles into the plan that reproduces it. A
 * skill that declares checks does not need a worker written for it: the same
 * file drives discovery, independent validation, and the proof bundle.
 */
export interface SkillCheck {
  id: string
  request?: SkillCheckRequest
  /** Every condition must hold for this to be a candidate finding. */
  expect: PocExpectation
  finding: {
    title: string
    summary: string
    /** Defaults to the skill's own severity. */
    severity?: Severity
  }
}

/**
 * One reviewable unit of methodology.
 *
 * A skill is operator-authored and therefore trusted input: its steps become
 * task instructions. Target content never gets promoted to that status. Skills
 * are JSON rather than front-matter Markdown on purpose — a security tool
 * should not add a parser dependency to read its own methodology.
 */
export interface Skill {
  version: typeof SKILL_VERSION
  id: string
  name: string
  /** Public standard this derives from, when it derives from one. */
  source?: string
  appliesTo: SkillApplicability
  objective: string
  preconditions?: string[]
  steps: string[]
  expectedEvidence: string[]
  falsePositives?: string[]
  severity: Severity
  references?: string[]
  /**
   * Executable checks. A skill without them is methodology a worker has to
   * know how to carry out; a skill with them is carried out from the file.
   */
  checks?: SkillCheck[]
}

/**
 * Whether a check needs `http.request` rather than `http.probe`.
 *
 * A probe answers with a status, header names, and a content type — enough for
 * a claim about the response line and its headers. A path, a request header, or
 * a claim about the body needs the typed request capability, and a skill that
 * asserts one has to say so in its applicability.
 *
 * Alternatives count. A probe reports no body at all, so a body claim hidden in
 * an `anyOf` would be decided against an empty string rather than refused —
 * and `bodyExcludes` would *hold*, raising a candidate from a body nobody ever
 * fetched. The rule reaches inside alternatives for that reason.
 */
export function checkNeedsRequest(check: SkillCheck): boolean {
  return !!(check.request?.path || check.request?.headers || expectationUsesBody(check.expect))
}

/** Whether deciding this expectation needs the response body, alternatives included. */
function expectationUsesBody(expect: PocExpectation): boolean {
  if (expect.bodyIncludes !== undefined || expect.bodyExcludes !== undefined) return true
  return (expect.anyOf ?? []).some((alternative) => expectationUsesBody(alternative))
}

export function skillContractError(value: unknown): string | undefined {
  if (!isRecord(value)) return "skill must be an object"
  const extra = unexpectedKey(value, [
    "version", "id", "name", "source", "appliesTo", "objective", "preconditions",
    "steps", "expectedEvidence", "falsePositives", "severity", "references", "checks",
  ])
  if (extra) return `unexpected field ${extra}`
  if (value.version !== SKILL_VERSION) return "unsupported skill version"
  if (!identifier(value.id)) return "id must be a safe identifier"
  if (!text(value.name, 128)) return "name must be a non-empty string of at most 128 characters"
  if ("source" in value && !text(value.source, 64)) return "source must be a short string"
  if (!text(value.objective, 512)) return "objective must be a non-empty string of at most 512 characters"
  if (!isRecord(value.appliesTo)) return "appliesTo must be an object"
  const applicabilityExtra = unexpectedKey(value.appliesTo, ["kinds", "capabilities", "roles"])
  if (applicabilityExtra) return `appliesTo contains unexpected field ${applicabilityExtra}`
  const kindsError = list(value.appliesTo.kinds, "appliesTo.kinds", ["url", "host", "repo"])
  if (kindsError) return kindsError
  const rolesError = list(value.appliesTo.roles, "appliesTo.roles", ["recon", "web", "api", "validator", "reporter"])
  if (rolesError) return rolesError
  if (!Array.isArray(value.appliesTo.capabilities) || !value.appliesTo.capabilities.length) {
    return "appliesTo.capabilities must name at least one capability"
  }
  if (value.appliesTo.capabilities.some((capability) => !identifier(capability))) {
    return "appliesTo.capabilities contains an invalid entry"
  }
  for (const [field, minimum] of [["steps", 1], ["expectedEvidence", 1]] as const) {
    const entries = value[field]
    if (!Array.isArray(entries) || entries.length < minimum || entries.length > 64) {
      return `${field} must be an array of ${minimum} to 64 entries`
    }
    if (entries.some((entry) => !text(entry, 512))) return `${field} contains an invalid entry`
  }
  for (const field of ["preconditions", "falsePositives", "references"] as const) {
    if (!(field in value)) continue
    const entries = value[field]
    if (!Array.isArray(entries) || entries.length > 64) return `${field} must be an array of at most 64 entries`
    if (entries.some((entry) => !text(entry, 512))) return `${field} contains an invalid entry`
  }
  if (!["info", "low", "medium", "high", "critical"].includes(String(value.severity))) return "severity is invalid"
  if ("checks" in value) {
    const checksError = checksContractError(value.checks, value.appliesTo as unknown as SkillApplicability)
    if (checksError) return checksError
  }
  return undefined
}

/**
 * Rules a declarative check has to survive before any worker will run it.
 *
 * A check is operator-authored and therefore trusted, which is exactly why it
 * is bounded here rather than at the target: what a skill file may ask for is
 * the boundary, and a file that asks for something outside it is refused at
 * load rather than half-executed during a run.
 */
function checksContractError(value: unknown, appliesTo: SkillApplicability): string | undefined {
  if (!Array.isArray(value) || !value.length || value.length > SKILL_MAX_CHECKS) {
    return `checks must be an array of 1 to ${SKILL_MAX_CHECKS} entries`
  }
  // A check speaks HTTP and raises a candidate. A recon skill inventories and a
  // validator reproduces; neither runs checks, so a file claiming both would be
  // half ignored.
  if (appliesTo.kinds.some((kind) => kind !== "url")) {
    return "a skill with checks applies to url targets only; a check is an HTTP exchange"
  }
  if (appliesTo.roles.some((role) => role !== "web" && role !== "api")) {
    return "a skill with checks applies to the web or api roles only"
  }
  const ids = new Set<string>()
  for (const [index, entry] of value.entries()) {
    const error = checkContractError(entry, `checks[${index}]`, appliesTo)
    if (error) return error
    const id = (entry as SkillCheck).id
    if (ids.has(id)) return `checks contains a duplicate id: ${id}`
    ids.add(id)
  }
  return undefined
}

function checkContractError(value: unknown, path: string, appliesTo: SkillApplicability): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`
  const extra = unexpectedKey(value, ["id", "request", "expect", "finding"])
  if (extra) return `${path} contains unexpected field ${extra}`
  if (!identifier(value.id)) return `${path}.id must be a safe identifier`

  if ("request" in value) {
    if (!isRecord(value.request)) return `${path}.request must be an object`
    const requestExtra = unexpectedKey(value.request, ["method", "path", "headers"])
    if (requestExtra) return `${path}.request contains unexpected field ${requestExtra}`
    // A check fans out across every applicable asset, so a state-changing method
    // here is a broader act than the same method in an exploit plan aimed at one
    // finding. It is allowed — a skill file is the operator's own methodology —
    // and worth knowing about before you write one.
    if ("method" in value.request && !(POC_METHODS as readonly string[]).includes(String(value.request.method))) {
      return `${path}.request.method must be one of ${POC_METHODS.join(", ")}`
    }
    if ("path" in value.request) {
      const pathError = requestPathError(value.request.path, `${path}.request.path`)
      if (pathError) return pathError
    }
    if ("headers" in value.request) {
      const headersError = pocHeadersContractError(value.request.headers, `${path}.request.headers`)
      if (headersError) return headersError
    }
  }

  const expectError = pocExpectationContractError(value.expect, `${path}.expect`)
  if (expectError) return expectError

  if (!isRecord(value.finding)) return `${path}.finding must be an object`
  const findingExtra = unexpectedKey(value.finding, ["title", "summary", "severity"])
  if (findingExtra) return `${path}.finding contains unexpected field ${findingExtra}`
  if (!text(value.finding.title, 128)) return `${path}.finding.title must be a non-empty string of at most 128 characters`
  if (!text(value.finding.summary, 512)) return `${path}.finding.summary must be a non-empty string of at most 512 characters`
  if ("severity" in value.finding
    && !["info", "low", "medium", "high", "critical"].includes(String(value.finding.severity))) {
    return `${path}.finding.severity is invalid`
  }

  // The capability a check needs is part of what makes the skill applicable. A
  // body claim under http.probe would be undecidable at run time, so it is a
  // load-time refusal with the fix in it.
  if (checkNeedsRequest(value as unknown as SkillCheck) && !appliesTo.capabilities.includes("http.request")) {
    return `${path} asks for a path, a request header, or a body condition, so `
      + "appliesTo.capabilities must include http.request"
  }
  if (!checkNeedsRequest(value as unknown as SkillCheck)
    && !appliesTo.capabilities.includes("http.request")
    && !appliesTo.capabilities.includes("http.probe")) {
    return `${path} needs http.probe or http.request in appliesTo.capabilities`
  }
  return undefined
}

/** A path a check may request: under the approved target, and nothing clever. */
function requestPathError(value: unknown, path: string): string | undefined {
  if (typeof value !== "string" || !value.length || value.length > 512) {
    return `${path} must be a non-empty string of at most 512 characters`
  }
  if (/[\u0000-\u001F\u007F-\u009F\s]/.test(value)) return `${path} contains control characters`
  if (!value.startsWith("/")) return `${path} must start with / and stay under the approved target`
  // `//host` is a URL in disguise, and `..` walks out of the approved subtree.
  if (value.startsWith("//")) return `${path} must not name another host`
  if (value.split(/[/?#]/).some((segment) => segment === "..")) return `${path} must not contain a .. segment`
  return undefined
}

export function assertSkill(value: unknown): asserts value is Skill {
  const error = skillContractError(value)
  if (error) throw new Error(`Invalid skill: ${error}`)
}

/** Loads every `*.skill.json` in a directory, refusing the whole set on any error. */
export async function loadSkills(directory: string): Promise<Skill[]> {
  const entries = await readdir(directory).catch(() => [])
  const skills: Skill[] = []
  for (const entry of entries.filter((name) => name.endsWith(".skill.json")).sort()) {
    const path = join(directory, entry)
    let value: unknown
    try {
      value = await Bun.file(path).json()
    } catch {
      throw new Error(`Skill ${entry} is not valid JSON`)
    }
    const error = skillContractError(value)
    if (error) throw new Error(`Skill ${entry} is invalid: ${error}`)
    const skill = value as Skill
    if (skills.some((existing) => existing.id === skill.id)) throw new Error(`Duplicate skill id: ${skill.id}`)
    skills.push(skill)
  }
  return skills
}

export interface SkillSelection {
  kind: SkillTargetKind
  role: Exclude<AgentRole, "url" | "root"> | Exclude<AgentRole, "root">
  grantedCapabilities: readonly string[]
}

/** Skills whose target kind, role, and required capabilities are all satisfied. */
export function selectSkills(skills: readonly Skill[], selection: SkillSelection): Skill[] {
  return skills.filter((skill) =>
    skill.appliesTo.kinds.includes(selection.kind)
    && skill.appliesTo.roles.includes(selection.role as Exclude<AgentRole, "root">)
    && skill.appliesTo.capabilities.every((capability) => selection.grantedCapabilities.includes(capability)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function unexpectedKey(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key))
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum
}

function list(value: unknown, path: string, allowed: readonly string[]): string | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 16) return `${path} must be a non-empty array`
  if (value.some((entry) => !allowed.includes(String(entry)))) return `${path} contains an unsupported entry`
  return undefined
}
