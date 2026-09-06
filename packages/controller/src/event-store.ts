import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Database } from "bun:sqlite"
import type { CyrionEvent, EngagementSnapshot, EventType } from "@cyrion/contracts"

export type EventDraft<T = unknown> = Omit<CyrionEvent<T>, "sequence" | "id" | "timestamp">
export type EventListener = (event: CyrionEvent) => void

export interface EngagementStore {
  append<T>(draft: EventDraft<T>): CyrionEvent<T>
  list(type?: EventType): CyrionEvent[]
  subscribe(listener: EventListener): () => void
  loadSnapshot(): EngagementSnapshot | undefined
  saveSnapshot(snapshot: EngagementSnapshot): void
  close(): void
}

export class MemoryEventStore implements EngagementStore {
  readonly #events: CyrionEvent[] = []
  readonly #listeners = new Set<EventListener>()
  #snapshot?: EngagementSnapshot

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

  loadSnapshot(): EngagementSnapshot | undefined {
    return this.#snapshot ? structuredClone(this.#snapshot) : undefined
  }

  saveSnapshot(snapshot: EngagementSnapshot): void {
    this.#snapshot = snapshotForStorage(snapshot)
  }

  close(): void {}
}

interface EventRow {
  sequence: number
  id: string
  engagement_id: string
  type: EventType
  timestamp: string
  agent_id: string | null
  task_id: string | null
  payload_json: string
}

export class SQLiteEngagementStore implements EngagementStore {
  readonly #database: Database
  readonly #engagementId: string
  readonly #listeners = new Set<EventListener>()

  constructor(path: string, engagementId: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.#database = new Database(path, { create: true, strict: true })
    if (path !== ":memory:") chmodSync(path, 0o600)
    this.#engagementId = engagementId
    this.#database.exec("PRAGMA journal_mode = WAL")
    this.#database.exec("PRAGMA foreign_keys = ON")
    this.#database.exec("PRAGMA busy_timeout = 5000")
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS engagement_snapshots (
        engagement_id TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS engagement_events (
        engagement_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        agent_id TEXT,
        task_id TEXT,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (engagement_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS event_task_idx ON engagement_events (engagement_id, task_id);
    `)
  }

  append<T>(draft: EventDraft<T>): CyrionEvent<T> {
    if (draft.engagementId !== this.#engagementId) throw new Error("Event engagement does not match store")
    const event = this.#database.transaction((): CyrionEvent<T> => {
      const next = this.#database
        .query<{ sequence: number }, [string]>(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM engagement_events WHERE engagement_id = ?",
        )
        .get(this.#engagementId)?.sequence ?? 1
      const created: CyrionEvent<T> = {
        ...draft,
        sequence: next,
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
      }
      this.#database
        .query(`
          INSERT INTO engagement_events (
            engagement_id, sequence, id, type, timestamp, agent_id, task_id, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          created.engagementId,
          created.sequence,
          created.id,
          created.type,
          created.timestamp,
          created.agentId ?? null,
          created.taskId ?? null,
          JSON.stringify(created.payload),
        )
      return created
    }).immediate()
    for (const listener of this.#listeners) listener(event)
    return event
  }

  list(type?: EventType): CyrionEvent[] {
    const rows = type
      ? this.#database
        .query<EventRow, [string, EventType]>(
          "SELECT * FROM engagement_events WHERE engagement_id = ? AND type = ? ORDER BY sequence",
        )
        .all(this.#engagementId, type)
      : this.#database
        .query<EventRow, [string]>(
          "SELECT * FROM engagement_events WHERE engagement_id = ? ORDER BY sequence",
        )
        .all(this.#engagementId)
    return rows.map(rowToEvent)
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  loadSnapshot(): EngagementSnapshot | undefined {
    const row = this.#database
      .query<{ snapshot_json: string }, [string]>(
        "SELECT snapshot_json FROM engagement_snapshots WHERE engagement_id = ?",
      )
      .get(this.#engagementId)
    return row ? JSON.parse(row.snapshot_json) as EngagementSnapshot : undefined
  }

  saveSnapshot(snapshot: EngagementSnapshot): void {
    if (snapshot.manifest.id !== this.#engagementId) throw new Error("Snapshot engagement does not match store")
    this.#database
      .query(`
        INSERT INTO engagement_snapshots (engagement_id, snapshot_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(engagement_id) DO UPDATE SET
          snapshot_json = excluded.snapshot_json,
          updated_at = excluded.updated_at
      `)
      .run(this.#engagementId, JSON.stringify(snapshotForStorage(snapshot)), new Date().toISOString())
  }

  close(): void {
    this.#database.close()
  }
}

function snapshotForStorage(snapshot: EngagementSnapshot): EngagementSnapshot {
  return structuredClone({ ...snapshot, events: [] })
}

function rowToEvent(row: EventRow): CyrionEvent {
  return {
    sequence: row.sequence,
    id: row.id,
    engagementId: row.engagement_id,
    type: row.type,
    timestamp: row.timestamp,
    payload: JSON.parse(row.payload_json),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
  }
}
