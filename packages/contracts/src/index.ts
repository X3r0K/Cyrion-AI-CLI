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
  | "task.result.rejected"
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
  const error = manifestContractError(value)
  if (error) throw new Error(`Invalid engagement manifest: ${error}`)
}

export function manifestContractError(value: unknown): string | undefined {
  if (!isRecord(value)) return "manifest must be an object"
  const extra = unexpectedKey(value, ["id", "name", "objective", "profile", "mode", "scope", "budgets"])
  if (extra) return `unexpected field ${extra}`
  if (!validIdentifier(value.id)) return "id must be a safe identifier"
  if (!validText(value.name, 256)) return "name must be a non-empty string of at most 256 characters"
  if (!validText(value.objective, 8_192)) return "objective must be a non-empty string of at most 8192 characters"
  if (value.profile !== "web-api" && value.profile !== "repository") return "profile is unsupported"
  if (value.mode !== "supervised" && value.mode !== "autonomous") return "mode is unsupported"
  if (!isRecord(value.scope)) return "scope must be an object"
  const scopeExtra = unexpectedKey(value.scope, ["targets", "excluded", "capabilities"])
  if (scopeExtra) return `scope contains unexpected field ${scopeExtra}`
  const targetsError = stringListError(value.scope.targets, "scope.targets", { minimum: 1, safe: false })
  if (targetsError) return targetsError
  const excludedError = stringListError(value.scope.excluded, "scope.excluded", { minimum: 0, safe: false })
  if (excludedError) return excludedError
  const capabilitiesError = stringListError(value.scope.capabilities, "scope.capabilities", { minimum: 1, safe: true })
  if (capabilitiesError) return capabilitiesError
  const targets = value.scope.targets as string[]
  const excluded = value.scope.excluded as string[]
  if (excluded.some((target) => targets.includes(target))) return "scope target cannot also be excluded"
  if (!isRecord(value.budgets)) return "budgets must be an object"
  const budgetKeys = [
    "maxConcurrentAgents", "maxAgents", "maxDepth", "maxTasks", "maxDurationMs", "maxTokens", "maxCostUsd",
  ]
  const budgetExtra = unexpectedKey(value.budgets, budgetKeys)
  if (budgetExtra) return `budgets contains unexpected field ${budgetExtra}`
  for (const key of budgetKeys.filter((item) => item !== "maxCostUsd")) {
    if (!positiveSafeInteger(value.budgets[key])) return `budgets.${key} must be a positive safe integer`
  }
  if (!finiteNumber(value.budgets.maxCostUsd) || value.budgets.maxCostUsd < 0) {
    return "budgets.maxCostUsd must be a non-negative finite number"
  }
  if (Number(value.budgets.maxConcurrentAgents) > Number(value.budgets.maxAgents)) {
    return "budgets.maxConcurrentAgents cannot exceed maxAgents"
  }
  return undefined
}

export function rootDecisionContractError(value: unknown): string | undefined {
  if (!isRecord(value)) return "decision must be an object"
  const extra = unexpectedKey(value, ["version", "action"])
  if (extra) return `decision contains unexpected field ${extra}`
  if (value.version !== CONTRACT_VERSION) return "unsupported contract version"
  if (!isRecord(value.action)) return "action must be an object"
  const action = value.action
  if (!validText(action.rationale, 4_096)) return "action.rationale must be a non-empty bounded string"
  if (action.kind === "delegate") {
    const actionExtra = unexpectedKey(action, ["kind", "rationale", "tasks"])
    if (actionExtra) return `delegate action contains unexpected field ${actionExtra}`
    if (!Array.isArray(action.tasks) || action.tasks.length < 1 || action.tasks.length > 1_000) {
      return "delegate action requires 1 to 1000 tasks"
    }
    for (let index = 0; index < action.tasks.length; index += 1) {
      const error = taskSpecContractError(action.tasks[index], `action.tasks[${index}]`)
      if (error) return error
    }
    return undefined
  }
  if (action.kind === "finish") {
    const actionExtra = unexpectedKey(action, ["kind", "rationale"])
    return actionExtra ? `finish action contains unexpected field ${actionExtra}` : undefined
  }
  if (action.kind === "stop") {
    const actionExtra = unexpectedKey(action, ["kind", "rationale", "reason"])
    if (actionExtra) return `stop action contains unexpected field ${actionExtra}`
    return ["budget", "deadline", "policy", "operator"].includes(String(action.reason))
      ? undefined
      : "stop action reason is unsupported"
  }
  return "action.kind is unsupported"
}

