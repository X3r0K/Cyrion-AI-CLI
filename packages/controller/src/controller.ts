import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  CONTRACT_VERSION,
  assertManifest,
  pendingApprovalContractError,
  resourceUsageContractError,
  rootDecisionContractError,
  workerResultContractError,
  type AgentRecord,
  type AgentRuntime,
  type EngagementManifest,
  type EngagementSnapshot,
  type EvidenceRef,
  type EvidenceStore,
  type EventType,
  type Finding,
  type PendingApproval,
  type RootDecision,
  type RootPlanner,
  type TaskRecord,
  type TaskSpec,
  type WorkerResult,
} from "@cyrion/contracts"
import { MemoryEvidenceStore } from "@cyrion/evidence"
import { evaluateScope, scopeHash, scopePolicyError, tryParseTarget, verifyScopeLock } from "@cyrion/scope"
import { type EngagementStore, MemoryEventStore } from "./event-store"
import { ScopedToolGateway } from "./tool-gateway"

export interface ControllerOptions {
  store?: EngagementStore
  toolGateway?: ScopedToolGateway
  leaseDurationMs?: number
  heartbeatIntervalMs?: number
  autoApprove?: boolean
  evidenceStore?: EvidenceStore
  /** Operator attestation bound to this exact scope. Required by `cyrion engage`. */
  scopeLock?: unknown
}

export class CyrionController {
  readonly events: EngagementStore
  readonly #runtime: AgentRuntime
  readonly #planner: RootPlanner
  readonly #agentsDir: string
  readonly #toolGateway: ScopedToolGateway
  readonly #leaseDurationMs: number
  readonly #heartbeatIntervalMs: number
  readonly #autoApprove: boolean
  readonly #evidenceStore: EvidenceStore
  #snapshot: EngagementSnapshot
  #paused = false
  #cancelled = false
  #approvalWaiter: ((approved: boolean) => void) | undefined

