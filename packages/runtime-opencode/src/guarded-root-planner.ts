import {
  CONTRACT_VERSION,
  type EngagementSnapshot,
  type ResourceUsage,
  type RootDecision,
  type RootPlanner,
} from "@cyrion/contracts"

export interface RootDecisionReview {
  verdict: "accept" | "stop"
  rationale: string
}

export interface RootDecisionReviewer {
  review(snapshot: EngagementSnapshot, proposal: RootDecision): Promise<RootDecisionReview>
  takeUsage?(): ResourceUsage | undefined
  close(): Promise<void>
}

/**
 * Lets a provider review one controller-generated transition without allowing
 * it to invent task identities, capabilities, targets, or dependencies.
 */
export class GuardedRootPlanner implements RootPlanner {
  readonly #policy: RootPlanner
  readonly #reviewer: RootDecisionReviewer

  constructor(policy: RootPlanner, reviewer: RootDecisionReviewer) {
    this.#policy = policy
    this.#reviewer = reviewer
  }

  async decide(snapshot: EngagementSnapshot): Promise<RootDecision> {
    const proposal = await this.#policy.decide(snapshot)
    const review = await this.#reviewer.review(snapshot, proposal)
    if (review.verdict === "stop") {
      return {
        version: CONTRACT_VERSION,
        action: { kind: "stop", reason: "policy", rationale: review.rationale },
      }
    }
    return {
      ...proposal,
      action: { ...proposal.action, rationale: review.rationale },
    }
  }

  takeUsage(): ResourceUsage | undefined {
    return this.#reviewer.takeUsage?.()
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.#policy.close(), this.#reviewer.close()])
  }
}
