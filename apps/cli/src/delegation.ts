import type { AgentStatus, EngagementSnapshot, TaskRecord } from "@cyrion/contracts"

/**
 * The engagement as a delegation tree.
 *
 * A run is no longer a list of workers: root delegates, a worker asks for a
 * specialist, and that specialist can ask for another. What an operator needs to
 * see is *who asked for whom* — a flat roster of seven agents says nothing about
 * why the seventh exists, and "why is this running against my site" is the
 * question a live view has to answer.
 *
 * Pure, so the shape can be asserted without a terminal. The renderer decides
 * how it looks; this decides what is true.
 */

export interface DelegationNode {
  taskId: string
  /** The agent that took the task, when one has. */
  agentId?: string
  label: string
  role: string
  status: TaskRecord["status"]
  agentStatus: AgentStatus
  /** Nesting level in the drawn tree; root is 0. */
  depth: number
  /** What this agent is doing now, or what it did. */
  activity: string
  /** True for the last child of its parent, which draws `└` instead of `├`. */
  last: boolean
  /** Ancestor levels still needing a vertical rule drawn through them. */
  spine: boolean[]
  /** Set when a worker asked for this task rather than the planner. */
  spawned: boolean
}

/**
 * Flattens the tree into draw order, depth-first.
 *
 * Depth-first is what makes a spawn readable: a specialist appears directly
 * under the task that asked for it, rather than in a separate tier where the
 * connection has to be reconstructed by matching identifiers.
 */
export function delegationTree(snapshot: EngagementSnapshot): DelegationNode[] {
  const tasks = snapshot.tasks
  const children = new Map<string, TaskRecord[]>()
  const roots: TaskRecord[] = []
  for (const task of tasks) {
    const parent = task.parentTaskId
    if (parent && tasks.some((entry) => entry.id === parent)) {
      const list = children.get(parent) ?? []
      list.push(task)
      children.set(parent, list)
    } else {
      roots.push(task)
    }
  }

  const nodes: DelegationNode[] = []
  const walk = (task: TaskRecord, depth: number, last: boolean, spine: boolean[]): void => {
    const agent = snapshot.agents.find((entry) => entry.id === task.agentId)
    nodes.push({
      taskId: task.id,
      ...(task.agentId ? { agentId: task.agentId } : {}),
      label: agent?.name ?? task.id,
      role: task.role,
      status: task.status,
      agentStatus: agent?.status ?? (task.status === "completed" ? "completed" : "queued"),
      depth,
      activity: activityFor(task, snapshot),
      last,
      spine,
      // The planner names its own tasks; a spawned one carries the parent that
      // asked, which is exactly what the tree exists to show.
      spawned: Boolean(task.parentTaskId),
    })
    const kids = children.get(task.id) ?? []
    for (const [index, child] of kids.entries()) {
      walk(child, depth + 1, index === kids.length - 1, [...spine, !last])
    }
  }
  for (const [index, task] of roots.entries()) {
    walk(task, 1, index === roots.length - 1, [])
  }
  return nodes
}

/**
 * What this agent is doing, in the operator's language.
 *
 * A running task shows its most recent tool call, because that is the answer to
 * "what is it doing to my site right now". A finished one shows what it
 * produced, because by then the question has become "what did it find".
 */
function activityFor(task: TaskRecord, snapshot: EngagementSnapshot): string {
  if (task.status === "running") {
    const latest = [...snapshot.events]
      .reverse()
      .find((event) => event.taskId === task.id && event.type.startsWith("tool.request"))
    const payload = latest?.payload as { capability?: unknown; target?: unknown } | undefined
    if (typeof payload?.capability === "string") {
      const target = typeof payload.target === "string" ? shortTarget(payload.target) : ""
      return target ? `${payload.capability} ${target}` : payload.capability
    }
    return task.objective
  }
  if (task.status === "completed") {
    const findings = snapshot.findings.filter((finding) => finding.discoveredBy === task.agentId).length
    if (findings) return `${findings} finding${findings === 1 ? "" : "s"}`
    const result = task.result
    return result?.observations.length
      ? `${result.observations.length} observation${result.observations.length === 1 ? "" : "s"}`
      : "done"
  }
  if (task.status === "failed" || task.status === "cancelled") return task.status
  return "queued"
}

/** A URL an operator recognizes, without the scheme and the host they already know. */
export function shortTarget(value: string): string {
  try {
    const url = new URL(value)
    const path = `${url.pathname}${url.search}`
    return path === "/" ? url.host : path
  } catch {
    return value.length > 40 ? `${value.slice(0, 39)}…` : value
  }
}

/**
 * The connector for one node: the ancestors' vertical rules, then its own elbow.
 *
 * Built from the spine rather than from the depth alone, so a deep branch under
 * a finished sibling does not draw a rule through empty space.
 */
export function treePrefix(node: DelegationNode): string {
  const spine = node.spine.map((continues) => (continues ? "│  " : "   ")).join("")
  return `${spine}${node.last ? "└─" : "├─"}`
}

/** How many agents are working right now, which is the number a header states. */
export function activeCount(nodes: readonly DelegationNode[]): number {
  return nodes.filter((node) => node.status === "running").length
}

/** The deepest delegation reached, so an operator can see the graph grow. */
export function treeDepth(nodes: readonly DelegationNode[]): number {
  return nodes.reduce((deepest, node) => Math.max(deepest, node.depth), 0)
}
