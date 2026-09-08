import {
  CONTRACT_VERSION,
  type EngagementSnapshot,
  type ResourceUsage,
  type RootDecision,
  type RootDecisionReview,
  type RootDecisionReviewer,
  type RootPlanner,
} from "@cyrion/contracts"

export type { RootDecisionReview, RootDecisionReviewer } from "@cyrion/contracts"

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
