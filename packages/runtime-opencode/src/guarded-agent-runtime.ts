import {
  assertWorkerResult,
  type AgentRuntime,
  type ResourceUsage,
  type RuntimeContext,
  type TaskSpec,
  type WorkerResult,
} from "@cyrion/contracts"

export interface WorkerResultReview {
  verdict: "accept" | "flag"
  summary: string
}

export interface WorkerReviewOutcome {
  review: WorkerResultReview
  usage: ResourceUsage
}

export interface WorkerResultReviewer {
  reviewTask(task: TaskSpec, context: RuntimeContext, result: WorkerResult): Promise<WorkerReviewOutcome>
  cancel(agentId: string): Promise<void>
  close(): Promise<void>
}

/**
 * Executes a canonical scoped worker first, then lets a provider review only
 * its public result. Findings, evidence, report content, and provenance remain
 * byte-for-byte controller inputs from the canonical worker.
 */
export class GuardedAgentRuntime implements AgentRuntime {
  readonly #runtime: AgentRuntime
  readonly #reviewer: WorkerResultReviewer

  constructor(runtime: AgentRuntime, reviewer: WorkerResultReviewer) {
    this.#runtime = runtime
    this.#reviewer = reviewer
  }

  async runTask(task: TaskSpec, context: RuntimeContext): Promise<WorkerResult> {
    const canonical = await this.#runtime.runTask(task, context)
    assertWorkerResult(canonical)
    const { review, usage } = await this.#reviewer.reviewTask(task, context, canonical)
    const label = review.verdict === "flag" ? "PROVIDER FLAG" : "PROVIDER REVIEW"
    const summary = boundedSummary(`${canonical.summary}\n[${label}] ${review.summary}`)
    return {
      ...canonical,
      summary,
      usage: addUsage(canonical.usage, usage),
    }
  }

  async cancel(agentId: string): Promise<void> {
    await Promise.allSettled([this.#runtime.cancel(agentId), this.#reviewer.cancel(agentId)])
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.#runtime.close(), this.#reviewer.close()])
  }
}

function addUsage(left: ResourceUsage | undefined, right: ResourceUsage): ResourceUsage {
  return {
    inputTokens: (left?.inputTokens ?? 0) + right.inputTokens,
    outputTokens: (left?.outputTokens ?? 0) + right.outputTokens,
    costUsd: (left?.costUsd ?? 0) + right.costUsd,
  }
}

function boundedSummary(value: string): string {
  return value.length <= 16_384 ? value : value.slice(0, 16_384)
}
