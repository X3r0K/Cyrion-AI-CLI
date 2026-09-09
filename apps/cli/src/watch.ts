import type { EngagementSnapshot } from "@cyrion/contracts"
import type { SQLiteEngagementStore } from "@cyrion/controller"

/**
 * The subset of a controller the terminal actually uses.
 *
 * Naming it lets a read-only watcher stand in for the real thing without the
 * terminal learning a second way to render an engagement.
 */
export interface EngagementSurface {
  readonly snapshot: EngagementSnapshot
  readonly events: { subscribe(listener: () => void): () => void }
  run(): Promise<EngagementSnapshot>
  cancel(): Promise<void>
  pause(): void
  resume(): void
  approvePending(): boolean
  denyPending(reason?: string): boolean
  operatorMessage(content: string): void
  close(): void
}

export interface WatchOptions {
  /** How often the durable store is re-read. */
  intervalMs?: number
  /** Stops on its own once the engagement reaches a terminal state. */
  untilFinished?: boolean
}

const TERMINAL = new Set(["completed", "failed", "cancelled"])

/**
 * A read-only attachment to an engagement someone else is running.
 *
 * It reads the durable store and nothing more: every operator control is a
 * refusal, because a second process reaching into a running engagement is
 * exactly the kind of thing the controller exists to prevent. What the watcher
 * sees is what was recorded, which is also what a report will say.
 */
export class WatchedEngagement implements EngagementSurface {
  readonly #store: SQLiteEngagementStore
  readonly #intervalMs: number
  readonly #untilFinished: boolean
  readonly #listeners = new Set<() => void>()
  #current: EngagementSnapshot
  #timer: ReturnType<typeof setInterval> | undefined
  #stopped = false
  #resolve: ((snapshot: EngagementSnapshot) => void) | undefined
  /** Set when the operator tried to steer an engagement they are only watching. */
  refusal: string | undefined

  constructor(store: SQLiteEngagementStore, initial: EngagementSnapshot, options: WatchOptions = {}) {
    this.#store = store
    this.#current = { ...initial, events: store.list() }
    this.#intervalMs = Math.max(100, options.intervalMs ?? 500)
    this.#untilFinished = options.untilFinished ?? false
  }

  get snapshot(): EngagementSnapshot {
    return this.#current
  }

  get events(): { subscribe(listener: () => void): () => void } {
    return {
      subscribe: (listener: () => void) => {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
      },
    }
  }

  /** Polls until the watcher is closed, or the engagement finishes. */
  async run(): Promise<EngagementSnapshot> {
    if (this.#stopped) return this.#current
    return new Promise<EngagementSnapshot>((resolve) => {
      this.#resolve = resolve
      this.#timer = setInterval(() => this.#poll(), this.#intervalMs)
      this.#poll()
    })
  }

  async cancel(): Promise<void> {
    this.#finish()
  }

  pause(): void {
    this.refusal = "This engagement is being watched, not run here. Pause it where it was started."
  }

  resume(): void {
    this.refusal = "This engagement is being watched, not run here. Resume it where it was started."
  }

  approvePending(): boolean {
    this.refusal = "Approvals belong to the session running the engagement, not to a watcher."
    return false
  }

  denyPending(): boolean {
    this.refusal = "Approvals belong to the session running the engagement, not to a watcher."
    return false
  }

  operatorMessage(): void {
    this.refusal = "A watcher reads the record; it cannot send anything into the engagement."
  }

  close(): void {
    this.#finish()
    this.#store.close()
  }

  #poll(): void {
    if (this.#stopped) return
    const stored = this.#store.loadSnapshot()
    // A stored snapshot carries no event list — the events are their own table,
    // and the live views are built from them. Rejoining the two is what makes a
    // watcher see the run rather than only its totals.
    const next = stored ? { ...stored, events: this.#store.list() } : undefined
    if (next) {
      // Compare what a reader would notice, not object identity: the store
      // hands back a fresh object every time.
      const changed = next.events.length !== this.#current.events.length
        || next.status !== this.#current.status
        || next.findings.length !== this.#current.findings.length
        || next.tasks.length !== this.#current.tasks.length
      this.#current = next
      if (changed) for (const listener of this.#listeners) listener()
    }
    if (this.#untilFinished && TERMINAL.has(this.#current.status)) this.#finish()
  }

  #finish(): void {
    if (this.#stopped) return
    this.#stopped = true
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
    this.#resolve?.(this.#current)
    this.#resolve = undefined
  }
}
