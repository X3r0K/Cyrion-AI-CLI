import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  CONTRACT_VERSION,
  assertManifest,
  type AgentRecord,
  type AgentRuntime,
  type EngagementManifest,
  type EngagementSnapshot,
  type EventType,
  type Finding,
  type RootDecision,
  type RootPlanner,
  type TaskRecord,
  type TaskSpec,
  type WorkerResult,
} from "@cyrion/contracts"
import { type EngagementStore, MemoryEventStore } from "./event-store"
import { ScopedToolGateway } from "./tool-gateway"

export interface ControllerOptions {
  store?: EngagementStore
  toolGateway?: ScopedToolGateway
  leaseDurationMs?: number
  heartbeatIntervalMs?: number
}

export class CyrionController {
  readonly events: EngagementStore
  readonly #runtime: AgentRuntime
  readonly #planner: RootPlanner
  readonly #agentsDir: string
  readonly #toolGateway: ScopedToolGateway
  readonly #leaseDurationMs: number
  readonly #heartbeatIntervalMs: number
  #snapshot: EngagementSnapshot
  #paused = false
  #cancelled = false

  constructor(
    manifest: EngagementManifest,
    runtime: AgentRuntime,
    planner: RootPlanner,
    agentsDir: string,
    options: ControllerOptions = {},
  ) {
    assertManifest(manifest)
    this.#runtime = runtime
    this.#planner = planner
    this.#agentsDir = agentsDir
    this.events = options.store ?? new MemoryEventStore()
    this.#toolGateway = options.toolGateway ?? new ScopedToolGateway(manifest, {})
    this.#leaseDurationMs = options.leaseDurationMs ?? 5_000
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 1_000
    if (this.#leaseDurationMs < 100) throw new Error("Lease duration must be at least 100 milliseconds")
    if (this.#heartbeatIntervalMs < 25 || this.#heartbeatIntervalMs >= this.#leaseDurationMs) {
      throw new Error("Heartbeat interval must be at least 25ms and shorter than the lease")
    }

    const restored = this.events.loadSnapshot()
    if (restored && JSON.stringify(restored.manifest) !== JSON.stringify(manifest)) {
      throw new Error(`Stored engagement ${manifest.id} does not match the supplied manifest`)
    }
    this.#snapshot = restored ? normalizeStoredSnapshot(restored) : {
      manifest: structuredClone(manifest),
      status: "idle",
      agents: [],
      tasks: [],
      findings: [],
      evidence: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      events: [],
    }
  }

