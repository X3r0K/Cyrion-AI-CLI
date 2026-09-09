import { DEFAULT_ENGAGEMENT_LIMITS, type EngagementLimits } from "@cyrion/contracts"
import { tryParseTarget } from "@cyrion/scope"

/**
 * Paces every tool request by the host it reaches.
 *
 * The controller's budgets already bound an engagement: how many agents, how
 * many tasks, how long, how much. None of them bound what any single machine is
 * asked to absorb, and that is the number a target operator actually feels. Ten
 * workers inside every budget are still ten simultaneous scanners if they all
 * pick the same endpoint, so the limit that matters is per host and shared by
 * every agent — one limiter for the engagement, not one per worker.
 *
 * Waiting is the normal outcome. A request that would exceed the pace is held
 * until it may go, because refusing legitimate work to keep a rate would just
 * move the problem into the findings. Refusal is kept for the two cases where
 * holding would be dishonest: a host that has spent its whole request ceiling,
 * and a queue so deep that the operator is owed the word "refused" rather than
 * a run that appears to have stalled.
 */
export interface TargetLease {
  /** Milliseconds this request spent held before it was allowed to leave. */
  waitedMs: number
  /** Returns the slot. Safe to call more than once. */
  release(): void
}

interface HostState {
  inFlight: number
  used: number
  /** Earliest a request to this host may start, advanced as slots are reserved. */
  nextAt: number
  waiting: (() => void)[]
}

/**
 * The unit a limit is counted against.
 *
 * A hostname, because that is what receives the traffic. Two tasks aimed at
 * `/orders` and `/invoices` of one origin have not found two machines to talk
 * to, and keying on the target expression would let a planner pace itself out
 * of every limit simply by naming more paths. A repository target reaches no
 * host at all and is left unpaced: reading files off a disk is not a swarm.
 */
export function limitKeyFor(target: string): string | undefined {
  const parsed = tryParseTarget(target)
  if (typeof parsed === "string") return target.trim().toLowerCase() || undefined
  if (parsed.kind === "repo") return undefined
  return parsed.host
}

export class TargetLimiter {
  readonly #limits: EngagementLimits
  readonly #hosts = new Map<string, HostState>()

  constructor(limits: EngagementLimits = DEFAULT_ENGAGEMENT_LIMITS) {
    this.#limits = { ...limits }
  }

  get limits(): EngagementLimits {
    return { ...this.#limits }
  }

  /** Requests this host has already been sent, for a report or a status line. */
  usedFor(target: string): number {
    const key = limitKeyFor(target)
    return key ? (this.#hosts.get(key)?.used ?? 0) : 0
  }

  /**
   * Holds the caller until its request may reach the host, or explains why it
   * never may. The returned lease must be released once the call is finished,
   * including when it fails — an unreleased slot would quietly narrow the cap
   * for the rest of the engagement.
   */
  async acquire(target: string): Promise<TargetLease> {
    const key = limitKeyFor(target)
    if (!key) return { waitedMs: 0, release: () => {} }
    const state = this.#hosts.get(key) ?? { inFlight: 0, used: 0, nextAt: 0, waiting: [] }
    this.#hosts.set(key, state)

    const started = Date.now()
    const deadline = started + this.#limits.maxQueueWaitMs

    if (state.used >= this.#limits.maxRequestsPerTarget) {
      throw new Error(
        `Per-target request limit reached for ${key}: ` +
        `${this.#limits.maxRequestsPerTarget} requests already sent (limits.maxRequestsPerTarget)`,
      )
    }

    // FIFO, so a worker that queued first is not starved by one that queued
    // later. Fairness is not a nicety here: an unfair queue under a tight cap
    // turns into a task that never runs and a finding nobody looked for.
    while (state.inFlight >= this.#limits.maxConcurrentPerTarget) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new Error(
          `Timed out waiting to contact ${key}: ${this.#limits.maxConcurrentPerTarget} requests already in ` +
          `flight after ${this.#limits.maxQueueWaitMs} ms (limits.maxConcurrentPerTarget)`,
        )
      }
      await this.#waitForSlot(state, remaining)
    }

    // Re-check under the reservation: the ceiling may have been spent by calls
    // that were in flight while this one queued.
    if (state.used >= this.#limits.maxRequestsPerTarget) {
      throw new Error(
        `Per-target request limit reached for ${key}: ` +
        `${this.#limits.maxRequestsPerTarget} requests already sent (limits.maxRequestsPerTarget)`,
      )
    }

    const now = Date.now()
    const at = Math.max(now, state.nextAt)
    if (at > deadline) {
      throw new Error(
        `Timed out waiting to contact ${key}: the ${this.#limits.minRequestGapMs} ms request gap put this call ` +
        `${at - now} ms out, past the ${this.#limits.maxQueueWaitMs} ms wait (limits.minRequestGapMs)`,
      )
    }

    // The reservation is taken before sleeping, not after. Two callers that
    // both looked at the clock and then both slept would wake together and
    // arrive as one burst, which is the exact thing the gap exists to prevent.
    state.nextAt = at + this.#limits.minRequestGapMs
    state.inFlight += 1
    state.used += 1

    if (at > now) await sleep(at - now)

    let released = false
    return {
      waitedMs: Date.now() - started,
      release: () => {
        if (released) return
        released = true
        state.inFlight -= 1
        state.waiting.shift()?.()
      },
    }
  }

  #waitForSlot(state: HostState, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false
      const wake = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      // The waiter is dropped from the queue on timeout as well as on wake, so
      // a released slot is never handed to a caller that has already given up.
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const index = state.waiting.indexOf(wake)
        if (index >= 0) state.waiting.splice(index, 1)
        resolve()
      }, timeoutMs)
      state.waiting.push(wake)
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
