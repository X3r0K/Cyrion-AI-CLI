import type { CyrionEvent, EngagementSnapshot, Finding, Severity } from "@cyrion/contracts"

/** What a line in the transcript is: a request, an answer, a claim, a decision. */
export type AttackKind = "request" | "progress" | "answer" | "refusal" | "finding" | "decision" | "task" | "lifecycle"

export interface AttackLine {
  sequence: number
  timestamp: string
  kind: AttackKind
  /** Who did it: a worker, or Root. */
  actor: string
  /** The verb, in the operator's language. */
  action: string
  /** What it acted on — a URL, a host, a finding id. */
  subject?: string
  /** What came back. */
  detail?: string
  /** Milliseconds the exchange took, when it was an exchange. */
  durationMs?: number
  severity?: Severity
}

const noisy = new Set<CyrionEvent["type"]>([
  "task.heartbeat",
  "task.lease.acquired",
  "budget.updated",
])

/**
 * The engagement as a running account of what happened to the target.
 *
 * The mission feed answers "where are we"; this answers "what did you just do
 * to my site". So it keeps the exchange — capability, target, and what came
 * back — and drops the bookkeeping a reader would have to scroll past to find
 * it. Every field is derived from an event the controller already recorded, and
 * target-derived text arrives already bounded and stripped.
 */
export function attackStream(snapshot: EngagementSnapshot): AttackLine[] {
  const lines: AttackLine[] = []
  for (const event of snapshot.events) {
    if (noisy.has(event.type)) continue
    const actor = agentName(snapshot, event.agentId)
    const payload = event.payload as Record<string, unknown> | undefined

    if (event.type === "tool.request.accepted") {
      lines.push({
        sequence: event.sequence,
        timestamp: event.timestamp,
        kind: "request",
        actor,
        action: text(payload?.capability) ?? "tool",
        ...(text(payload?.target) ? { subject: text(payload?.target)! } : {}),
      })
      continue
    }
    if (event.type === "tool.request.progress") {
      lines.push({
        sequence: event.sequence,
        timestamp: event.timestamp,
        kind: "progress",
        actor,
        action: text(payload?.capability) ?? "tool",
        ...(text(payload?.target) ? { subject: text(payload?.target)! } : {}),
        ...(text(payload?.note) ? { detail: text(payload?.note)! } : {}),
      })
      continue
    }
    if (event.type === "tool.request.completed") {
      lines.push({
        sequence: event.sequence,
        timestamp: event.timestamp,
        kind: "answer",
        actor,
        action: text(payload?.capability) ?? "tool",
        ...(text(payload?.target) ? { subject: text(payload?.target)! } : {}),
        ...(text(payload?.outcome) ? { detail: text(payload?.outcome)! } : {}),
        ...(count(payload?.durationMs) !== undefined ? { durationMs: count(payload?.durationMs)! } : {}),
      })
      continue
    }
    if (event.type === "tool.request.rejected") {
      lines.push({
        sequence: event.sequence,
        timestamp: event.timestamp,
        kind: "refusal",
        actor,
        action: text(payload?.capability) ?? "tool",
        ...(text(payload?.target) ? { subject: text(payload?.target)! } : {}),
        ...(text(payload?.reason) ? { detail: text(payload?.reason)! } : {}),
      })
      continue
    }
    if (event.type === "finding.updated") {
      const finding = payload?.finding as Finding | undefined
      if (!finding) continue
      lines.push({
        sequence: event.sequence,
        timestamp: event.timestamp,
        kind: "finding",
        actor,
        action: findingAction(finding.status, text(payload?.previousStatus)),
        ...(finding.id ? { subject: finding.id } : {}),
        detail: finding.title,
        ...(finding.severity ? { severity: finding.severity } : {}),
      })
      continue
    }
    if (event.type === "task.started") {
      const task = snapshot.tasks.find((item) => item.id === event.taskId)
      lines.push({
        sequence: event.sequence,
        timestamp: event.timestamp,
        kind: "task",
        actor,
        action: "began",
        ...(task ? { subject: task.target, detail: task.skillId ?? task.objective } : {}),
      })
      continue
    }
    if (event.type === "task.completed" || event.type === "task.failed" || event.type === "task.result.rejected") {
      const finished = snapshot.tasks.find((item) => item.id === event.taskId)
      lines.push({
        sequence: event.sequence,
        timestamp: event.timestamp,
        kind: event.type === "task.completed" ? "task" : "refusal",
        actor,
        action: event.type === "task.completed" ? "finished" : event.type === "task.failed" ? "failed" : "result refused",
        ...(finished?.target ?? event.taskId ? { subject: finished?.target ?? event.taskId! } : {}),
        ...(text(payload?.summary) ?? text(payload?.error) ?? text(payload?.reason)
          ? { detail: (text(payload?.summary) ?? text(payload?.error) ?? text(payload?.reason))! }
          : {}),
      })
      continue
    }
    if (event.type === "root.decision.proposed") {
      const action = (payload?.action ?? {}) as { kind?: string; rationale?: string; tasks?: unknown[] }
      lines.push({
        sequence: event.sequence,
        timestamp: event.timestamp,
        kind: "decision",
        actor: "root",
        action: action.kind === "delegate" ? `delegated ${action.tasks?.length ?? 0} task(s)` : action.kind ?? "decided",
        ...(text(action.rationale) ? { detail: text(action.rationale)! } : {}),
      })
      continue
    }
    if (event.type.startsWith("engagement.") || event.type.startsWith("root.decision.")) {
      lines.push({
        sequence: event.sequence,
        timestamp: event.timestamp,
        kind: "lifecycle",
        actor: actor === "unassigned" ? "root" : actor,
        action: event.type.replace("engagement.", "engagement ").replace("root.decision.", "decision "),
        ...(text(payload?.rationale) ?? text(payload?.reason) ?? text(payload?.error)
          ? { detail: (text(payload?.rationale) ?? text(payload?.reason) ?? text(payload?.error))! }
          : {}),
      })
    }
  }
  return lines
}

