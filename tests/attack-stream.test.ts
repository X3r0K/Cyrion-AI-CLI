import { describe, expect, test } from "bun:test"
import type { CyrionEvent, EngagementSnapshot } from "@cyrion/contracts"
import { outcomeOf } from "@cyrion/controller"
import type { Finding } from "@cyrion/contracts"
import { reportScanProgress } from "@cyrion/capabilities"
import { attackStream, scrollStream, windowOf } from "../apps/cli/src/attack-stream"
import { filterFindings } from "../apps/cli/src/navigation"
import { formatAttack, formatFindings } from "../apps/cli/src/format"

let sequence = 0
function event(type: CyrionEvent["type"], payload: unknown, agentId?: string, taskId?: string): CyrionEvent {
  sequence += 1
  return {
    sequence,
    id: `e${sequence}`,
    engagementId: "ENG-STREAM",
    type,
    timestamp: new Date(Date.UTC(2026, 8, 8, 0, 0, sequence)).toISOString(),
    ...(agentId ? { agentId } : {}),
    ...(taskId ? { taskId } : {}),
    payload,
  }
}

function snapshotWith(events: CyrionEvent[]): EngagementSnapshot {
  return {
    manifest: {
      id: "ENG-STREAM",
      name: "s",
      objective: "o",
      profile: "web-api",
      mode: "autonomous",
      scope: { targets: ["https://app.lab.test/"], excluded: [], capabilities: ["http.probe"] },
      budgets: {
        maxConcurrentAgents: 2, maxAgents: 8, maxDepth: 2, maxTasks: 8,
        maxDurationMs: 60_000, maxTokens: 100, maxCostUsd: 1,
      },
    },
    status: "running",
    startedAt: "2026-09-08T00:00:00.000Z",
    agents: [{ id: "web-t-1", role: "web", name: "web-01", status: "running" }],
    tasks: [{
      id: "T-1",
      key: "web:1",
      role: "web",
      objective: "Check the headers.",
      target: "https://app.lab.test/",
      capabilities: ["http.probe"],
      dependencies: [],
      depth: 1,
      expectedOutput: "assessment",
      skillId: "web-security-headers",
      status: "running",
      inputHash: "h",
      attempt: 1,
    }],
    findings: [],
    evidence: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    events,
  }
}

describe("the live transcript", () => {
  test("keeps the exchange and drops the bookkeeping", () => {
    const lines = attackStream(snapshotWith([
      event("task.heartbeat", { heartbeatAt: "x" }, "web-t-1", "T-1"),
      event("task.lease.acquired", {}, "web-t-1", "T-1"),
      event("budget.updated", {}, "web-t-1"),
      event("tool.request.accepted", { capability: "http.probe", target: "https://app.lab.test/" }, "web-t-1", "T-1"),
      event("tool.request.completed", {
        capability: "http.probe",
        target: "https://app.lab.test/",
        durationMs: 8,
        outcome: "200 text/html · 1.2 kB",
      }, "web-t-1", "T-1"),
    ]))
    // A reader watching a live run should not have to scroll past leases.
    expect(lines.map((line) => line.kind)).toEqual(["request", "answer"])
    expect(lines[1]).toEqual(expect.objectContaining({
      actor: "web-01",
      action: "http.probe",
      subject: "https://app.lab.test/",
      detail: "200 text/html · 1.2 kB",
      durationMs: 8,
    }))
  })

  test("shows a refusal with the reason it was refused", () => {
    const lines = attackStream(snapshotWith([
      event("tool.request.rejected", {
        capability: "http.probe",
        target: "https://elsewhere.test/",
        reason: "Tool target is outside the approved scope",
      }, "web-t-1", "T-1"),
    ]))
    expect(lines[0]).toEqual(expect.objectContaining({
      kind: "refusal",
      subject: "https://elsewhere.test/",
      detail: "Tool target is outside the approved scope",
    }))
  })

  test("narrates a finding through its verdicts", () => {
    const base = {
      id: "F-1",
      title: "Missing browser protection headers",
      asset: "https://app.lab.test/",
      severity: "low" as const,
      summary: "s",
      discoveredBy: "web-t-1",
      evidenceIds: ["E-1"],
    }
    const lines = attackStream(snapshotWith([
      event("finding.updated", { finding: { ...base, status: "candidate" } }, "web-t-1"),
      event("finding.updated", { finding: { ...base, status: "validating" } }, "root-agent"),
      event("finding.updated", { finding: { ...base, status: "confirmed" } }, "web-t-1"),
    ]))
    expect(lines.map((line) => line.action)).toEqual(["raised", "sent for validation", "confirmed"])
    expect(lines[2]!.severity).toBe("low")
  })

  test("names what a task worked on, not only its identifier", () => {
    const lines = attackStream(snapshotWith([
      event("task.started", {}, "web-t-1", "T-1"),
      event("task.completed", { summary: "Assessed the page." }, "web-t-1", "T-1"),
    ]))
    expect(lines[0]).toEqual(expect.objectContaining({ action: "began", subject: "https://app.lab.test/" }))
    expect(lines[1]).toEqual(expect.objectContaining({ action: "finished", subject: "https://app.lab.test/" }))
  })

  test("strips control characters out of target-derived text", () => {
    const lines = attackStream(snapshotWith([
      event("tool.request.rejected", {
        capability: "http.probe",
        target: "https://app.lab.test/",
        reason: "refused\u001b[31m by the target",
      }, "web-t-1", "T-1"),
    ]))
    expect(lines[0]!.detail).not.toContain("\u001b")
    expect(lines[0]!.detail).toContain("refused")
  })
})

