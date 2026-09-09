import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngagementSnapshot } from "@cyrion/contracts"
import { SQLiteEngagementStore } from "@cyrion/controller"
import { WatchedEngagement } from "../apps/cli/src/watch"

function snapshot(status: EngagementSnapshot["status"] = "running"): EngagementSnapshot {
  return {
    manifest: {
      id: "ENG-WATCH",
      name: "w",
      objective: "o",
      profile: "web-api",
      mode: "autonomous",
      scope: { targets: ["https://app.lab.test/"], excluded: [], capabilities: ["http.probe"] },
      budgets: {
        maxConcurrentAgents: 1, maxAgents: 4, maxDepth: 2, maxTasks: 4,
        maxDurationMs: 60_000, maxTokens: 100, maxCostUsd: 1,
      },
    },
    status,
    startedAt: "2026-09-08T00:00:00.000Z",
    agents: [],
    tasks: [],
    findings: [],
    evidence: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    events: [],
  }
}

describe("watching an engagement someone else is running", () => {
  test("sees the event stream, not only the totals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyrion-watch-"))
    try {
      const path = join(directory, "state.sqlite")
      const writer = new SQLiteEngagementStore(path, "ENG-WATCH")
      writer.saveSnapshot(snapshot())
      writer.append({ engagementId: "ENG-WATCH", type: "engagement.started", payload: {} })

      const reader = new SQLiteEngagementStore(path, "ENG-WATCH")
      const watcher = new WatchedEngagement(reader, reader.loadSnapshot()!, { intervalMs: 100 })
      try {
        // A stored snapshot carries no events; the watcher rejoins them.
        expect(watcher.snapshot.events).toHaveLength(1)

        const changes: number[] = []
        const unsubscribe = watcher.events.subscribe(() => changes.push(watcher.snapshot.events.length))
        void watcher.run()

        writer.append({ engagementId: "ENG-WATCH", type: "task.started", payload: {} })
        await Bun.sleep(400)
        unsubscribe()
        expect(changes.at(-1)).toBe(2)
      } finally {
        watcher.close()
        writer.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)

  test("refuses every control rather than reaching into a running engagement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyrion-watch-ro-"))
    try {
      const path = join(directory, "state.sqlite")
      const writer = new SQLiteEngagementStore(path, "ENG-WATCH")
      writer.saveSnapshot(snapshot())
      writer.close()

      const reader = new SQLiteEngagementStore(path, "ENG-WATCH")
      const watcher = new WatchedEngagement(reader, reader.loadSnapshot()!)
      try {
        expect(watcher.approvePending()).toBe(false)
        expect(watcher.refusal).toContain("Approvals belong to the session running")
        watcher.pause()
        expect(watcher.refusal).toContain("watched, not run here")
        watcher.operatorMessage()
        expect(watcher.refusal).toContain("cannot send anything into the engagement")
        expect(watcher.denyPending()).toBe(false)
      } finally {
        watcher.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("stops on its own once the engagement reaches a terminal state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyrion-watch-end-"))
    try {
      const path = join(directory, "state.sqlite")
      const writer = new SQLiteEngagementStore(path, "ENG-WATCH")
      writer.saveSnapshot(snapshot("completed"))
      writer.close()

      const reader = new SQLiteEngagementStore(path, "ENG-WATCH")
      const watcher = new WatchedEngagement(reader, reader.loadSnapshot()!, {
        intervalMs: 100,
        untilFinished: true,
      })
      const result = await watcher.run()
      expect(result.status).toBe("completed")
      watcher.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)
})