  get snapshot(): EngagementSnapshot {
    return structuredClone({ ...this.#snapshot, events: this.events.list() })
  }

  async run(): Promise<EngagementSnapshot> {
    if (this.#snapshot.status === "completed" || this.#snapshot.status === "cancelled") {
      await Promise.allSettled([this.#runtime.close(), this.#planner.close()])
      return this.snapshot
    }
    if (this.#snapshot.status === "idle") this.#start()
    else this.#recover()

    try {
      while (!this.#cancelled) {
        await this.#waitWhilePaused()
        this.#enforceDeadline()

        if (await this.#runReadyTasks()) continue

        const decision = await this.#planner.decide(this.snapshot)
        const plannerUsage = this.#planner.takeUsage?.()
        if (plannerUsage) this.#applyUsage({ usage: plannerUsage })
        this.#record("root.decision.proposed", decision, "root-agent")

        const rejection = this.#validateDecision(decision)
        if (rejection) {
          this.#record("root.decision.rejected", { rejection, decision }, "root-agent")
          throw new Error(rejection)
        }

        if (decision.action.kind === "delegate") {
          for (const spec of decision.action.tasks) this.#queue(spec)
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
          this.#persist()
          break
        }

        throw new Error(`Root stopped engagement: ${decision.action.rationale}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!this.#cancelled) {
        this.#record("engagement.failed", { error: message }, "root-agent")
        this.#snapshot.status = "failed"
      }
      this.#persist()
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
    this.#persist()
  }

  resume(): void {
    if (!this.#paused) return
    this.#record("engagement.resumed", { reason: "operator" }, "root-agent")
    this.#paused = false
    this.#snapshot.status = "running"
    this.#persist()
  }

  async cancel(): Promise<void> {
    if (!["running", "paused"].includes(this.#snapshot.status)) return
    this.#record("engagement.cancelled", { reason: "operator" }, "root-agent")
    this.#cancelled = true
    await Promise.all(
      this.#snapshot.agents
        .filter((agent) => agent.status === "running" && agent.role !== "root")
        .map((agent) => this.#runtime.cancel(agent.id)),
    )
    this.#snapshot.status = "cancelled"
    const root = this.#snapshot.agents.find((agent) => agent.id === "root-agent")
    if (root) {
      root.status = "cancelled"
      root.finishedAt = new Date().toISOString()
    }
    this.#persist()
  }

  operatorMessage(content: string): void {
    const clean = content.trim()
    if (!clean) return
    this.#record("operator.message", { content: clean }, "root-agent")
    const active = this.#snapshot.tasks.filter((task) => task.status === "running").map((task) => task.role)
    const confirmed = this.#snapshot.findings.filter((finding) => finding.status === "confirmed").length
    const unresolved = this.#snapshot.findings.filter((finding) =>
      finding.status === "candidate" || finding.status === "validating" || finding.status === "inconclusive"
    ).length
    const response = this.#snapshot.status === "completed"
      ? `Mission complete: ${this.#snapshot.tasks.length} tasks finished, ${confirmed} confirmed, ${unresolved} unresolved, ${this.#snapshot.evidence.length} artifacts captured.`
      : this.#snapshot.status === "paused"
        ? `Dispatch is paused. ${active.length ? `${active.join(" and ")} operations may still be settling.` : "No worker is active."}`
        : active.length
          ? `Root is coordinating ${active.join(" and ")}. Current record: ${confirmed} confirmed, ${unresolved} unresolved, ${this.#snapshot.evidence.length} artifacts.`
          : `Root is preparing the next bounded decision. Current record: ${confirmed} confirmed and ${this.#snapshot.evidence.length} artifacts.`
    this.#record("root.message", { content: response }, "root-agent")
  }

  close(): void {
    this.events.close()
  }

  #start(): void {
    const root: AgentRecord = { id: "root-agent", role: "root", name: "root-agent", status: "running" }
    const startedAt = new Date().toISOString()
    this.#record("engagement.started", { root, objective: this.#snapshot.manifest.objective })
    this.#snapshot.status = "running"
    this.#snapshot.startedAt = startedAt
    this.#snapshot.agents.push({ ...root, startedAt })
    this.#persist()
  }

  #recover(): void {
    this.#record("engagement.recovered", { previousStatus: this.#snapshot.status }, "root-agent")
    this.#paused = false
    this.#snapshot.status = "running"
    const root = this.#snapshot.agents.find((agent) => agent.id === "root-agent")
    if (root) {
      root.status = "running"
      delete root.finishedAt
    } else {
      this.#snapshot.agents.unshift({
        id: "root-agent",
        role: "root",
        name: "root-agent",
        status: "running",
        startedAt: this.#snapshot.startedAt ?? new Date().toISOString(),
      })
    }
    const latestBudgetEvent = this.events.list("budget.updated").at(-1)
    const durableUsage = latestBudgetEvent
      ? (latestBudgetEvent.payload as { next?: EngagementSnapshot["usage"] }).next
      : undefined
    if (durableUsage) this.#snapshot.usage = structuredClone(durableUsage)
    for (const task of this.#snapshot.tasks.filter((item) => item.status === "running")) {
      const completedEvent = this.events.list("task.completed").findLast((event) => event.taskId === task.id)
      const completedResult = completedEvent
        ? (completedEvent.payload as { result?: WorkerResult }).result
        : undefined
      if (completedEvent && completedResult) {
        this.#record(
          "task.reconciled",
          { previousStatus: "running", action: "accept-completed-event", eventId: completedEvent.id },
          task.agentId,
          task.id,
        )
        task.status = "completed"
        task.result = structuredClone(completedResult)
        delete task.lease
        const completedAgent = this.#snapshot.agents.find((agent) => agent.id === task.agentId)
        if (completedAgent) {
          completedAgent.status = "completed"
          completedAgent.finishedAt = completedEvent.timestamp
        }
        for (const evidence of completedResult.evidence) {
          if (!this.#snapshot.evidence.some((item) => item.id === evidence.id)) {
            this.#snapshot.evidence.push(structuredClone(evidence))
          }
        }
        for (const finding of completedResult.findings) {
          const existing = this.#snapshot.findings.find((item) => item.id === finding.id)
          if (existing) Object.assign(existing, structuredClone(finding))
          else this.#snapshot.findings.push(structuredClone(finding))
        }
        continue
      }
      this.#record(
        "task.reconciled",
        { previousStatus: "running", action: "requeue", previousLease: task.lease },
        task.agentId,
        task.id,
      )
      task.status = "queued"
      delete task.lease
      const staleAgent = this.#snapshot.agents.find((agent) => agent.id === task.agentId)
      if (staleAgent) {
        staleAgent.status = "cancelled"
        staleAgent.finishedAt = new Date().toISOString()
      }
    }
    this.#persist()
  }

  #record(type: EventType, payload: unknown, agentId?: string, taskId?: string): void {
    this.events.append({
      engagementId: this.#snapshot.manifest.id,
      type,
      payload,
      ...(agentId ? { agentId } : {}),
      ...(taskId ? { taskId } : {}),
    })
  }

  #persist(): void {
    this.events.saveSnapshot(this.#snapshot)
  }

  #queue(spec: TaskSpec): void {
    if (spec.role === "validator" && spec.findingId) {
      const finding = this.#snapshot.findings.find((item) => item.id === spec.findingId)
      if (finding && finding.status === "candidate") {
        const validating = { ...finding, status: "validating" as const }
        this.#record("finding.updated", { finding: validating, previousStatus: finding.status }, "root-agent", spec.id)
        Object.assign(finding, validating)
      }
    }
    this.#record("task.queued", { task: spec }, "root-agent", spec.id)
    this.#snapshot.tasks.push({
      ...structuredClone(spec),
      status: "queued",
      inputHash: taskInputHash(spec),
      attempt: 0,
    })
    this.#persist()
  }