export function assertRootDecision(value: unknown): asserts value is RootDecision {
  const error = rootDecisionContractError(value)
  if (error) throw new Error(`Invalid RootDecision: ${error}`)
}

export function workerResultContractError(value: unknown): string | undefined {
  if (!isRecord(value)) return "result must be an object"
  const extra = unexpectedKey(value, ["summary", "observations", "findings", "evidence", "report", "usage"])
  if (extra) return `result contains unexpected field ${extra}`
  if (!validText(value.summary, 16_384)) return "summary must be a non-empty bounded string"
  if (!Array.isArray(value.observations)) return "observations must be an array"
  if (!Array.isArray(value.findings)) return "findings must be an array"
  if (!Array.isArray(value.evidence)) return "evidence must be an array"
  if (value.observations.length > 1_000 || value.findings.length > 1_000 || value.evidence.length > 2_000) {
    return "result collection limit exceeded"
  }
  for (let index = 0; index < value.observations.length; index += 1) {
    const error = observationContractError(value.observations[index], `observations[${index}]`)
    if (error) return error
  }
  for (let index = 0; index < value.findings.length; index += 1) {
    const error = findingContractError(value.findings[index], `findings[${index}]`)
    if (error) return error
  }
  for (let index = 0; index < value.evidence.length; index += 1) {
    const error = evidenceContractError(value.evidence[index], `evidence[${index}]`)
    if (error) return error
  }
  if ("report" in value && !validText(value.report, 1_048_576, true)) return "report must be a bounded string"
  if ("usage" in value) {
    const usageError = resourceUsageContractError(value.usage)
    if (usageError) return usageError
  }
  return undefined
}

export function assertWorkerResult(value: unknown): asserts value is WorkerResult {
  const error = workerResultContractError(value)
  if (error) throw new Error(`Invalid WorkerResult: ${error}`)
}

export function resourceUsageContractError(value: unknown): string | undefined {
  if (!isRecord(value)) return "usage must be an object"
  const usageExtra = unexpectedKey(value, ["inputTokens", "outputTokens", "costUsd"])
  if (usageExtra) return `usage contains unexpected field ${usageExtra}`
  if (!nonNegativeSafeInteger(value.inputTokens) || !nonNegativeSafeInteger(value.outputTokens)) {
    return "usage token counts must be non-negative safe integers"
  }
  if (!finiteNumber(value.costUsd) || value.costUsd < 0) return "usage cost must be non-negative and finite"
  return undefined
}

function taskSpecContractError(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`
  const extra = unexpectedKey(value, [
    "id", "key", "parentTaskId", "role", "objective", "target", "capabilities", "dependencies", "depth",
    "expectedOutput", "findingId",
  ])
  if (extra) return `${path} contains unexpected field ${extra}`
  if (!validIdentifier(value.id)) return `${path}.id must be a safe identifier`
  if (!validText(value.key, 512)) return `${path}.key must be a non-empty bounded string`
  if ("parentTaskId" in value && !validIdentifier(value.parentTaskId)) return `${path}.parentTaskId is invalid`
  if (!["recon", "web", "api", "validator", "reporter"].includes(String(value.role))) return `${path}.role is unsupported`
  if (!validText(value.objective, 8_192)) return `${path}.objective must be a non-empty bounded string`
  if (!validTokenText(value.target, 2_048)) return `${path}.target must be a non-empty bounded string`
  const capabilitiesError = stringListError(value.capabilities, `${path}.capabilities`, { minimum: 1, safe: true })
  if (capabilitiesError) return capabilitiesError
  const dependenciesError = stringListError(value.dependencies, `${path}.dependencies`, { minimum: 0, safe: true })
  if (dependenciesError) return dependenciesError
  if (!positiveSafeInteger(value.depth)) return `${path}.depth must be a positive safe integer`
  if (!["inventory", "assessment", "validation", "report"].includes(String(value.expectedOutput))) {
    return `${path}.expectedOutput is unsupported`
  }
  if ("findingId" in value && !validIdentifier(value.findingId)) return `${path}.findingId is invalid`
  return undefined
}

function observationContractError(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`
  const extra = unexpectedKey(value, ["id", "asset", "summary", "source", "evidenceIds"])
  if (extra) return `${path} contains unexpected field ${extra}`
  if (!validIdentifier(value.id)) return `${path}.id is invalid`
  if (!validTokenText(value.asset, 2_048) || !validText(value.summary, 16_384) || !validIdentifier(value.source)) {
    return `${path} contains invalid text or source fields`
  }
  return stringListError(value.evidenceIds, `${path}.evidenceIds`, { minimum: 1, safe: true })
}

