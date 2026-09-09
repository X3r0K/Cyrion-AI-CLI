import {
  CONTRACT_VERSION,
  type EngagementSnapshot,
  type RootDecision,
  type RootPlanner,
  type TaskSpec,
} from "@cyrion/contracts"
import { evaluateScope, parseTarget } from "@cyrion/scope"
import { checkNeedsRequest, selectSkills, type Skill } from "@cyrion/skills"
import { checkFor } from "./checks"

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

    // Work a completed task asked for. This is what makes the run a graph
    // rather than a pipeline: a worker that found something worth pursuing says
    // so, and the branch happens here — after the controller has already held
    // the proposal to the scope and the grant, and with the depth and the
    // parent assigned from the task that asked rather than by the asker.
    const spawned = this.#spawnedTasks(snapshot, existing)
    if (spawned.length) {
      return delegate("Follow up on what a worker found, one level deeper.", spawned)
    }

    // Every role that assesses, not just the two the pipeline used to have: a
    // specialist a worker spawned is assessment work, and validating a
    // candidate while one is still running would validate an incomplete run.
    const assessmentsDone = snapshot.tasks
      .filter((task) => isAssessmentRole(task.role))
      .every((task) => task.status === "completed")
    const candidate = snapshot.findings.find((finding) => finding.status === "candidate")
    if (reconDone && assessmentsDone && candidate) {
      const key = `validate:${candidate.id}`
      if (!existing.has(key)) {
        const skill = validatorSkill(this.#skills, candidate.asset, scope.capabilities)
        // A candidate a skill file raised is re-tested by repeating that file's
        // own check, so the validator needs whatever the check asks for.
        const declared = checkFor(this.#skills, candidate)
        return delegate("Validate the candidate independently with fresh evidence.", [{
          id: `T-VAL-${candidate.id}`,
          key,
          role: "validator",
          objective: `Independently reproduce ${candidate.id} and return a bounded verdict.`,
          target: candidate.asset,
          capabilities: grantedFor(scope.capabilities, [
            ...(skill?.appliesTo.capabilities ?? ["http.probe"]),
            ...(declared && checkNeedsRequest(declared.check) ? ["http.request"] : []),
          ]),
          dependencies: assessmentDependencies(snapshot),
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
        dependencies: [
          ...dependenciesFor(snapshot, ["recon", "validator"]),
          ...assessmentDependencies(snapshot),
        ],
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

  /**
   * Turns the proposals on completed tasks into dispatchable work.
   *
   * Everything a proposer could have used to escape is assigned here instead:
   * the depth is the parent's plus one, the parent is the task that proposed,
   * and the capabilities are intersected with the grant a second time. A
   * proposal that would exceed the manifest's depth is dropped rather than
   * clamped — silently running something shallower than was asked for would
   * make the tree lie about what happened.
   */
  #spawnedTasks(snapshot: EngagementSnapshot, existing: Set<string>): TaskSpec[] {
    const { scope, budgets } = snapshot.manifest
    const tasks: TaskSpec[] = []
    for (const parent of snapshot.tasks) {
      if (parent.status !== "completed") continue
      for (const [index, proposal] of (parent.result?.proposedTasks ?? []).entries()) {
        const depth = parent.depth + 1
        if (depth > budgets.maxDepth) continue
        const key = `spawn:${parent.id}:${index}`
        if (existing.has(key)) continue
        // Checked once by the controller when the result was accepted, and
        // again here: neither check is the only one.
        if (!evaluateScope(scope, proposal.target).allowed) continue
        const capabilities = grantedFor(scope.capabilities, proposal.capabilities)
        if (!capabilities.length) continue
        existing.add(key)
        tasks.push({
          id: `T-SPAWN-${parent.id}-${index}`,
          key,
          parentTaskId: parent.id,
          role: proposal.role,
          objective: proposal.objective,
          target: proposal.target,
          capabilities,
          dependencies: [parent.id],
          depth,
          expectedOutput: proposal.role === "recon"
            ? "inventory"
            : proposal.role === "validator" ? "validation" : "assessment",
          ...(proposal.skillId ? { skillId: proposal.skillId } : {}),
        })
        if (tasks.length >= this.#maxAssessmentTasks) return tasks
      }
    }
    return tasks
  }

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
        capabilities: withOptional(
          snapshot.manifest.scope.capabilities,
          grantedFor(snapshot.manifest.scope.capabilities, skill.appliesTo.capabilities),
          ["knowledge.search", "http.crawl"],
        ),
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
    const discovered = discoveredTargets(snapshot)
    // A scope pattern is a statement about what is approved, not an endpoint.
    // Once recon has found the pages under it, they are what gets assessed —
    // otherwise the same page is assessed twice under two names, and one issue
    // is reported as two.
    const named = assessableTargets(snapshot)
      .filter((expression) => !supersededByDiscovery(expression, discovered))
    for (const expression of [...named, ...discovered]) {
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
            capabilities: withOptional(
              snapshot.manifest.scope.capabilities,
              grantedFor(snapshot.manifest.scope.capabilities, skill.appliesTo.capabilities),
              ["knowledge.search"],
            ),
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

/** Every target the loaded skills know how to look at. */
/** Roles whose job is to assess an asset, as opposed to inventory, verify, or write up. */
export function isAssessmentRole(role: TaskSpec["role"]): boolean {
  return role !== "recon" && role !== "validator" && role !== "reporter"
}

/** Every assessment task so far, so a validator waits for the specialists too. */
function assessmentDependencies(snapshot: EngagementSnapshot): string[] {
  return snapshot.tasks.filter((task) => isAssessmentRole(task.role)).map((task) => task.id)
}

function assessableTargets(snapshot: EngagementSnapshot): string[] {
  return snapshot.manifest.scope.targets.filter((expression) => {
    try {
      parseTarget(expression)
      return true
    } catch {
      return false
    }
  })
}

/**
 * Endpoints recon found, which the skills are then run against.
 *
 * The controller has already held every one of these to the manifest, and they
 * are checked again here: a planner that trusted a worker's list would be a
 * second way to widen an engagement, and the whole point of two checks is that
 * neither is the only one. The manifest's own targets come first, so a budget
 * that runs out spends itself on what the operator actually named.
 */
function discoveredTargets(snapshot: EngagementSnapshot): string[] {
  const named = new Set(snapshot.manifest.scope.targets)
  const found: string[] = []
  for (const task of snapshot.tasks) {
    if (task.role !== "recon" || task.status !== "completed") continue
    for (const observation of task.result?.observations ?? []) {
      for (const asset of observation.assets ?? []) {
        if (named.has(asset) || found.includes(asset)) continue
        if (!evaluateScope(snapshot.manifest.scope, asset).allowed) continue
        try {
          if (parseTarget(asset).kind === "repo") continue
        } catch {
          continue
        }
        found.push(asset)
      }
    }
  }
  return found
}

function supersededByDiscovery(expression: string, discovered: readonly string[]): boolean {
  if (!expression.endsWith("*")) return false
  const prefix = expression.slice(0, -1)
  return discovered.some((asset) => asset.startsWith(prefix))
}

/** Targets that can be requested over the network, for a report or a probe. */
function runtimeTargets(snapshot: EngagementSnapshot): string[] {
  return assessableTargets(snapshot).filter((expression) => parseTarget(expression).kind !== "repo")
}

function primaryTarget(snapshot: EngagementSnapshot): string {
  // The reporter names a runtime target when there is one; a repository-only
  // engagement reports against its root.
  return runtimeTargets(snapshot)[0] ?? assessableTargets(snapshot)[0] ?? snapshot.manifest.scope.targets[0] ?? ""
}

function dependenciesFor(snapshot: EngagementSnapshot, roles: readonly TaskSpec["role"][]): string[] {
  return snapshot.tasks.filter((task) => roles.includes(task.role)).map((task) => task.id)
}

/**
 * A task may only ask for capabilities the manifest already granted.
 *
 * When none of what it wanted was granted, it falls back to something that was:
 * a task spec needs at least one capability, and asking for one the manifest
 * refused would be rejected by the controller before it ever ran. The reporter
 * is the usual case — it renders from records and needs no capability at all.
 */
/**
 * Adds retrieval to a task when the manifest granted it.
 *
 * Knowledge is an addition to a methodology, never a precondition for one: a
 * skill that required a corpus would stop applying on a machine that never ran
 * `cyrion knowledge sync`, which would make coverage depend on whether an
 * operator downloaded a standard. The skill states what it needs; this states
 * what the engagement also allows.
 */
/**
 * Capabilities a role can use without a skill asking for them.
 *
 * A skill states the methodology, not the machinery. Retrieval and endpoint
 * discovery are machinery: requiring them in `appliesTo` would make a skill stop
 * applying wherever an operator had not granted them, which is coverage
 * depending on configuration rather than on what a target is.
 */
function withOptional(
  granted: readonly string[],
  capabilities: readonly string[],
  optional: readonly string[],
): string[] {
  const extra = optional.filter((capability) => granted.includes(capability) && !capabilities.includes(capability))
  return [...capabilities, ...extra]
}

function grantedFor(granted: readonly string[], wanted: readonly string[]): string[] {
  const allowed = wanted.filter((capability) => granted.includes(capability))
  if (allowed.length) return allowed
  return granted.length ? [granted[0]!] : [...wanted].slice(0, 1)
}

function delegate(rationale: string, tasks: TaskSpec[]): RootDecision {
  return { version: CONTRACT_VERSION, action: { kind: "delegate", rationale, tasks } }
}