  async #runReadyTasks(): Promise<boolean> {
    const queued = this.#snapshot.tasks.filter((task) => task.status === "queued")
    if (!queued.length) return false
    const completed = new Set(
      this.#snapshot.tasks.filter((task) => task.status === "completed").map((task) => task.id),
    )
    const ready = queued.filter((task) => task.dependencies.every((id) => completed.has(id)))
    if (!ready.length) throw new Error("Queued tasks have unsatisfied dependencies")

    const limit = this.#snapshot.manifest.budgets.maxConcurrentAgents
    for (let offset = 0; offset < ready.length; offset += limit) {
      await this.#waitWhilePaused()
      this.#enforceDeadline()
      const batch = ready.slice(offset, offset + limit)
      await Promise.all(batch.map((task) => this.#dispatch(task)))
    }
    return true
  }

  async #dispatch(task: TaskRecord): Promise<void> {
    const agentId = `${task.role}-${task.id.toLowerCase()}`
    const now = new Date().toISOString()
    const agentState: AgentRecord = {
      id: agentId,
      role: task.role,
      name: `${task.role}-01`,
      taskId: task.id,
      parentId: "root-agent",
      status: "running",
      startedAt: now,
    }
    const lease = {
      ownerId: agentId,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: new Date(Date.now() + this.#leaseDurationMs).toISOString(),
    }
    this.#record("task.lease.acquired", { lease, attempt: task.attempt + 1 }, agentId, task.id)
    this.#record("task.started", { agent: agentState, task: task.id }, agentId, task.id)
    task.status = "running"
    task.agentId = agentId
    task.attempt += 1
    task.lease = lease
    const existingAgent = this.#snapshot.agents.find((agent) => agent.id === agentId)
    const agent = existingAgent ?? agentState
    if (existingAgent) Object.assign(existingAgent, agentState)
    else this.#snapshot.agents.push(agent)
    this.#persist()

    const heartbeat = setInterval(() => {
      if (task.status !== "running" || !task.lease) return
      const heartbeatAt = new Date().toISOString()
      this.#record("task.heartbeat", { heartbeatAt }, agentId, task.id)
      task.lease.heartbeatAt = heartbeatAt
      task.lease.expiresAt = new Date(Date.now() + this.#leaseDurationMs).toISOString()
      this.#persist()
    }, this.#heartbeatIntervalMs)

    try {
      const systemPrompt = await readFile(join(this.#agentsDir, task.role, "system.md"), "utf8")
      const tools = this.#toolGateway.bind({
        engagementId: this.#snapshot.manifest.id,
        agentId,
        task,
        emit: (type, payload, emittedAgentId, taskId) => this.#record(type, payload, emittedAgentId, taskId),
      })
      const result = await this.#runtime.runTask(task, {
        engagementId: this.#snapshot.manifest.id,
        agentId,
        role: task.role,
        systemPrompt,
        scope: structuredClone(this.#snapshot.manifest.scope),
        remainingBudget: this.#remainingBudget(),
        tools,
      })
      clearInterval(heartbeat)
      this.#applyUsage(result)
      const finishedAt = new Date().toISOString()
      this.#record("task.completed", { summary: result.summary, result }, agentId, task.id)
      task.status = "completed"
      task.result = result
      delete task.lease
      agent.status = "completed"
      agent.finishedAt = finishedAt
      this.#snapshot.evidence.push(...result.evidence)
      for (const finding of result.findings) this.#mergeFinding(finding, agentId, task.id)
      this.#persist()
    } catch (error) {
      clearInterval(heartbeat)
      const message = error instanceof Error ? error.message : String(error)
      this.#record(this.#cancelled ? "task.cancelled" : "task.failed", { error: message }, agentId, task.id)
      task.status = this.#cancelled ? "cancelled" : "failed"
      delete task.lease
      agent.status = this.#cancelled ? "cancelled" : "failed"
      agent.finishedAt = new Date().toISOString()
      this.#persist()
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
    const hashes = new Set(this.#snapshot.tasks.map((task) => task.inputHash))
    const knownIds = new Set([
      ...this.#snapshot.tasks.map((item) => item.id),
      ...decision.action.tasks.map((item) => item.id),
    ])
    for (const task of decision.action.tasks) {
      const inputHash = taskInputHash(task)
      if (ids.has(task.id) || keys.has(task.key) || hashes.has(inputHash)) return `Duplicate task rejected: ${task.id}`
      ids.add(task.id)
      keys.add(task.key)
      hashes.add(inputHash)
      if (task.depth > budgets.maxDepth) return `Depth limit exceeded: ${task.id}`
      if (!scope.targets.includes(task.target) || scope.excluded.includes(task.target)) return `Out-of-scope target: ${task.target}`
      if (task.capabilities.some((capability) => !scope.capabilities.includes(capability))) {
        return `Capability not granted: ${task.id}`
      }
      if (task.dependencies.some((id) => !knownIds.has(id))) return `Unknown dependency in ${task.id}`
    }
    return undefined
  }

  #enforceDeadline(): void {
    if (!this.#snapshot.startedAt) return
    const elapsed = Date.now() - Date.parse(this.#snapshot.startedAt)
    if (elapsed > this.#snapshot.manifest.budgets.maxDurationMs) throw new Error("Engagement deadline exceeded")
  }

  #remainingBudget(): EngagementManifest["budgets"] {
    const budgets = structuredClone(this.#snapshot.manifest.budgets)
    budgets.maxTokens = Math.max(0, budgets.maxTokens - this.#snapshot.usage.inputTokens - this.#snapshot.usage.outputTokens)
    budgets.maxCostUsd = Math.max(0, budgets.maxCostUsd - this.#snapshot.usage.costUsd)
    if (this.#snapshot.startedAt) {
      budgets.maxDurationMs = Math.max(0, budgets.maxDurationMs - (Date.now() - Date.parse(this.#snapshot.startedAt)))
    }
    return budgets
  }

  #applyUsage(result: { usage?: { inputTokens: number; outputTokens: number; costUsd: number } }): void {
    if (!result.usage) return
    const next = {
      inputTokens: this.#snapshot.usage.inputTokens + result.usage.inputTokens,
      outputTokens: this.#snapshot.usage.outputTokens + result.usage.outputTokens,
      costUsd: this.#snapshot.usage.costUsd + result.usage.costUsd,
    }
    this.#record("budget.updated", { previous: this.#snapshot.usage, next })
    this.#snapshot.usage = next
    this.#persist()
    const tokens = next.inputTokens + next.outputTokens
    if (tokens > this.#snapshot.manifest.budgets.maxTokens || next.costUsd > this.#snapshot.manifest.budgets.maxCostUsd) {
      const reason = tokens > this.#snapshot.manifest.budgets.maxTokens ? "Token budget exceeded" : "Cost budget exceeded"
      this.#record("budget.exceeded", { reason, usage: next }, "root-agent")
      throw new Error(reason)
    }
  }

  async #waitWhilePaused(): Promise<void> {
    while (this.#paused && !this.#cancelled) await Bun.sleep(25)
    if (this.#cancelled) throw new Error("Engagement cancelled by operator")
  }
}

export function taskInputHash(task: TaskSpec): string {
  const normalized = {
    role: task.role,
    objective: task.objective.trim(),
    target: task.target.toLowerCase(),
    capabilities: [...task.capabilities].sort(),
    dependencies: [...task.dependencies].sort(),
    depth: task.depth,
    expectedOutput: task.expectedOutput,
    findingId: task.findingId ?? null,
  }
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex")
}

function normalizeStoredSnapshot(snapshot: EngagementSnapshot): EngagementSnapshot {
  const normalized = structuredClone(snapshot)
  normalized.events = []
  normalized.usage ??= { inputTokens: 0, outputTokens: 0, costUsd: 0 }
  for (const task of normalized.tasks) {
    task.inputHash ||= taskInputHash(task)
    task.attempt ??= task.status === "queued" ? 0 : 1
  }
  return normalized
}