describe("the outcome recorded on an event", () => {
  test("takes a bounded phrase and refuses anything else", () => {
    expect(outcomeOf({ outcome: "200 application/json" })).toBe("200 application/json")
    expect(outcomeOf({ outcome: "  " })).toBeUndefined()
    expect(outcomeOf({ outcome: 42 })).toBeUndefined()
    expect(outcomeOf(undefined)).toBeUndefined()
    // A target could answer with anything; the durable event stays short and clean.
    expect(outcomeOf({ outcome: "a".repeat(500) })).toHaveLength(200)
    expect(outcomeOf({ outcome: "200\u001b[2Jcleared" })).toBe("200 [2Jcleared")
  })
})

describe("scrolling the transcript", () => {
  const lines = Array.from({ length: 50 }, (_, index) => ({
    sequence: index,
    timestamp: new Date().toISOString(),
    kind: "answer" as const,
    actor: "web-01",
    action: `step ${index}`,
  }))

  test("following pins the view to the newest line", () => {
    const view = windowOf(lines, { height: 10, offset: 0, following: true })
    expect(view.offset).toBe(40)
    expect(view.lines[9]!.action).toBe("step 49")
    expect(view.total).toBe(50)
  })

  test("scrolling back releases the pin, and returning to the end restores it", () => {
    const up = scrollStream({ offset: 0, following: true }, -5, 50, 10)
    // A reader who went looking for something is not yanked to the end by the
    // next event.
    expect(up).toEqual({ offset: 35, following: false })
    expect(windowOf(lines, { height: 10, ...up }).lines[0]!.action).toBe("step 35")

    const back = scrollStream(up, 20, 50, 10)
    expect(back.following).toBe(true)
  })

  test("cannot scroll past either end", () => {
    expect(scrollStream({ offset: 0, following: false }, -100, 50, 10).offset).toBe(0)
    expect(scrollStream({ offset: 0, following: false }, 999, 50, 10).offset).toBe(40)
    // A stream shorter than the window has nowhere to scroll.
    expect(windowOf(lines.slice(0, 3), { height: 10, offset: 5, following: false }).offset).toBe(0)
  })
})

