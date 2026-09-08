import { readdir } from "node:fs/promises"
import { join } from "node:path"
import type { AgentRole, Severity } from "@cyrion/contracts"

export const SKILL_VERSION = "cyrion.community/skill-v1" as const

export type SkillTargetKind = "url" | "host" | "repo"

export interface SkillApplicability {
  kinds: SkillTargetKind[]
  /** Every capability listed must be granted before the skill is selected. */
  capabilities: string[]
  roles: Array<Exclude<AgentRole, "root">>
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
}

export function skillContractError(value: unknown): string | undefined {
  if (!isRecord(value)) return "skill must be an object"
  const extra = unexpectedKey(value, [
    "version", "id", "name", "source", "appliesTo", "objective", "preconditions",
    "steps", "expectedEvidence", "falsePositives", "severity", "references",
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
