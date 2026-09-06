import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  CONTRACT_VERSION,
  assertManifest,
  type AgentRecord,
  type AgentRuntime,
  type EngagementManifest,
  type EngagementSnapshot,
  type Finding,
  type RootDecision,
  type RootPlanner,
  type TaskRecord,
  type TaskSpec,
} from "@cyrion/contracts"
import { MemoryEventStore } from "./event-store"

export class CyrionController {
  readonly events = new MemoryEventStore()
  readonly #runtime: AgentRuntime
  readonly #planner: RootPlanner
  readonly #agentsDir: string
  #snapshot: EngagementSnapshot
  #paused = false
  #cancelled = false

  constructor(manifest: EngagementManifest, runtime: AgentRuntime, planner: RootPlanner, agentsDir: string) {
    assertManifest(manifest)
    this.#runtime = runtime
    this.#planner = planner
    this.#agentsDir = agentsDir
    this.#snapshot = {
      manifest: structuredClone(manifest),
      status: "idle",
      agents: [],
      tasks: [],
      findings: [],
      evidence: [],
      events: [],
    }
  }

  get snapshot(): EngagementSnapshot {
    return structuredClone({ ...this.#snapshot, events: this.events.list() })
  }

  async run(): Promise<EngagementSnapshot> {
    const root: AgentRecord = { id: "root-agent", role: "root", name: "root-agent", status: "running" }
    const startedAt = new Date().toISOString()
    this.#record("engagement.started", { root, objective: this.#snapshot.manifest.objective })
    this.#snapshot.status = "running"
    this.#snapshot.startedAt = startedAt
    this.#snapshot.agents.push({ ...root, startedAt })

    try {
      while (!this.#cancelled) {
        await this.#waitWhilePaused()
        this.#enforceDeadline()

        const decision = await this.#planner.decide(this.snapshot)
        this.#record("root.decision.proposed", decision, "root-agent")

        const rejection = this.#validateDecision(decision)
        if (rejection) {
          this.#record("root.decision.rejected", { rejection, decision }, "root-agent")
          throw new Error(rejection)
        }

        if (decision.action.kind === "delegate") {
          for (const spec of decision.action.tasks) this.#queue(spec)
          await this.#runReadyTasks()
          continue
        }

        if (decision.action.kind === "finish") {
          const finishedAt = new Date().toISOString()
          this.#record("engagement.completed", { rationale: decision.action.rationale }, "root-agent")
          this.#snapshot.status = "completed"
          this.#snapshot.finishedAt = finishedAt
          const rootAgent = this.#snapshot.agents.find((agent) => agent.id === "root-agent")
          if (rootAgent) {
            rootAgent.status = "completed"
            rootAgent.finishedAt = finishedAt
          }
          break
        }

        throw new Error(`Root stopped engagement: ${decision.action.rationale}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#record("engagement.failed", { error: message }, "root-agent")
      this.#snapshot.status = "failed"
    } finally {
      await Promise.allSettled([this.#runtime.close(), this.#planner.close()])
    }

    return this.snapshot
  }

  pause(): void {
    if (this.#snapshot.status !== "running") return
    this.#record("engagement.paused", { reason: "operator" }, "root-agent")
    this.#paused = true
    this.#snapshot.status = "paused"
  }

  resume(): void {
    if (!this.#paused) return
    this.#record("engagement.resumed", { reason: "operator" }, "root-agent")
    this.#paused = false
    this.#snapshot.status = "running"
  }

  async cancel(): Promise<void> {
    this.#cancelled = true
    await Promise.all(
      this.#snapshot.agents
        .filter((agent) => agent.status === "running" && agent.role !== "root")
        .map((agent) => this.#runtime.cancel(agent.id)),
    )
  }

  operatorMessage(content: string): void {
    const clean = content.trim()
    if (!clean) return
    this.#record("operator.message", { content: clean }, "root-agent")
  }

  #record(type: Parameters<MemoryEventStore["append"]>[0]["type"], payload: unknown, agentId?: string, taskId?: string): void {
    this.events.append({
      engagementId: this.#snapshot.manifest.id,
      type,
      payload,
      ...(agentId ? { agentId } : {}),
      ...(taskId ? { taskId } : {}),
    })
  }

  #queue(spec: TaskSpec): void {
    this.#record("task.queued", { task: spec }, "root-agent", spec.id)
    this.#snapshot.tasks.push({ ...structuredClone(spec), status: "queued" })
  }

  async #runReadyTasks(): Promise<void> {
    const completed = new Set(
      this.#snapshot.tasks.filter((task) => task.status === "completed").map((task) => task.id),
    )
    const ready = this.#snapshot.tasks.filter(
      (task) => task.status === "queued" && task.dependencies.every((id) => completed.has(id)),
    )
    if (!ready.length) throw new Error("Root delegated tasks with unsatisfied dependencies")

    const limit = this.#snapshot.manifest.budgets.maxConcurrentAgents
    for (let offset = 0; offset < ready.length; offset += limit) {
      await this.#waitWhilePaused()
      const batch = ready.slice(offset, offset + limit)
      await Promise.all(batch.map((task) => this.#dispatch(task)))
    }
  }

  async #dispatch(task: TaskRecord): Promise<void> {
    const agentId = `${task.role}-${task.id.toLowerCase()}`
    const now = new Date().toISOString()
    const agent: AgentRecord = {
      id: agentId,
      role: task.role,
      name: `${task.role}-01`,
      taskId: task.id,
      parentId: "root-agent",
      status: "running",
      startedAt: now,
    }
    this.#record("task.started", { agent, task: task.id }, agentId, task.id)
    task.status = "running"
    task.agentId = agentId
    this.#snapshot.agents.push(agent)

    try {
      const systemPrompt = await readFile(join(this.#agentsDir, task.role, "system.md"), "utf8")
      const result = await this.#runtime.runTask(task, {
        engagementId: this.#snapshot.manifest.id,
        agentId,
        role: task.role,
        systemPrompt,
        scope: structuredClone(this.#snapshot.manifest.scope),
        remainingBudget: structuredClone(this.#snapshot.manifest.budgets),
      })
      const finishedAt = new Date().toISOString()
      this.#record("task.completed", { summary: result.summary, result }, agentId, task.id)
      task.status = "completed"
      task.result = result
      agent.status = "completed"
      agent.finishedAt = finishedAt
      this.#snapshot.evidence.push(...result.evidence)
      for (const finding of result.findings) this.#mergeFinding(finding, agentId, task.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#record("task.failed", { error: message }, agentId, task.id)
      task.status = "failed"
      agent.status = "failed"
      agent.finishedAt = new Date().toISOString()
      throw error
    }
  }

  #mergeFinding(finding: Finding, agentId: string, taskId: string): void {
    const existing = this.#snapshot.findings.find((item) => item.id === finding.id)
    this.#record("finding.updated", { finding, previousStatus: existing?.status }, agentId, taskId)
    if (existing) Object.assign(existing, structuredClone(finding))
    else this.#snapshot.findings.push(structuredClone(finding))
  }

  #validateDecision(decision: RootDecision): string | undefined {
    if (decision.version !== CONTRACT_VERSION) return "Unsupported Root decision contract"
    if (decision.action.kind !== "delegate") return undefined
    const { budgets, scope } = this.#snapshot.manifest
    if (this.#snapshot.tasks.length + decision.action.tasks.length > budgets.maxTasks) return "Task budget exceeded"
    if (this.#snapshot.agents.length + decision.action.tasks.length > budgets.maxAgents) return "Agent budget exceeded"

    const ids = new Set(this.#snapshot.tasks.map((task) => task.id))
    const keys = new Set(this.#snapshot.tasks.map((task) => task.key))
    for (const task of decision.action.tasks) {
      if (ids.has(task.id) || keys.has(task.key)) return `Duplicate task rejected: ${task.id}`
      ids.add(task.id)
      keys.add(task.key)
      if (task.depth > budgets.maxDepth) return `Depth limit exceeded: ${task.id}`
      if (!scope.targets.includes(task.target) || scope.excluded.includes(task.target)) return `Out-of-scope target: ${task.target}`
      if (task.capabilities.some((capability) => !scope.capabilities.includes(capability))) {
        return `Capability not granted: ${task.id}`
      }
      const knownIds = new Set([...this.#snapshot.tasks.map((item) => item.id), ...decision.action.tasks.map((item) => item.id)])
      if (task.dependencies.some((id) => !knownIds.has(id))) return `Unknown dependency in ${task.id}`
    }
    return undefined
  }

  #enforceDeadline(): void {
    if (!this.#snapshot.startedAt) return
    const elapsed = Date.now() - Date.parse(this.#snapshot.startedAt)
    if (elapsed > this.#snapshot.manifest.budgets.maxDurationMs) throw new Error("Engagement deadline exceeded")
  }

  async #waitWhilePaused(): Promise<void> {
    while (this.#paused && !this.#cancelled) await Bun.sleep(25)
    if (this.#cancelled) throw new Error("Engagement cancelled by operator")
  }
}