function findingContractError(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`
  const extra = unexpectedKey(value, [
    "id", "title", "asset", "severity", "status", "summary", "discoveredBy", "validatedBy", "evidenceIds",
  ])
  if (extra) return `${path} contains unexpected field ${extra}`
  if (!validIdentifier(value.id)) return `${path}.id is invalid`
  if (!validText(value.title, 512) || !validTokenText(value.asset, 2_048) || !validText(value.summary, 16_384)) {
    return `${path} contains invalid text fields`
  }
  if (!["info", "low", "medium", "high", "critical"].includes(String(value.severity))) return `${path}.severity is invalid`
  if (!["candidate", "validating", "confirmed", "rejected", "inconclusive"].includes(String(value.status))) {
    return `${path}.status is invalid`
  }
  if (!validIdentifier(value.discoveredBy)) return `${path}.discoveredBy is invalid`
  if ("validatedBy" in value && !validIdentifier(value.validatedBy)) return `${path}.validatedBy is invalid`
  return stringListError(value.evidenceIds, `${path}.evidenceIds`, { minimum: 1, safe: true })
}

function evidenceContractError(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`
  const extra = unexpectedKey(value, ["id", "kind", "uri", "sha256", "capturedAt", "source", "contentType", "sizeBytes"])
  if (extra) return `${path} contains unexpected field ${extra}`
  if (!validIdentifier(value.id)) return `${path}.id is invalid`
  if (!["fixture", "request", "response", "log", "report"].includes(String(value.kind))) return `${path}.kind is invalid`
  if (!validTokenText(value.uri, 2_048) || !/^[a-f0-9]{64}$/.test(String(value.sha256))) return `${path} has invalid URI or SHA-256`
  if (typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt))) return `${path}.capturedAt is invalid`
  if ("source" in value && !validIdentifier(value.source)) return `${path}.source is invalid`
  if ("contentType" in value && !validTokenText(value.contentType, 128)) return `${path}.contentType is invalid`
  if ("sizeBytes" in value && !nonNegativeSafeInteger(value.sizeBytes)) return `${path}.sizeBytes is invalid`
  return undefined
}

function stringListError(
  value: unknown,
  path: string,
  options: { minimum: number; safe: boolean },
): string | undefined {
  if (!Array.isArray(value) || value.length < options.minimum || value.length > 1_000) {
    return `${path} must be an array with ${options.minimum} to 1000 entries`
  }
  if (value.some((item) => options.safe ? !validIdentifier(item) : !validTokenText(item, 2_048))) {
    return `${path} contains an invalid entry`
  }
  if (new Set(value).size !== value.length) return `${path} contains duplicate entries`
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function unexpectedKey(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key))
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    && value !== "."
    && value !== ".."
}

function validText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string"
    && value.length <= maximum
    && (allowEmpty || value.trim().length > 0)
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(value)
}

function validTokenText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length <= maximum
    && value.trim().length > 0
    && !/[\u0000-\u001F\u007F-\u009F]/.test(value)
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}
