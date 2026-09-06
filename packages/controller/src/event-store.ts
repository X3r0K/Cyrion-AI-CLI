import type { CyrionEvent, EventType } from "@cyrion/contracts"

export type EventDraft<T = unknown> = Omit<CyrionEvent<T>, "sequence" | "id" | "timestamp">
export type EventListener = (event: CyrionEvent) => void

export class MemoryEventStore {
  readonly #events: CyrionEvent[] = []
  readonly #listeners = new Set<EventListener>()

  append<T>(draft: EventDraft<T>): CyrionEvent<T> {
    const event: CyrionEvent<T> = {
      ...draft,
      sequence: this.#events.length + 1,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    }
    this.#events.push(event)
    for (const listener of this.#listeners) listener(event)
    return event
  }

  list(type?: EventType): CyrionEvent[] {
    return type ? this.#events.filter((event) => event.type === type) : [...this.#events]
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
}