describe("rendering the transcript", () => {
  test("shows the request, the answer, and what came back", () => {
    const snapshot = snapshotWith([
      event("tool.request.accepted", { capability: "http.probe", target: "https://app.lab.test/" }, "web-t-1", "T-1"),
      event("tool.request.completed", {
        capability: "http.probe",
        target: "https://app.lab.test/",
        durationMs: 8,
        outcome: "200 text/html · 1.2 kB",
      }, "web-t-1", "T-1"),
    ])
    const lines = attackStream(snapshot)
    const text = formatAttack(snapshot, windowOf(lines, { height: 10, offset: 0, following: true }), 96)
      .chunks.map((chunk) => chunk.text).join("")

    expect(text).toContain("LIVE ACTIVITY")
    expect(text).toContain("FOLLOWING")
    expect(text).toContain("http.probe https://app.lab.test/")
    expect(text).toContain("200 text/html")
    expect(text).toContain("8ms")
  })

  test("says so when nothing has happened yet", () => {
    const text = formatAttack(snapshotWith([]), windowOf([], { height: 10, offset: 0, following: true }), 96)
      .chunks.map((chunk) => chunk.text).join("")
    expect(text).toContain("Nothing has happened yet")
  })
})

describe("progress from a long-running tool", () => {
  test("appears in the transcript while the tool is still working", () => {
    const lines = attackStream(snapshotWith([
      event("tool.request.accepted", { capability: "net.portscan", target: "10.0.0.0/24" }, "web-t-1", "T-1"),
      event("tool.request.progress", {
        capability: "net.portscan",
        target: "10.0.0.0/24",
        note: "10.0.0.7: 3 open port(s) so far",
      }, "web-t-1", "T-1"),
    ]))
    expect(lines.map((line) => line.kind)).toEqual(["request", "progress"])
    expect(lines[1]!.detail).toBe("10.0.0.7: 3 open port(s) so far")
  })

  test("summarises grepable output into something an operator reads", () => {
    const notes: string[] = []
    reportScanProgress(
      "Host: 10.0.0.7 ()\tPorts: 22/open/tcp//ssh///, 80/open/tcp//http///\n",
      (note) => notes.push(note),
    )
    expect(notes[0]).toBe("10.0.0.7: 2 open port(s) so far")

    // Anything else falls back to the last meaningful line, not the raw blob.
    notes.length = 0
    reportScanProgress("Starting Nmap 7.99\nScanning 10.0.0.0/24\n\n", (note) => notes.push(note))
    expect(notes[0]).toBe("Scanning 10.0.0.0/24")
  })
})

describe("filtering findings", () => {
  const findings = [
    { id: "F-1", title: "Missing browser protection headers", asset: "https://a.test/", severity: "low",
      status: "confirmed", summary: "s", discoveredBy: "w", evidenceIds: ["E-1"], skillId: "web-security-headers" },
    { id: "F-2", title: "Object endpoint answers an unauthenticated request", asset: "https://a.test/api/1",
      severity: "high", status: "rejected", summary: "s", discoveredBy: "w", evidenceIds: ["E-2"],
      skillId: "api-object-boundary" },
  ] as Finding[]

  test("matches what is on screen: severity, verdict, asset, and methodology", () => {
    expect(filterFindings(findings, "").map((f) => f.id)).toEqual(["F-1", "F-2"])
    expect(filterFindings(findings, "high").map((f) => f.id)).toEqual(["F-2"])
    expect(filterFindings(findings, "confirmed").map((f) => f.id)).toEqual(["F-1"])
    expect(filterFindings(findings, "/api/").map((f) => f.id)).toEqual(["F-2"])
    expect(filterFindings(findings, "web-security").map((f) => f.id)).toEqual(["F-1"])
    expect(filterFindings(findings, "HEADERS").map((f) => f.id)).toEqual(["F-1"])
    expect(filterFindings(findings, "nothing here")).toEqual([])
  })

  test("says so on screen when a filter hides everything", () => {
    const snapshot = { ...snapshotWith([]), findings }
    const text = formatFindings(snapshot, undefined, 80, "zzz").chunks.map((c) => c.text).join("")
    expect(text).toContain("Nothing matches")
    const shown = formatFindings(snapshot, undefined, 80, "high").chunks.map((c) => c.text).join("")
    expect(shown).toContain("1 OF 2")
    expect(shown).toContain("F-2")
    expect(shown).not.toContain("F-1")
  })
})
