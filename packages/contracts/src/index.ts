export const CONTRACT_VERSION = "cyrion.community/v1" as const

export type AgentRole = "root" | "recon" | "web" | "api" | "validator" | "reporter"
export type AgentStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled"
export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled"
export type FindingStatus = "candidate" | "validating" | "confirmed" | "rejected" | "inconclusive"
export type Severity = "info" | "low" | "medium" | "high" | "critical"

export interface ScopePolicy {
  targets: string[]
  excluded: string[]
  capabilities: string[]
}

export interface EngagementBudgets {
  maxConcurrentAgents: number
  maxAgents: number
  maxDepth: number
  maxTasks: number
  maxDurationMs: number
  maxTokens: number
  maxCostUsd: number
}

export interface EngagementManifest {
  id: string
  name: string
  objective: string
  profile: "web-api" | "repository"
  mode: "supervised" | "autonomous"
  scope: ScopePolicy
  budgets: EngagementBudgets
}

export interface TaskSpec {
  id: string
  key: string
  parentTaskId?: string
  role: Exclude<AgentRole, "root">
  objective: string
  target: string
  capabilities: string[]
  dependencies: string[]
  depth: number
  expectedOutput: "inventory" | "assessment" | "validation" | "report"
  findingId?: string
}

export interface EvidenceRef {
  id: string
  kind: "fixture" | "request" | "response" | "log" | "report"
  uri: string
  sha256: string
  capturedAt: string
  source?: string
  contentType?: string
  sizeBytes?: number
}

export interface EvidenceCapture {
  engagementId: string
  id: string
  kind: EvidenceRef["kind"]
  content: string
  contentType: string
  source: string
  extension?: string
}

export interface EvidenceStore {
  capture(input: EvidenceCapture): Promise<EvidenceRef>
  read(reference: EvidenceRef): Promise<Uint8Array>
  verify(reference: EvidenceRef): Promise<boolean>
}

export interface Observation {
  id: string
  asset: string
  summary: string
  source: string
  evidenceIds: string[]
}

export interface Finding {
  id: string
  title: string
  asset: string
  severity: Severity
  status: FindingStatus
  summary: string
  discoveredBy: string
  validatedBy?: string
  evidenceIds: string[]
}

export interface WorkerResult {
  summary: string
  observations: Observation[]
  findings: Finding[]
  evidence: EvidenceRef[]
  report?: string
  usage?: ResourceUsage
}

export interface ResourceUsage {
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export type RootAction =
  | { kind: "delegate"; tasks: TaskSpec[]; rationale: string }
  | { kind: "finish"; rationale: string }
  | { kind: "stop"; reason: "budget" | "deadline" | "policy" | "operator"; rationale: string }

export interface RootDecision {
  version: typeof CONTRACT_VERSION
  action: RootAction
}

export type EventType =
  | "engagement.started"
  | "engagement.recovered"
  | "engagement.paused"
  | "engagement.resumed"
  | "engagement.cancelled"
  | "engagement.completed"
  | "engagement.failed"
  | "root.decision.proposed"
  | "root.decision.rejected"
  | "root.message"
  | "task.queued"
  | "task.started"
  | "task.lease.acquired"
  | "task.heartbeat"
  | "task.reconciled"
  | "task.cancelled"
  | "task.completed"
  | "task.failed"
  | "tool.request.accepted"
  | "tool.request.completed"
  | "tool.request.rejected"
  | "budget.updated"
  | "budget.exceeded"
  | "finding.updated"
  | "operator.message"

export interface CyrionEvent<T = unknown> {
  sequence: number
  id: string
  engagementId: string
  type: EventType
  timestamp: string
  agentId?: string
  taskId?: string
  payload: T
}

export interface AgentRecord {
  id: string
  role: AgentRole
  name: string
  taskId?: string
  parentId?: string
  status: AgentStatus
  startedAt?: string
  finishedAt?: string
}

export interface TaskRecord extends TaskSpec {
  status: TaskStatus
  inputHash: string
  attempt: number
  agentId?: string
  lease?: TaskLease
  result?: WorkerResult
}

export interface TaskLease {
  ownerId: string
  acquiredAt: string
  heartbeatAt: string
  expiresAt: string
}

export interface EngagementSnapshot {
  manifest: EngagementManifest
  status: "idle" | "running" | "paused" | "cancelled" | "completed" | "failed"
  startedAt?: string
  finishedAt?: string
  agents: AgentRecord[]
  tasks: TaskRecord[]
  findings: Finding[]
  evidence: EvidenceRef[]
  usage: ResourceUsage
  events: CyrionEvent[]
}

export interface RuntimeContext {
  engagementId: string
  agentId: string
  role: Exclude<AgentRole, "root">
  systemPrompt: string
  scope: ScopePolicy
  remainingBudget: EngagementBudgets
  tools: ToolGateway
}

export interface ToolInvocation {
  capability: string
  target: string
  timeoutMs: number
  maxOutputBytes: number
  input: unknown
}

export interface ToolExecutionRequest extends ToolInvocation {
  engagementId: string
  taskId: string
  agentId: string
}

export interface ToolExecutionResult<T = unknown> {
  output: T
  durationMs: number
  outputBytes: number
}

export interface ToolGateway {
  execute<T = unknown>(invocation: ToolInvocation): Promise<ToolExecutionResult<T>>
}

export interface ToolAdapter {
  execute(request: ToolExecutionRequest, signal: AbortSignal): Promise<unknown>
}

export interface AgentRuntime {
  runTask(task: TaskSpec, context: RuntimeContext): Promise<WorkerResult>
  cancel(agentId: string): Promise<void>
  close(): Promise<void>
}

export interface RootPlanner {
  decide(snapshot: EngagementSnapshot): Promise<RootDecision>
  takeUsage?(): ResourceUsage | undefined
  close(): Promise<void>
}

export function assertManifest(value: unknown): asserts value is EngagementManifest {
  if (!value || typeof value !== "object") throw new Error("Manifest must be an object")
  const manifest = value as Partial<EngagementManifest>
  if (!manifest.id || !manifest.objective || !manifest.scope || !manifest.budgets) {
    throw new Error("Manifest requires id, objective, scope, and budgets")
  }
  if (!manifest.scope.targets?.length) throw new Error("Scope requires at least one target")
  if (manifest.budgets.maxConcurrentAgents < 1 || manifest.budgets.maxAgents < 1) {
    throw new Error("Agent budgets must be positive")
  }
  if (manifest.budgets.maxDepth < 1) throw new Error("maxDepth must allow one worker level")
}
