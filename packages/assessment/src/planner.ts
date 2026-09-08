import {
  CONTRACT_VERSION,
  type EngagementSnapshot,
  type RootDecision,
  type RootPlanner,
  type TaskSpec,
} from "@cyrion/contracts"
import { parseTarget } from "@cyrion/scope"
import { selectSkills, type Skill } from "@cyrion/skills"

export interface AssessmentPlannerOptions {
  skills: readonly Skill[]
  /** Cap on assessment tasks per phase, below the manifest's own task budget. */
  maxAssessmentTasks?: number
}

/**
 * Plans an engagement from the approved scope and the loaded skills.
 *
 * The plan is deterministic: recon first, then one assessment task per
 * applicable skill and target, then independent validation of every candidate,
 * then the report. A provider may review each transition (`--planner llm`) or
 * propose its own (`--planner llm-author`); either way the controller validates
 * what reaches the queue.
 */
export class AssessmentRootPlanner implements RootPlanner {
  readonly #skills: readonly Skill[]
  readonly #maxAssessmentTasks: number

  constructor(options: AssessmentPlannerOptions) {
    this.#skills = options.skills
    this.#maxAssessmentTasks = options.maxAssessmentTasks ?? 16
  }

  async decide(snapshot: EngagementSnapshot): Promise<RootDecision> {
    const { scope } = snapshot.manifest
    const existing = new Set(snapshot.tasks.map((task) => task.key))
    const reconDone = this.#completed(snapshot, "recon")

    if (!snapshot.tasks.some((task) => task.role === "recon")) {
      const tasks = this.#reconTasks(snapshot, existing)
      if (tasks.length) return delegate("Inventory the approved surface before assessing it.", tasks)
    }

    if (reconDone) {
      const tasks = this.#assessmentTasks(snapshot, existing)
      if (tasks.length) return delegate("Assess each approved asset with the skills that apply to it.", tasks)
    }

    const assessmentsDone = snapshot.tasks
      .filter((task) => task.role === "web" || task.role === "api")
      .every((task) => task.status === "completed")
    const candidate = snapshot.findings.find((finding) => finding.status === "candidate")
    if (reconDone && assessmentsDone && candidate) {
      const key = `validate:${candidate.id}`
      if (!existing.has(key)) {
        const skill = validatorSkill(this.#skills, candidate.asset, scope.capabilities)
        return delegate("Validate the candidate independently with fresh evidence.", [{
          id: `T-VAL-${candidate.id}`,
          key,
          role: "validator",
          objective: `Independently reproduce ${candidate.id} and return a bounded verdict.`,
          target: candidate.asset,
          capabilities: grantedFor(scope.capabilities, skill?.appliesTo.capabilities ?? ["http.probe"]),
          dependencies: dependenciesFor(snapshot, ["web", "api"]),
          depth: 2,
          expectedOutput: "validation",
          findingId: candidate.id,
          ...(skill ? { skillId: skill.id } : {}),
        }])
      }
    }

    const validationsDone = snapshot.tasks
      .filter((task) => task.role === "validator")
      .every((task) => task.status === "completed")
    if (reconDone && assessmentsDone && validationsDone && !existing.has(`report:${snapshot.manifest.id}`)) {
      return delegate("Report from accepted records and their evidence only.", [{
        id: "T-REPORT",
        key: `report:${snapshot.manifest.id}`,
        role: "reporter",
        objective: "Render the engagement report from structured records.",
        target: primaryTarget(snapshot),
        capabilities: grantedFor(scope.capabilities, ["http.probe"]),
        dependencies: dependenciesFor(snapshot, ["recon", "web", "api", "validator"]),
        depth: 2,
        expectedOutput: "report",
      }])
    }

    if (this.#completed(snapshot, "reporter")) {
      return {
        version: CONTRACT_VERSION,
        action: { kind: "finish", rationale: "Assessment, validation, and reporting completed." },
      }
    }
    return {
      version: CONTRACT_VERSION,
      action: { kind: "stop", reason: "policy", rationale: "No valid next transition exists for this scope." },
    }
  }

  async close(): Promise<void> {}

  #reconTasks(snapshot: EngagementSnapshot, existing: Set<string>): TaskSpec[] {
    const tasks: TaskSpec[] = []
    for (const [index, expression] of assessableTargets(snapshot).entries()) {
      const kind = parseTarget(expression).kind
      const skill = selectSkills(this.#skills, {
        kind,
        role: "recon",
        grantedCapabilities: snapshot.manifest.scope.capabilities,
      })[0]
      if (!skill) continue
      const key = `recon:${expression}`
      if (existing.has(key)) continue
      tasks.push({
        id: `T-RECON-${index + 1}`,
        key,
        role: "recon",
        objective: skill.objective,
        target: expression,
        capabilities: grantedFor(snapshot.manifest.scope.capabilities, skill.appliesTo.capabilities),
        dependencies: [],
        depth: 1,
        expectedOutput: "inventory",
        skillId: skill.id,
      })
    }
    return tasks
  }

  #assessmentTasks(snapshot: EngagementSnapshot, existing: Set<string>): TaskSpec[] {
    const tasks: TaskSpec[] = []
    const reconIds = dependenciesFor(snapshot, ["recon"])
    for (const expression of assessableTargets(snapshot)) {
      const kind = parseTarget(expression).kind
      for (const role of ["web", "api"] as const) {
        for (const skill of selectSkills(this.#skills, {
          kind,
          role,
          grantedCapabilities: snapshot.manifest.scope.capabilities,
        })) {
          const key = `${skill.id}:${expression}`
          if (existing.has(key) || tasks.length >= this.#maxAssessmentTasks) continue
          tasks.push({
            id: `T-${role.toUpperCase()}-${tasks.length + 1}`,
            key,
            role,
            objective: skill.objective,
            target: expression,
            capabilities: grantedFor(snapshot.manifest.scope.capabilities, skill.appliesTo.capabilities),
            dependencies: reconIds,
            depth: 2,
            expectedOutput: "assessment",
            skillId: skill.id,
          })
        }
      }
    }
    return tasks
  }

  #completed(snapshot: EngagementSnapshot, role: TaskSpec["role"]): boolean {
    const tasks = snapshot.tasks.filter((task) => task.role === role)
    return tasks.length > 0 && tasks.every((task) => task.status === "completed")
  }
}