function findingAction(status: string | undefined, previous: string | undefined): string {
  if (status === "candidate") return "raised"
  if (status === "validating") return "sent for validation"
  if (status === "confirmed") return "confirmed"
  if (status === "rejected") return "rejected"
  if (status === "inconclusive") return "inconclusive"
  return previous ? `${previous} → ${status ?? "updated"}` : "updated"
}

function agentName(snapshot: EngagementSnapshot, agentId: string | undefined): string {
  if (!agentId) return "unassigned"
  return snapshot.agents.find((agent) => agent.id === agentId)?.name ?? agentId
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const clean = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim()
  return clean || undefined
}

function count(value: unknown): number | undefined {
  return Number.isFinite(value) ? Number(value) : undefined
}

export interface StreamWindow {
  lines: AttackLine[]
  /** First line shown, counting from the top of the whole stream. */
  offset: number
  total: number
  following: boolean
}

/**
 * The slice of the stream that fits on screen.
 *
 * Following pins the view to the end, which is what an operator watching a live
 * run wants. Scrolling up releases the pin, because a reader who has gone
 * looking for something should not have it yanked away by the next event.
 */
export function windowOf(
  lines: readonly AttackLine[],
  options: { height: number; offset: number; following: boolean },
): StreamWindow {
  const height = Math.max(1, options.height)
  const total = lines.length
  const maximum = Math.max(0, total - height)
  const offset = options.following ? maximum : Math.min(Math.max(0, options.offset), maximum)
  return {
    lines: lines.slice(offset, offset + height),
    offset,
    total,
    following: options.following,
  }
}

/** Moves the view, and stops following as soon as the reader scrolls back. */
export function scrollStream(
  state: { offset: number; following: boolean },
  delta: number,
  total: number,
  height: number,
): { offset: number; following: boolean } {
  const maximum = Math.max(0, total - Math.max(1, height))
  const from = state.following ? maximum : state.offset
  const offset = Math.min(Math.max(0, from + delta), maximum)
  // Returning to the end re-arms following, so `end` behaves as an operator expects.
  return { offset, following: offset >= maximum }
}
