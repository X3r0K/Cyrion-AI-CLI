import { describe, expect, test } from "bun:test"
import {
  MAX_TASK_PROPOSALS,
  WORKER_ROLES,
  taskProposalContractError,
  workerResultContractError,
  type EngagementSnapshot,
  type TaskProposal,
  type TaskRecord,
  type WorkerResult,
} from "@cyrion/contracts"
import { workerResultPolicyError } from "@cyrion/controller"
import { AssessmentRootPlanner, isAssessmentRole } from "@cyrion/assessment"

const scope = {
  targets: ["https://app.lab.test/"],
  excluded: [],
  capabilities: ["http.probe", "http.request", "shell.exec"],
}

function proposal(overrides: Partial<TaskProposal> = {}): TaskProposal {
  return {
    role: "injection",
    objective: "Test the login form for injection.",
    target: "https://app.lab.test/login",
    capabilities: ["http.request"],
    rationale: "The recon pass found a form that reflects its input.",
    ...overrides,
  }
}

function result(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    summary: "Assessed the approved origin.",
    observations: [],
    findings: [],
    evidence: [],
    ...overrides,
  }
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "T-WEB-1",
    key: "web:https://app.lab.test/",
    role: "web",
    objective: "Assess the approved origin.",
    target: "https://app.lab.test/",
    capabilities: ["http.probe"],
    dependencies: [],
    depth: 1,
    expectedOutput: "assessment",
    status: "completed",
    inputHash: "hash",
    attempt: 1,
    agentId: "web-1",
    ...overrides,
  }
}

function snapshot(tasks: TaskRecord[], maxDepth = 3): EngagementSnapshot {
  return {
    manifest: {
      id: "ENG-GRAPH",
      name: "Graph",
      objective: "Assess the approved surface.",
      profile: "web-api",
      mode: "autonomous",
      scope,
      budgets: {
        maxConcurrentAgents: 3,
        maxAgents: 40,
        maxDepth,
        maxTasks: 40,
        maxDurationMs: 600_000,
        maxTokens: 100_000,
        maxCostUsd: 2,
      },
    },
    status: "running",
    agents: [],
    tasks,
    observations: [],
    findings: [],
    evidence: [],
    events: [],
    budgetUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    startedAt: new Date().toISOString(),
  } as unknown as EngagementSnapshot
}

describe("a worker proposing work", () => {
  test("states a lens and an objective, and nothing that decides its own place", () => {
    expect(taskProposalContractError(proposal())).toBeUndefined()
    // No id, no parent, no depth: a proposer that could set those could spawn
    // forever, or hide which task a request came from.
    for (const field of ["id", "depth", "parentTaskId"]) {
      expect(taskProposalContractError({ ...proposal(), [field]: 1 }))
        .toContain(`unexpected field ${field}`)
    }
    expect(taskProposalContractError({ ...proposal(), role: "root" })).toContain("role is unsupported")
  })

  test("rides on a worker result, bounded in number", () => {
    expect(workerResultContractError(result({ proposedTasks: [proposal()] }))).toBeUndefined()
    const flood = Array.from({ length: MAX_TASK_PROPOSALS + 1 }, () => proposal())
    expect(workerResultContractError(result({ proposedTasks: flood })))
      .toContain("proposedTasks limit exceeded")
  })

  test("the specialist roles a delegation can name", () => {
    for (const role of ["injection", "xss", "ssrf", "auth", "authz", "idor", "race", "logic"]) {
      expect(WORKER_ROLES).toContain(role as never)
      expect(taskProposalContractError(proposal({ role: role as TaskProposal["role"] }))).toBeUndefined()
      // A lens, not a permission: every specialist still returns an assessment.
      expect(isAssessmentRole(role as TaskProposal["role"])).toBe(true)
    }
    expect(isAssessmentRole("recon")).toBe(false)
    expect(isAssessmentRole("validator")).toBe(false)
  })
})

describe("what the controller refuses to be asked for", () => {
  const parent = task()

  test("a target the manifest never approved fails the whole result", () => {
    const error = workerResultPolicyError(
      result({ proposedTasks: [proposal({ target: "https://elsewhere.test/" })] }),
      parent,
      snapshot([parent]),
      "web-1",
    )
    expect(error).toContain("outside the approved scope")
  })

  test("a capability the manifest never granted is refused by name", () => {
    const error = workerResultPolicyError(
      result({ proposedTasks: [proposal({ capabilities: ["poc.run"] })] }),
      parent,
      snapshot([parent]),
      "web-1",
    )
    expect(error).toContain("ungranted capability: poc.run")
  })

  test("a worker cannot delegate the report", () => {
    const error = workerResultPolicyError(
      result({ proposedTasks: [proposal({ role: "reporter" })] }),
      parent,
      snapshot([parent]),
      "web-1",
    )
    expect(error).toContain("may not delegate the report")
  })

  test("a proposal that stays inside the manifest is accepted", () => {
    expect(workerResultPolicyError(
      result({ proposedTasks: [proposal()] }),
      parent,
      snapshot([parent]),
      "web-1",
    )).toBeUndefined()
  })
})

describe("the graph the planner builds from proposals", () => {
  const planner = new AssessmentRootPlanner({ skills: [] })

  function completedWith(proposals: TaskProposal[], depth = 1, maxDepth = 3) {
    const parent = task({ depth, result: result({ proposedTasks: proposals }) })
    const recon = task({ id: "T-RECON-1", key: "recon:x", role: "recon", expectedOutput: "inventory" })
    return snapshot([recon, parent], maxDepth)
  }

  test("dispatches the follow-up one level below the task that asked", async () => {
    const decision = await planner.decide(completedWith([proposal()]))
    expect(decision.action.kind).toBe("delegate")
    const tasks = decision.action.kind === "delegate" ? decision.action.tasks : []
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.role).toBe("injection")
    // Assigned by the planner from the parent, never taken from the proposal.
    expect(tasks[0]?.depth).toBe(2)
    expect(tasks[0]?.parentTaskId).toBe("T-WEB-1")
    expect(tasks[0]?.dependencies).toEqual(["T-WEB-1"])
  })

  test("drops a proposal that would exceed the manifest's depth", async () => {
    // Dropped rather than clamped: running something shallower than was asked
    // for would make the delegation tree lie about what happened.
    const decision = await planner.decide(completedWith([proposal()], 3, 3))
    const tasks = decision.action.kind === "delegate" ? decision.action.tasks : []
    expect(tasks.filter((entry) => entry.role === "injection")).toHaveLength(0)
  })

  test("narrows the capabilities to the grant a second time", async () => {
    const decision = await planner.decide(completedWith([
      proposal({ capabilities: ["http.request", "net.portscan"] }),
    ]))
    const tasks = decision.action.kind === "delegate" ? decision.action.tasks : []
    expect(tasks[0]?.capabilities).toEqual(["http.request"])
  })

  test("dispatches each proposal once, however often the snapshot is read", async () => {
    const state = completedWith([proposal()])
    const first = await planner.decide(state)
    const dispatched = first.action.kind === "delegate" ? first.action.tasks : []
    const withSpawned = snapshot([
      ...state.tasks,
      task({ ...dispatched[0]!, status: "running", inputHash: "h", attempt: 1 }),
    ])
    const second = await planner.decide(withSpawned)
    const again = second.action.kind === "delegate" ? second.action.tasks : []
    expect(again.filter((entry) => entry.key === dispatched[0]!.key)).toHaveLength(0)
  })
})