/**
 * The validator methodology to follow for one candidate.
 *
 * The most demanding selectable skill wins: when the manifest grants `poc.run`,
 * the reproduction skill applies and validation produces a replayable bundle;
 * when it does not, the bounded-observation skill still applies and the run
 * says plainly which one it used.
 */
function validatorSkill(
  skills: readonly Skill[],
  asset: string,
  grantedCapabilities: readonly string[],
): Skill | undefined {
  let kind
  try {
    kind = parseTarget(asset).kind
  } catch {
    return undefined
  }
  return selectSkills(skills, { kind, role: "validator", grantedCapabilities })
    .sort((left, right) => right.appliesTo.capabilities.length - left.appliesTo.capabilities.length)[0]
}

/** Repository roots are inventoried, not requested over the network. */
function assessableTargets(snapshot: EngagementSnapshot): string[] {
  return snapshot.manifest.scope.targets.filter((expression) => {
    try {
      return parseTarget(expression).kind !== "repo"
    } catch {
      return false
    }
  })
}

function primaryTarget(snapshot: EngagementSnapshot): string {
  return assessableTargets(snapshot)[0] ?? snapshot.manifest.scope.targets[0] ?? ""
}

function dependenciesFor(snapshot: EngagementSnapshot, roles: readonly TaskSpec["role"][]): string[] {
  return snapshot.tasks.filter((task) => roles.includes(task.role)).map((task) => task.id)
}

/** A task may only ask for capabilities the manifest already granted. */
function grantedFor(granted: readonly string[], wanted: readonly string[]): string[] {
  const allowed = wanted.filter((capability) => granted.includes(capability))
  return allowed.length ? allowed : [...wanted].slice(0, 1)
}

function delegate(rationale: string, tasks: TaskSpec[]): RootDecision {
  return { version: CONTRACT_VERSION, action: { kind: "delegate", rationale, tasks } }
}