  constructor(
    manifest: EngagementManifest,
    runtime: AgentRuntime,
    planner: RootPlanner,
    agentsDir: string,
    options: ControllerOptions = {},
  ) {
    assertManifest(manifest)
    const policyError = scopePolicyError(manifest.scope)
    if (policyError) throw new Error(`Invalid engagement scope: ${policyError}`)
    if (options.scopeLock !== undefined) {
      const lockError = verifyScopeLock(options.scopeLock, manifest)
      if (lockError) throw new Error(lockError)
    }
    this.#runtime = runtime
    this.#planner = planner
    this.#agentsDir = agentsDir
    this.events = options.store ?? new MemoryEventStore()
    this.#toolGateway = options.toolGateway ?? new ScopedToolGateway(manifest, {})
    this.#leaseDurationMs = options.leaseDurationMs ?? 5_000
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 1_000
    this.#autoApprove = options.autoApprove ?? false
    this.#evidenceStore = options.evidenceStore ?? new MemoryEvidenceStore()
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
    this.#restoreTerminalStateFromEvents()
    const storedApprovalError = this.#snapshot.pendingApproval
      ? pendingApprovalContractError(this.#snapshot.pendingApproval)
      : undefined
    if (storedApprovalError) throw new Error(`Stored approval rejected: ${storedApprovalError}`)
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
    else await this.#recover()

    try {
      while (!this.#cancelled) {
        await this.#waitWhilePaused()
        this.#enforceDeadline()

        if (this.#snapshot.pendingApproval) {
          const approvalRejection = this.#pendingApprovalError(this.#snapshot.pendingApproval)
          if (approvalRejection) {
            const approvalId = this.#snapshot.pendingApproval.id
            this.#record("root.decision.rejected", { rejection: approvalRejection, approvalId }, "root-agent")
            delete this.#snapshot.pendingApproval
            this.#persist()
            throw new Error(approvalRejection)
          }
          const approved = await this.#waitForApproval()
          if (this.#cancelled || !approved) continue
          this.#enforceDeadline()
          this.#applyApprovedDecision()
          continue
        }

        if (await this.#runReadyTasks()) continue

        const decision = await this.#planner.decide(this.snapshot)
        const plannerUsage = this.#planner.takeUsage?.()
        if (plannerUsage) this.#applyUsage({ usage: plannerUsage })
        const contractRejection = rootDecisionContractError(decision)
        if (contractRejection) {
          this.#record("root.decision.rejected", { rejection: contractRejection }, "root-agent")
          throw new Error(contractRejection)
        }
        this.#record("root.decision.proposed", decision, "root-agent")

        const rejection = this.#validateDecision(decision)
        if (rejection) {
          this.#record("root.decision.rejected", { rejection, decision }, "root-agent")
          throw new Error(rejection)
        }

        if (decision.action.kind === "delegate") {
          if (this.#snapshot.manifest.mode === "supervised") {
            this.#requestApproval({ version: decision.version, action: decision.action })
          } else {
            for (const spec of decision.action.tasks) this.#queue(spec)
          }
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
    this.#cancelled = true
    if (this.#snapshot.pendingApproval) {
      const approval = this.#snapshot.pendingApproval
      if (approval.status === "pending") {
        this.#record(
          "root.decision.denied",
          { approvalId: approval.id, reason: "Engagement cancelled by operator" },
          "root-agent",
        )
      }
      delete this.#snapshot.pendingApproval
      this.#approvalWaiter?.(false)
      this.#approvalWaiter = undefined
    }
    this.#record("engagement.cancelled", { reason: "operator" }, "root-agent")
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

  approvePending(): boolean {
    const approval = this.#snapshot.pendingApproval
    if (!approval || approval.status !== "pending" || this.#cancelled) return false
    approval.status = "approved"
    const root = this.#snapshot.agents.find((agent) => agent.id === "root-agent")
    if (root) root.status = "running"
    this.#record(
      "root.decision.approved",
      { approvalId: approval.id, taskIds: approval.decision.action.tasks.map((task) => task.id) },
      "root-agent",
    )
    this.#persist()
    this.#approvalWaiter?.(true)
    this.#approvalWaiter = undefined
    return true
  }

  denyPending(reason = "Delegation denied by operator"): boolean {
    const approval = this.#snapshot.pendingApproval
    if (!approval || approval.status !== "pending" || this.#cancelled) return false
    const cleanReason = boundedOperatorReason(reason)
    this.#record("root.decision.denied", { approvalId: approval.id, reason: cleanReason }, "root-agent")
    delete this.#snapshot.pendingApproval
    this.#cancelled = true
    this.#snapshot.status = "cancelled"
    const root = this.#snapshot.agents.find((agent) => agent.id === "root-agent")
    if (root) {
      root.status = "cancelled"
      root.finishedAt = new Date().toISOString()
    }
    this.#record("engagement.cancelled", { reason: "supervisor-denied" }, "root-agent")
    this.#persist()
    this.#approvalWaiter?.(false)
    this.#approvalWaiter = undefined
    return true
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
        : this.#snapshot.pendingApproval?.status === "pending"
          ? `Root is waiting for supervisor approval of ${this.#snapshot.pendingApproval.decision.action.tasks.length} proposed task(s).`
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
    this.#record("engagement.started", {
      root,
      objective: this.#snapshot.manifest.objective,
      scopeHash: scopeHash(this.#snapshot.manifest.scope),
    })
    this.#snapshot.status = "running"
    this.#snapshot.startedAt = startedAt
    this.#snapshot.agents.push({ ...root, startedAt })
    this.#persist()
  }

  async #recover(): Promise<void> {
    this.#record("engagement.recovered", { previousStatus: this.#snapshot.status }, "root-agent")
    this.#paused = false
    this.#snapshot.status = "running"
    this.#restorePendingApprovalFromEvents()
    const root = this.#snapshot.agents.find((agent) => agent.id === "root-agent")
    if (root) {
      root.status = this.#snapshot.pendingApproval?.status === "pending" ? "waiting" : "running"
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
        ? (completedEvent.payload as { result?: unknown }).result
        : undefined
      const contractRejection = completedResult === undefined ? undefined : workerResultContractError(completedResult)
      const policyRejection = contractRejection || completedResult === undefined
        ? undefined
        : workerResultPolicyError(completedResult as WorkerResult, task, this.#snapshot, task.agentId ?? "")
      const evidenceRejection = contractRejection || policyRejection || completedResult === undefined
        ? undefined
        : await this.#evidenceAdmissionError(completedResult as WorkerResult)
      if (completedEvent && completedResult && !contractRejection && !policyRejection && !evidenceRejection) {
        const acceptedResult = completedResult as WorkerResult
        this.#record(
          "task.reconciled",
          { previousStatus: "running", action: "accept-completed-event", eventId: completedEvent.id },
          task.agentId,
          task.id,
        )
        task.status = "completed"
        task.result = structuredClone(acceptedResult)
        delete task.lease
        const completedAgent = this.#snapshot.agents.find((agent) => agent.id === task.agentId)
        if (completedAgent) {
          completedAgent.status = "completed"
          completedAgent.finishedAt = completedEvent.timestamp
        }
        for (const evidence of acceptedResult.evidence) {
          if (!this.#snapshot.evidence.some((item) => item.id === evidence.id)) {
            this.#snapshot.evidence.push(structuredClone(evidence))
          }
        }
        for (const finding of acceptedResult.findings) {
          const existing = this.#snapshot.findings.find((item) => item.id === finding.id)
          if (existing) Object.assign(existing, structuredClone(finding))
          else this.#snapshot.findings.push(structuredClone(finding))
        }
        continue
      }
      if (completedEvent && completedResult && (contractRejection || policyRejection || evidenceRejection)) {
        this.#record(
          "task.result.rejected",
          { reason: contractRejection ?? policyRejection ?? evidenceRejection },
          task.agentId,
          task.id,
        )
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

  #restorePendingApprovalFromEvents(): void {
    const events = this.events.list()
    const awaiting = events.findLast((event) => event.type === "root.decision.awaiting_approval")
    if (!awaiting) return
    const approvalId = (awaiting.payload as { approvalId?: unknown }).approvalId
    if (typeof approvalId !== "string") return
    const resolution = events.findLast((event) => {
      if (event.type !== "root.decision.approved" && event.type !== "root.decision.denied") return false
      return (event.payload as { approvalId?: unknown }).approvalId === approvalId
    })
    if (resolution?.type === "root.decision.denied") {
      if (this.#snapshot.pendingApproval?.id === approvalId) delete this.#snapshot.pendingApproval
      return
    }
    if (this.#snapshot.pendingApproval?.id === approvalId) {
      if (resolution?.type === "root.decision.approved") this.#snapshot.pendingApproval.status = "approved"
      return
    }
    if (this.#snapshot.pendingApproval) return
    const proposed = events.findLast((event) =>
      event.type === "root.decision.proposed" && event.sequence < awaiting.sequence
    )
    if (!proposed || rootDecisionContractError(proposed.payload)) return
    const decision = proposed.payload as RootDecision
    if (decision.action.kind !== "delegate") return
    this.#snapshot.pendingApproval = {
      id: approvalId,
      requestedAt: awaiting.timestamp,
      status: resolution?.type === "root.decision.approved" ? "approved" : "pending",
      decision: structuredClone({ version: decision.version, action: decision.action }),
    }
  }

  #restoreTerminalStateFromEvents(): void {
    const terminal = this.events.list().findLast((event) =>
      event.type === "engagement.completed" || event.type === "engagement.cancelled"
    )
    if (!terminal || this.#snapshot.status === terminal.type.slice("engagement.".length)) return
    const status = terminal.type === "engagement.completed" ? "completed" : "cancelled"
    this.#snapshot.status = status
    this.#snapshot.finishedAt = terminal.timestamp
    delete this.#snapshot.pendingApproval
    for (const task of this.#snapshot.tasks.filter((item) => item.status === "running")) {
      task.status = "cancelled"
      delete task.lease
    }
    for (const agent of this.#snapshot.agents.filter((item) => item.status === "running" || item.status === "waiting")) {
      agent.status = status === "completed" && agent.role === "root" ? "completed" : "cancelled"
      agent.finishedAt = terminal.timestamp
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

  #requestApproval(decision: RootDecision & { action: Extract<RootDecision["action"], { kind: "delegate" }> }): void {
    const approval: PendingApproval = {
      id: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      status: "pending",
      decision: structuredClone(decision),
    }
    this.#snapshot.pendingApproval = approval
    const root = this.#snapshot.agents.find((agent) => agent.id === "root-agent")
    if (root) root.status = "waiting"
    this.#record(
      "root.decision.awaiting_approval",
      {
        approvalId: approval.id,
        rationale: decision.action.rationale,
        tasks: decision.action.tasks.map(({ id, role, objective, target, capabilities }) => ({
          id, role, objective, target, capabilities,
        })),
      },
      "root-agent",
    )
    this.#persist()
    if (this.#autoApprove) this.approvePending()
  }

  #waitForApproval(): Promise<boolean> {
    const approval = this.#snapshot.pendingApproval
    if (!approval) return Promise.resolve(false)
    if (approval.status === "approved") return Promise.resolve(true)
    if (this.#autoApprove) return Promise.resolve(this.approvePending())
    return new Promise((resolve) => {
      this.#approvalWaiter = resolve
    })
  }

  #applyApprovedDecision(): void {
    const approval = this.#snapshot.pendingApproval
    if (!approval || approval.status !== "approved") return
    for (const spec of approval.decision.action.tasks) {
      const existing = this.#snapshot.tasks.find((task) => task.id === spec.id)
      if (existing) {
        if (existing.inputHash !== taskInputHash(spec)) throw new Error(`Approved task identity mismatch: ${spec.id}`)
        continue
      }
      this.#queue(spec)
    }
    delete this.#snapshot.pendingApproval
    this.#persist()
  }

  #pendingApprovalError(approval: PendingApproval): string | undefined {
    const contractRejection = pendingApprovalContractError(approval)
    if (contractRejection) return `Stored approval rejected: ${contractRejection}`
    const missing: TaskSpec[] = []
    for (const spec of approval.decision.action.tasks) {
      const existing = this.#snapshot.tasks.find((task) => task.id === spec.id)
      if (!existing) missing.push(spec)
      else if (existing.inputHash !== taskInputHash(spec)) return `Approved task identity mismatch: ${spec.id}`
    }
    if (!missing.length) return undefined
    return this.#validateDecision({
      version: approval.decision.version,
      action: { ...approval.decision.action, tasks: missing },
    })
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
    // Number agents per role, so a swarm with three web workers is readable.
    const existingName = this.#snapshot.agents.find((agent) => agent.id === agentId)?.name
    const ordinal = this.#snapshot.agents.filter((agent) => agent.role === task.role).length + 1
    const agentState: AgentRecord = {
      id: agentId,
      role: task.role,
      name: existingName ?? `${task.role}-${String(ordinal).padStart(2, "0")}`,
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
      const candidate = task.role === "validator" && task.findingId
        ? this.#snapshot.findings.find((finding) => finding.id === task.findingId)
        : undefined
      // The record and the artifacts behind it, never the discoverer's transcript.
      const candidateEvidence = candidate
        ? this.#snapshot.evidence.filter((item) => candidate.evidenceIds.includes(item.id))
        : undefined
      const result = await this.#runtime.runTask(task, {
        engagementId: this.#snapshot.manifest.id,
        agentId,
        role: task.role,
        systemPrompt,
        scope: structuredClone(this.#snapshot.manifest.scope),
        remainingBudget: this.#remainingBudget(),
        tools,
        evidenceStore: this.#evidenceStore,
        ...(candidate ? { candidate: structuredClone(candidate) } : {}),
        ...(candidateEvidence ? { candidateEvidence: structuredClone(candidateEvidence) } : {}),
      })
      clearInterval(heartbeat)
      const contractRejection = workerResultContractError(result)
      if (contractRejection) {
        this.#record("task.result.rejected", { reason: contractRejection }, agentId, task.id)
        throw new Error(`Worker result rejected: ${contractRejection}`)
      }
      this.#applyUsage(result)
      const policyRejection = workerResultPolicyError(result, task, this.#snapshot, agentId)
      if (policyRejection) {
        this.#record("task.result.rejected", { reason: policyRejection }, agentId, task.id)
        throw new Error(`Worker result rejected: ${policyRejection}`)
      }
      const evidenceRejection = await this.#evidenceAdmissionError(result)
      if (evidenceRejection) {
        this.#record("task.result.rejected", { reason: evidenceRejection }, agentId, task.id)
        throw new Error(`Worker result rejected: ${evidenceRejection}`)
      }
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
    const validatorFindings = new Set<string>()
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
      // A role says what a task is for; the output shape says what it must
      // return. A specialist is an assessment like any other — the lens is not
      // a different kind of answer, and it is not a different permission.
      const expectedOutput = {
        recon: "inventory",
        validator: "validation",
        reporter: "report",
      }[task.role as "recon" | "validator" | "reporter"] ?? "assessment"
      if (task.expectedOutput !== expectedOutput) return `Role/output mismatch: ${task.id}`
      if (task.dependencies.includes(task.id)) return `Self dependency rejected: ${task.id}`
      if (task.parentTaskId === task.id) return `Self parent rejected: ${task.id}`
      if (task.parentTaskId && !knownIds.has(task.parentTaskId)) return `Unknown parent task in ${task.id}`
      const decision = evaluateScope(scope, task.target)
      if (!decision.allowed) return `Out-of-scope target: ${task.target} (${decision.reason})`
      if (task.capabilities.some((capability) => !scope.capabilities.includes(capability))) {
        return `Capability not granted: ${task.id}`
      }
      if (task.dependencies.some((id) => !knownIds.has(id))) return `Unknown dependency in ${task.id}`
      if (task.role === "validator") {
        const candidate = task.findingId
          ? this.#snapshot.findings.find((finding) => finding.id === task.findingId && finding.status === "candidate")
          : undefined
        if (!candidate || candidate.asset !== task.target) return `Validator task does not match a candidate: ${task.id}`
        if (validatorFindings.has(candidate.id)) return `Duplicate validator assignment: ${candidate.id}`
        validatorFindings.add(candidate.id)
      } else if (task.findingId) {
        return `Only validator tasks may reference a finding: ${task.id}`
      }
    }
    const graph = new Map(this.#snapshot.tasks.map((task) => [task.id, task.dependencies]))
    for (const task of decision.action.tasks) graph.set(task.id, task.dependencies)
    if (hasDependencyCycle(graph)) return "Task dependency cycle rejected"
    return undefined
  }

  #enforceDeadline(): void {
    if (!this.#snapshot.startedAt) return
    const elapsed = Date.now() - Date.parse(this.#snapshot.startedAt)
    const allowed = this.#snapshot.manifest.budgets.maxDurationMs
    if (elapsed > allowed) {
      // Name the numbers: a run that did all its work and then tripped the clock
      // needs a bigger budget, not a bug report.
      const done = this.#snapshot.tasks.filter((task) => task.status === "completed").length
      throw new Error(
        `Engagement deadline exceeded: ${Math.round(elapsed / 1_000)}s elapsed of the `
        + `${Math.round(allowed / 1_000)}s allowed by budgets.maxDurationMs, with `
        + `${done} of ${this.#snapshot.tasks.length} task(s) completed`,
      )
    }
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
    const usageError = resourceUsageContractError(result.usage)
    if (usageError) throw new Error(`Resource usage rejected: ${usageError}`)
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

  async #evidenceAdmissionError(result: WorkerResult): Promise<string | undefined> {
    for (const reference of result.evidence) {
      let canonical: EvidenceRef | undefined
      let verified = false
      try {
        canonical = await this.#evidenceStore.metadata(reference)
        if (canonical) verified = await this.#evidenceStore.verify(canonical)
      } catch {
        return `Evidence ${reference.id} is inaccessible in the configured store`
      }
      if (!canonical) return `Evidence ${reference.id} is missing from the configured store`
      if (!sameEvidenceMetadata(reference, canonical)) return `Evidence ${reference.id} metadata does not match the store`
      if (!verified) return `Evidence ${reference.id} failed integrity verification`
    }
    return undefined
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
    skillId: task.skillId ?? null,
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

/** Whether an asset is a repository root, and therefore not observable at runtime. */
function isStaticTarget(asset: string, snapshot: EngagementSnapshot): boolean {
  const parsed = tryParseTarget(asset)
  if (typeof parsed !== "string" && parsed.kind === "repo") return true
  // An asset that names no kind of its own is still static when the only scope
  // entry admitting it is a repository root.
  return snapshot.manifest.scope.targets.some((expression) => {
    const target = tryParseTarget(expression)
    return typeof target !== "string" && target.kind === "repo" && asset.startsWith(target.root)
  })
}

export function workerResultPolicyError(
  result: WorkerResult,
  task: TaskSpec,
  snapshot: EngagementSnapshot,
  agentId: string,
): string | undefined {
  if (task.role === "reporter") {
    if (result.observations.length || result.findings.length) return "Reporter cannot mutate observations or findings"
    if (typeof result.report !== "string") return "Reporter result requires a report"
  } else if (result.report !== undefined) {
    return "Only the reporter may return report content"
  }
  if (task.role === "recon" && result.findings.length) return "Recon cannot create findings"

  const evidenceIds = new Set<string>()
  const acceptedEvidenceIds = new Set(snapshot.evidence.map((evidence) => evidence.id))
  const artifactPrefix = `artifact://${snapshot.manifest.id}/`
  for (const evidence of result.evidence) {
    if (evidenceIds.has(evidence.id) || acceptedEvidenceIds.has(evidence.id)) return `Duplicate evidence ID: ${evidence.id}`
    if (evidence.source !== agentId) return `Evidence ${evidence.id} is not owned by ${agentId}`
    if (!evidence.uri.startsWith(artifactPrefix)) return `Evidence ${evidence.id} has an invalid engagement URI`
    const filename = evidence.uri.slice(artifactPrefix.length)
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)
      || (filename !== evidence.id && !filename.startsWith(`${evidence.id}.`))
    ) {
      return `Evidence ${evidence.id} has an invalid artifact filename`
    }
    evidenceIds.add(evidence.id)
    acceptedEvidenceIds.add(evidence.id)
  }

  const observationIds = new Set<string>()
  for (const observation of result.observations) {
    if (observationIds.has(observation.id)) return `Duplicate observation ID: ${observation.id}`
    if (observation.asset !== task.target) return `Observation ${observation.id} changed the assigned target`
    if (observation.source !== agentId) return `Observation ${observation.id} has invalid provenance`
    const missing = observation.evidenceIds.find((id) => !acceptedEvidenceIds.has(id))
    if (missing) return `Observation ${observation.id} references unknown evidence ${missing}`
    // A discovered address is a report, not a permission. Every one is held to
    // the manifest here, so a worker cannot widen an engagement by naming
    // somewhere new — however it came to know about it.
    for (const asset of observation.assets ?? []) {
      const decision = evaluateScope(snapshot.manifest.scope, asset)
      if (!decision.allowed) {
        return `Observation ${observation.id} reports an out-of-scope asset: ${asset} (${decision.reason})`
      }
    }
    observationIds.add(observation.id)
  }

  // A proposal is a request, and the same rule that governs a discovered
  // address governs it: naming somewhere is not permission to go there. A
  // proposal outside the manifest fails the whole result rather than being
  // dropped quietly, because a worker asking for it is worth seeing.
  for (const [index, proposal] of (result.proposedTasks ?? []).entries()) {
    const decision = evaluateScope(snapshot.manifest.scope, proposal.target)
    if (!decision.allowed) {
      return `proposedTasks[${index}] targets outside the approved scope: ${proposal.target} (${decision.reason})`
    }
    const ungranted = proposal.capabilities.find(
      (capability) => !snapshot.manifest.scope.capabilities.includes(capability),
    )
    if (ungranted) return `proposedTasks[${index}] asks for an ungranted capability: ${ungranted}`
    if (proposal.role === "reporter") return `proposedTasks[${index}] may not delegate the report`
  }

  const findingIds = new Set<string>()
  for (const finding of result.findings) {
    if (findingIds.has(finding.id)) return `Duplicate finding ID: ${finding.id}`
    if (finding.asset !== task.target) return `Finding ${finding.id} changed the assigned target`
    const missing = finding.evidenceIds.find((id) => !acceptedEvidenceIds.has(id))
    if (missing) return `Finding ${finding.id} references unknown evidence ${missing}`
    findingIds.add(finding.id)
  }

  // Nothing in a repository observes a running system, so nothing found there
  // can be confirmed. A static claim stays a candidate until a runtime target
  // reproduces it.
  for (const finding of result.findings) {
    if (finding.status !== "confirmed") continue
    if (!isStaticTarget(finding.asset, snapshot)) continue
    return `Finding ${finding.id} is a static claim about a repository and cannot be confirmed; `
      + "reproduce it against a runtime target first"
  }

  if (task.role === "validator") {
    if (!task.findingId || result.findings.length !== 1) return "Validator must return exactly one assigned finding"
    const existing = snapshot.findings.find((finding) => finding.id === task.findingId)
    const verdict = result.findings[0]
    if (!existing || !verdict || verdict.id !== task.findingId) return "Validator returned an unassigned finding"
    if (!["confirmed", "rejected", "inconclusive"].includes(verdict.status)) return "Validator returned a non-final status"
    if (verdict.validatedBy !== agentId) return "Validator result has invalid validator provenance"
    if (
      verdict.discoveredBy !== existing.discoveredBy
      || verdict.title !== existing.title
      || verdict.asset !== existing.asset
      || verdict.severity !== existing.severity
      || verdict.skillId !== existing.skillId
    ) return "Validator changed immutable candidate fields"
    if (!existing.evidenceIds.every((id) => verdict.evidenceIds.includes(id))) {
      return "Validator removed discovery evidence"
    }
    if (!verdict.evidenceIds.some((id) => evidenceIds.has(id))) return "Validator did not attach fresh evidence"
    if (verdict.reproduction) {
      const { bundleId, verdict: reproduced } = verdict.reproduction
      if (!evidenceIds.has(bundleId)) return `Reproduction bundle ${bundleId} was not captured by this validation`
      if (!verdict.evidenceIds.includes(bundleId)) return `Finding ${verdict.id} does not cite its reproduction bundle`
      const implied = { reproduced: "confirmed", "not-reproduced": "rejected", inconclusive: "inconclusive" }[reproduced]
      if (verdict.status !== implied) {
        return `Reproduction verdict ${reproduced} does not support status ${verdict.status}`
      }
    }
    return undefined
  }

  for (const finding of result.findings) {
    if (snapshot.findings.some((existing) => existing.id === finding.id)) return `Finding ID already exists: ${finding.id}`
    if (finding.status !== "candidate") return `Worker finding ${finding.id} must begin as a candidate`
    if (finding.discoveredBy !== agentId || finding.validatedBy !== undefined) {
      return `Worker finding ${finding.id} has invalid discovery provenance`
    }
    if (!finding.evidenceIds.some((id) => evidenceIds.has(id))) return `Worker finding ${finding.id} has no fresh evidence`
    if (finding.reproduction) return `Worker finding ${finding.id} cannot claim a reproduction it did not run`
  }
  return undefined
}

function hasDependencyCycle(graph: ReadonlyMap<string, readonly string[]>): boolean {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const dependency of graph.get(id) ?? []) {
      if (graph.has(dependency) && visit(dependency)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }
  return [...graph.keys()].some(visit)
}

function boundedOperatorReason(reason: string): string {
  const clean = reason
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .trim()
    .slice(0, 1_024)
  return clean || "Delegation denied by operator"
}

function sameEvidenceMetadata(left: EvidenceRef, right: EvidenceRef): boolean {
  return left.id === right.id
    && left.kind === right.kind
    && left.uri === right.uri
    && left.sha256 === right.sha256
    && left.capturedAt === right.capturedAt
    && left.source === right.source
    && left.contentType === right.contentType
    && left.sizeBytes === right.sizeBytes
}
