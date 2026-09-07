import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  CONTRACT_VERSION,
  assertManifest,
  type EngagementSnapshot,
  type RootDecision,
  type RootPlanner,
} from "@cyrion/contracts"
import {
  GuardedRootPlanner,
  type RootDecisionReview,
  type RootDecisionReviewer,
} from "@cyrion/runtime-opencode"

const projectRoot = join(import.meta.dir, "..")

describe("guarded OpenCode Root planning", () => {
  test("preserves controller-owned task fields while accepting provider rationale", async () => {
    const proposal = delegateProposal()
    const policy = plannerFor(proposal)
    const reviewer = reviewerFor({ verdict: "accept", rationale: "The bounded inventory step is appropriate." })
    const planner = new GuardedRootPlanner(policy, reviewer)

    const decision = await planner.decide(await snapshot())

    expect(decision.action.kind).toBe("delegate")
    if (decision.action.kind !== "delegate") throw new Error("expected delegation")
    expect(decision.action.tasks).toEqual(proposal.action.kind === "delegate" ? proposal.action.tasks : [])
    expect(decision.action.rationale).toBe("The bounded inventory step is appropriate.")
    expect(planner.takeUsage()).toEqual({ inputTokens: 12, outputTokens: 4, costUsd: 0.001 })
    await planner.close()
    expect(policy.closed).toBe(true)
    expect(reviewer.closed).toBe(true)
  })

  test("converts a provider veto into a bounded policy stop", async () => {
    const planner = new GuardedRootPlanner(
      plannerFor(delegateProposal()),
      reviewerFor({ verdict: "stop", rationale: "The transition should not proceed." }),
    )
    const decision = await planner.decide(await snapshot())
    expect(decision).toEqual({
      version: CONTRACT_VERSION,
      action: { kind: "stop", reason: "policy", rationale: "The transition should not proceed." },
    })
  })
})

function plannerFor(decision: RootDecision): RootPlanner & { closed: boolean } {
  return {
    closed: false,
    async decide() { return structuredClone(decision) },
    async close() { this.closed = true },
  }
}

function reviewerFor(review: RootDecisionReview): RootDecisionReviewer & { closed: boolean } {
  return {
    closed: false,
    async review() { return structuredClone(review) },
    takeUsage() { return { inputTokens: 12, outputTokens: 4, costUsd: 0.001 } },
    async close() { this.closed = true },
  }
}

function delegateProposal(): RootDecision {
  return {
    version: CONTRACT_VERSION,
    action: {
      kind: "delegate",
      rationale: "Create the approved inventory.",
      tasks: [{
        id: "T-001",
        key: "recon:demo.lab.test",
        role: "recon",
        objective: "Inventory the approved fixture assets.",
        target: "demo.lab.test",
        capabilities: ["fixture.read"],
        dependencies: [],
        depth: 1,
        expectedOutput: "inventory",
      }],
    },
  }
}

async function snapshot(): Promise<EngagementSnapshot> {
  const manifest: unknown = await Bun.file(join(projectRoot, "fixtures/demo/engagement.json")).json()
  assertManifest(manifest)
  return {
    manifest,
    status: "running",
    agents: [],
    tasks: [],
    findings: [],
    evidence: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    events: [],
  }
}
