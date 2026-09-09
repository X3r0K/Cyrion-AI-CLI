export const CONTRACT_VERSION = "cyrion.community/v1" as const

export type AgentRole =
  | "root"
  | "recon"
  | "web"
  | "api"
  | "validator"
  | "reporter"
  /**
   * Specialists a root or a worker can delegate to.
   *
   * A role is a lens, not a permission: what an agent may do still comes only
   * from the capabilities the manifest granted, and naming a role has never
   * widened one. They exist so a task carries what it is *for*, which is what
   * makes a delegation tree readable and lets a report say which line of
   * inquiry produced a finding.
   */
  | "injection"
  | "xss"
  | "ssrf"
  | "auth"
  | "authz"
  | "idor"
  | "race"
  | "logic"
  | "repo"

export const AGENT_ROLES: readonly AgentRole[] = [
  "root", "recon", "web", "api", "validator", "reporter",
  "injection", "xss", "ssrf", "auth", "authz", "idor", "race", "logic", "repo",
]

/** Roles a task may carry: everything except the root, which delegates rather than works. */
export const WORKER_ROLES: readonly Exclude<AgentRole, "root">[] =
  AGENT_ROLES.filter((role): role is Exclude<AgentRole, "root"> => role !== "root")
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

/**
 * What one host may be asked to endure, whoever is asking.
 *
 * The budgets above bound an engagement; these bound a *host*. The distinction
 * matters because the damage a swarm does is not spread across the estate, it
 * lands on whichever machine several workers happened to pick at once. An
 * engagement of twelve agents inside every budget can still be twelve
 * simultaneous scanners against one endpoint, which is the failure mode most
 * likely to take a target down and end an engagement badly.
 *
 * The unit is the host rather than the target expression, because a planner
 * dispatching `/a` and `/b` as two tasks has not found two machines to talk to.
 */
export interface EngagementLimits {
  /** Least time between two tool requests reaching one host. */
  minRequestGapMs: number
  /** Tool calls in flight against one host at a time. */
  maxConcurrentPerTarget: number
  /** Tool requests one host may receive across the whole engagement. */
  maxRequestsPerTarget: number
  /** Longest a call will wait for a slot before it is refused rather than queued. */
  maxQueueWaitMs: number
}

/**
 * Applied when a manifest states no limits of its own.
 *
 * Deliberately survivable rather than polite: ten requests a second to one host
 * with four in flight is well under what a scanner would do unbidden, and the
 * per-host ceiling stops a loop that never terminates from running all night.
 */
export const DEFAULT_ENGAGEMENT_LIMITS: EngagementLimits = {
  minRequestGapMs: 100,
  maxConcurrentPerTarget: 4,
  maxRequestsPerTarget: 2_000,
  maxQueueWaitMs: 30_000,
}

export interface EngagementManifest {
  id: string
  name: string
  objective: string
  profile: "web-api" | "repository"
  mode: "supervised" | "autonomous"
  scope: ScopePolicy
  budgets: EngagementBudgets
  /** Per-host pacing. Absent means `DEFAULT_ENGAGEMENT_LIMITS`. */
  limits?: EngagementLimits
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
  /** Methodology this task follows, so a report can state how a finding was produced. */
  skillId?: string
}

export interface EvidenceRef {
  id: string
  kind: "fixture" | "request" | "response" | "log" | "report" | "poc"
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
  metadata(reference: EvidenceRef): Promise<EvidenceRef | undefined>
  read(reference: EvidenceRef): Promise<Uint8Array>
  verify(reference: EvidenceRef): Promise<boolean>
}

export interface Observation {
  id: string
  asset: string
  summary: string
  source: string
  evidenceIds: string[]
  /**
   * Addresses this observation discovered, such as the endpoints a crawl found.
   *
   * Naming one is not approval to look at it: the controller checks every entry
   * against the manifest scope before the result is accepted, and the planner
   * checks again before anything is dispatched. A worker cannot widen an
   * engagement by reporting somewhere new.
   */
  assets?: string[]
}

/** Addresses one observation may report as discovered. */
export const MAX_DISCOVERED_ASSETS = 200

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
  /** Methodology that produced this finding, carried into the report. */
  skillId?: string
  /**
   * Whether an independent replay reproduced the claim, recorded separately
   * from severity: a serious finding nobody could reproduce is still a finding
   * nobody could reproduce.
   */
  reproduction?: FindingReproduction
}

export interface FindingReproduction {
  verdict: PocVerdict
  /** Evidence ID of the PoC bundle this verdict came from. */
  bundleId: string
  steps: number
  runner: "local" | "container"
  at: string
}


// ---------------------------------------------------------------------------
// Exploitation. A plan is a bounded, declarative sequence the controller can
// execute, replay, and hand to an operator — still never a script a model
// wrote, because a plan is what makes a run reproducible and reviewable.
//
// What it may do is what an authorized assessment actually needs: any method,
// a request body, an authenticated session, and a chain long enough to prove
// something. A test that cannot write, cannot log in, and cannot follow a
// redirect cannot demonstrate a broken access control, which is most of what a
// real engagement is for.
//
// Two bounds remain, and neither is about what the operator is allowed to
// prove. Volume is capped — a rate limit and a wall clock — because accidentally
// exhausting a client's service is the one outcome no engagement wants and no
// finding needs. And a credential a step sends is redacted in the stored
// bundle: authenticating is the point, but a proof an operator forwards to a
// client should not carry their session token.
// ---------------------------------------------------------------------------

export const POC_VERSION = "cyrion.community/poc-v1" as const

export type PocMethod = "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE"
export type PocVerdict = "reproduced" | "not-reproduced" | "inconclusive"

export const POC_METHODS: readonly PocMethod[] = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]

/**
 * Headers whose value is a secret.
 *
 * Sending one is allowed and necessary — you cannot test authorization without
 * authenticating. The name is kept in the bundle so a reader knows the request
 * was authenticated; the value is replaced with a placeholder, so the artifact
 * proves what happened without handing the reader a live credential.
 */
export const POC_SECRET_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "api-key",
] as const

export const POC_REDACTED = "[redacted by cyrion]"

/** Whether this header's value is a secret that must not reach a stored artifact. */
export function isSecretHeader(name: string): boolean {
  return (POC_SECRET_HEADERS as readonly string[]).includes(name.toLowerCase())
}

/** Header map with every secret value replaced, for anything written to disk. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    safe[name] = isSecretHeader(name) ? POC_REDACTED : value
  }
  return safe
}

export interface PocExpectation {
  /** The response status must be one of these. */
  status?: number[]
  /** Every named header must be present. */
  headersPresent?: string[]
  /** Every named header must be absent. */
  headersAbsent?: string[]
  /** Case-insensitive substring the content type must contain. */
  contentType?: string
  /** Proof marker the body must contain, matched literally. */
  bodyIncludes?: string
  /** Text the body must not contain. */
  bodyExcludes?: string
  /**
   * Alternatives, of which at least one must hold.
   *
   * Everything else stated here must hold as well: `anyOf` widens a claim, it
   * never replaces it. "Any one of these five headers is absent" is the shape
   * most methodology actually has, and without it such a claim can only be
   * written in code. One level deep on purpose — a nested condition tree is not
   * something a reader can check at a glance, and a proof nobody can read is
   * not proof.
   */
  anyOf?: PocExpectation[]
}

/** Alternatives one expectation may offer. */
export const POC_MAX_ALTERNATIVES = 8

export interface PocStep {
  id: string
  description: string
  method: PocMethod
  url: string
  headers?: Record<string, string>
  /** Request body, for the methods that carry one. Recorded in the bundle. */
  body?: string
  expect: PocExpectation
}

/** A body large enough for a real payload, bounded so a bundle stays readable. */
export const POC_MAX_BODY_BYTES = 65_536

export interface PocPlan {
  version: typeof POC_VERSION
  findingId: string
  title: string
  /** Why these steps prove the claim, in the operator's language. */
  rationale: string
  steps: PocStep[]
}

export interface PocStepRecord {
  id: string
  description: string
  /** Exactly what ran, so the bundle reproduces without Cyrion. */
  argv: string[]
  request: { method: PocMethod; url: string; headers: Record<string, string> }
  response?: {
    status: number
    headerNames: string[]
    contentType?: string
    bodyBytes: number
    bodySha256: string
    truncated: boolean
  }
  /** Artifact holding the raw exchange. */
  evidenceId?: string
  exitCode: number
  durationMs: number
  met: boolean
  detail: string
}

export interface PocBundle {
  version: typeof POC_VERSION
  engagementId: string
  findingId: string
  createdAt: string
  runner: "local" | "container"
  tool: { binary: string; version?: string }
  /** Environment the steps ran with. Never the operator's own. */
  environment: Record<string, string>
  /** Addresses each hostname was held to for the whole run. */
  pins: Array<{ hostname: string; addresses: string[] }>
  plan: PocPlan
  steps: PocStepRecord[]
  verdict: PocVerdict
  /** A standalone shell script that repeats the run on a clean machine. */
  script: string
}

/**
 * Work a worker thinks should happen next.
 *
 * This is how an agent graph grows without a model ever dispatching anything.
 * A worker states the *shape* of the follow-up — the lens, the objective, the
 * target, what it would need — and the controller decides whether that task
 * exists: it assigns the identifier, the parent, and the depth, and it re-checks
 * the target against scope and the capabilities against the grant.
 *
 * Nothing here is chosen by the proposer that could widen the engagement. There
 * is deliberately no `depth`, no `parentTaskId`, and no `id` field: a worker
 * that could set its own depth could spawn forever, and one that could set its
 * own parent could hide where a request came from.
 */
export interface TaskProposal {
  role: Exclude<AgentRole, "root">
  objective: string
  target: string
  capabilities: string[]
  /** Why this is worth doing, recorded so a delegation tree explains itself. */
  rationale: string
  skillId?: string
}

export interface WorkerResult {
  summary: string
  observations: Observation[]
  findings: Finding[]
  evidence: EvidenceRef[]
  report?: string
  usage?: ResourceUsage
  /**
   * Follow-up work this worker suggests. Proposals are validated and dispatched
   * by the controller, or refused with a reason; a worker never learns whether
   * one was accepted by acting on it.
   */
  proposedTasks?: TaskProposal[]
}

/** Bounded so one worker cannot flood the queue faster than the budget notices. */
export const MAX_TASK_PROPOSALS = 8

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

export interface PendingApproval {
  id: string
  requestedAt: string
  status: "pending" | "approved"
  decision: RootDecision & { action: Extract<RootAction, { kind: "delegate" }> }
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
  | "root.decision.awaiting_approval"
  | "root.decision.approved"
  | "root.decision.denied"
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
  | "tool.request.progress"
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
  pendingApproval?: PendingApproval
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
  evidenceStore: EvidenceStore
  /**
   * The candidate a validator must reproduce: the record, never the
   * discovering worker's transcript.
   */
  candidate?: Finding
  /**
   * Artifacts the candidate cites. A validator may read what the target
   * actually returned; it still never sees how the discoverer reasoned.
   */
  candidateEvidence?: EvidenceRef[]
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
  /**
   * `progress` reports what a long-running tool is doing while it runs. It is
   * optional on purpose: an adapter that answers quickly should ignore it.
   */
  execute(request: ToolExecutionRequest, signal: AbortSignal, progress?: ToolProgress): Promise<unknown>
}

/** One short, operator-readable note about work still in flight. */
export type ToolProgress = (note: string) => void

export interface AgentRuntime {
  runTask(task: TaskSpec, context: RuntimeContext): Promise<WorkerResult>
  cancel(agentId: string): Promise<void>
  close(): Promise<void>
}

export interface RootDecisionReview {
  verdict: "accept" | "stop"
  rationale: string
}

/** Reviews one controller-generated transition. It may explain or stop, never rewrite. */
export interface RootDecisionReviewer {
  review(snapshot: EngagementSnapshot, proposal: RootDecision): Promise<RootDecisionReview>
  takeUsage?(): ResourceUsage | undefined
  close(): Promise<void>
}

export interface WorkerResultReview {
  verdict: "accept" | "flag"
  summary: string
}

export interface WorkerReviewOutcome {
  review: WorkerResultReview
  usage: ResourceUsage
}

/** Reviews one canonical worker result. Findings and evidence stay controller inputs. */
export interface WorkerResultReviewer {
  reviewTask(task: TaskSpec, context: RuntimeContext, result: WorkerResult): Promise<WorkerReviewOutcome>
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
  const extra = unexpectedKey(value, ["id", "name", "objective", "profile", "mode", "scope", "budgets", "limits"])
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
  const limitsError = engagementLimitsContractError(value.limits)
  if (limitsError) return limitsError
  return undefined
}

/**
 * Checks stated limits, and refuses ones that would be worse than none.
 *
 * An operator may pace a run harder than the default, and for a fragile target
 * they should. What they may not do is write a manifest whose limits are wide
 * enough to be meaningless, because a limit that permits a thousand concurrent
 * requests reads like a control while behaving like its absence — the reader of
 * the manifest would be misled, which is worse than the field not being there.
 */
export function engagementLimitsContractError(value: unknown, path = "limits"): string | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return `${path} must be an object`
  const keys = ["minRequestGapMs", "maxConcurrentPerTarget", "maxRequestsPerTarget", "maxQueueWaitMs"]
  const extra = unexpectedKey(value, keys)
  if (extra) return `${path} contains unexpected field ${extra}`
  for (const key of keys) {
    if (!(key in value)) return `${path}.${key} is required`
  }
  if (!Number.isSafeInteger(value.minRequestGapMs) || Number(value.minRequestGapMs) < 0) {
    return `${path}.minRequestGapMs must be a non-negative safe integer`
  }
  if (Number(value.minRequestGapMs) > 60_000) return `${path}.minRequestGapMs cannot exceed 60000`
  if (!positiveSafeInteger(value.maxConcurrentPerTarget)) {
    return `${path}.maxConcurrentPerTarget must be a positive safe integer`
  }
  if (Number(value.maxConcurrentPerTarget) > 64) return `${path}.maxConcurrentPerTarget cannot exceed 64`
  if (!positiveSafeInteger(value.maxRequestsPerTarget)) {
    return `${path}.maxRequestsPerTarget must be a positive safe integer`
  }
  if (!positiveSafeInteger(value.maxQueueWaitMs)) return `${path}.maxQueueWaitMs must be a positive safe integer`
  if (Number(value.maxQueueWaitMs) > 300_000) return `${path}.maxQueueWaitMs cannot exceed 300000`
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

export function pendingApprovalContractError(value: unknown): string | undefined {
  if (!isRecord(value)) return "approval must be an object"
  const extra = unexpectedKey(value, ["id", "requestedAt", "status", "decision"])
  if (extra) return `approval contains unexpected field ${extra}`
  if (!validIdentifier(value.id)) return "approval.id is invalid"
  if (typeof value.requestedAt !== "string" || !Number.isFinite(Date.parse(value.requestedAt))) {
    return "approval.requestedAt is invalid"
  }
  if (value.status !== "pending" && value.status !== "approved") return "approval.status is invalid"
  const decisionError = rootDecisionContractError(value.decision)
  if (decisionError) return `approval decision is invalid: ${decisionError}`
  const decision = value.decision as RootDecision
  return decision.action.kind === "delegate" ? undefined : "approval decision must delegate tasks"
}

/**
 * A proposal, checked for shape only.
 *
 * Whether the work may happen is a separate question the controller answers
 * against the manifest — scope, grant, depth, budget — because those depend on
 * the engagement and this does not. What is refused here is a proposal that
 * tried to decide something it does not get to decide: an identifier, a parent,
 * or a depth.
 */
export function taskProposalContractError(value: unknown, path = "proposal"): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`
  const extra = unexpectedKey(value, ["role", "objective", "target", "capabilities", "rationale", "skillId"])
  if (extra) return `${path} contains unexpected field ${extra}`
  if (!(WORKER_ROLES as readonly string[]).includes(String(value.role))) return `${path}.role is unsupported`
  if (!validText(value.objective, 1_024)) return `${path}.objective must be a non-empty bounded string`
  if (!validText(value.target, 2_048)) return `${path}.target must be a non-empty bounded string`
  if (!validText(value.rationale, 1_024)) return `${path}.rationale must be a non-empty bounded string`
  if (!Array.isArray(value.capabilities) || value.capabilities.length > 32) {
    return `${path}.capabilities must be an array of at most 32 entries`
  }
  for (const capability of value.capabilities) {
    if (!validText(capability, 128)) return `${path}.capabilities contains an invalid entry`
  }
  if ("skillId" in value && value.skillId !== undefined && !validIdentifier(value.skillId)) {
    return `${path}.skillId is invalid`
  }
  return undefined
}

export function workerResultContractError(value: unknown): string | undefined {
  if (!isRecord(value)) return "result must be an object"
  const extra = unexpectedKey(
    value,
    ["summary", "observations", "findings", "evidence", "report", "usage", "proposedTasks"],
  )
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
    const error = evidenceRefContractError(value.evidence[index], `evidence[${index}]`)
    if (error) return error
  }
  if ("proposedTasks" in value && value.proposedTasks !== undefined) {
    if (!Array.isArray(value.proposedTasks)) return "proposedTasks must be an array"
    if (value.proposedTasks.length > MAX_TASK_PROPOSALS) {
      return `proposedTasks limit exceeded: at most ${MAX_TASK_PROPOSALS}`
    }
    for (let index = 0; index < value.proposedTasks.length; index += 1) {
      const error = taskProposalContractError(value.proposedTasks[index], `proposedTasks[${index}]`)
      if (error) return error
    }
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


// ---------------------------------------------------------------------------
// PoC validation. The plan is the boundary: anything the runner will execute
// has to survive these checks first, so a widened plan is refused before a
// single request leaves the machine.
// ---------------------------------------------------------------------------

/**
 * Steps one plan may hold.
 *
 * Eight was enough to reproduce a condition and far too few to demonstrate a
 * chain: log in, enumerate, escalate, and prove the consequence is already more
 * than that. Bounded still, so a plan stays something an operator reads before
 * running it.
 */
export const POC_MAX_STEPS = 64
const POC_HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/

export function pocPlanContractError(value: unknown): string | undefined {
  if (!isRecord(value)) return "plan must be an object"
  const extra = unexpectedKey(value, ["version", "findingId", "title", "rationale", "steps"])
  if (extra) return `plan contains unexpected field ${extra}`
  if (value.version !== POC_VERSION) return "unsupported PoC contract version"
  if (!validIdentifier(value.findingId)) return "plan.findingId must be a safe identifier"
  if (!validText(value.title, 512)) return "plan.title must be a non-empty bounded string"
  if (!validText(value.rationale, 4_096)) return "plan.rationale must be a non-empty bounded string"
  if (!Array.isArray(value.steps) || !value.steps.length || value.steps.length > POC_MAX_STEPS) {
    return `plan.steps must hold 1 to ${POC_MAX_STEPS} steps`
  }
  const ids = new Set<string>()
  for (let index = 0; index < value.steps.length; index += 1) {
    const error = pocStepContractError(value.steps[index], `plan.steps[${index}]`)
    if (error) return error
    const id = (value.steps[index] as PocStep).id
    if (ids.has(id)) return `plan.steps contains a duplicate step id: ${id}`
    ids.add(id)
  }
  return undefined
}

export function assertPocPlan(value: unknown): asserts value is PocPlan {
  const error = pocPlanContractError(value)
  if (error) throw new Error(`Invalid PoC plan: ${error}`)
}

function pocStepContractError(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`
  const extra = unexpectedKey(value, ["id", "description", "method", "url", "headers", "body", "expect"])
  if (extra) return `${path} contains unexpected field ${extra}`
  if (!validIdentifier(value.id)) return `${path}.id must be a safe identifier`
  if (!validText(value.description, 512)) return `${path}.description must be a non-empty bounded string`
  if (!(POC_METHODS as readonly string[]).includes(String(value.method))) {
    return `${path}.method must be one of ${POC_METHODS.join(", ")}`
  }
  const urlError = pocUrlError(value.url, `${path}.url`)
  if (urlError) return urlError
  if ("headers" in value) {
    const headersError = pocHeadersError(value.headers, `${path}.headers`)
    if (headersError) return headersError
  }
  if ("body" in value && value.body !== undefined) {
    if (typeof value.body !== "string") return `${path}.body must be a string`
    if (Buffer.byteLength(value.body, "utf8") > POC_MAX_BODY_BYTES) {
      return `${path}.body exceeds ${POC_MAX_BODY_BYTES} bytes`
    }
    // A body on a method that does not carry one is a mistake worth naming: the
    // request would be sent without it and the step would prove nothing.
    if (value.method === "GET" || value.method === "HEAD") {
      return `${path}.body cannot be sent with ${String(value.method)}`
    }
  }
  return pocExpectationError(value.expect, `${path}.expect`)
}

function pocUrlError(value: unknown, path: string): string | undefined {
  if (typeof value !== "string" || !value.length || value.length > 2_048) return `${path} must be a bounded URL`
  if (/[\u0000-\u001F\u007F-\u009F\s]/.test(value)) return `${path} contains control characters`
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return `${path} is not a valid URL`
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `${path} must be http or https`
  if (url.username || url.password) return `${path} must not carry credentials`
  // A scope expression may end in a wildcard; a step that will actually be
  // requested may not — a proof has to name the URL it proves.
  if (value.endsWith("*")) return `${path} must be a concrete URL, not a scope pattern`
  return undefined
}

function pocHeadersError(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`
  const entries = Object.entries(value)
  if (entries.length > 8) return `${path} may hold at most 8 headers`
  for (const [name, headerValue] of entries) {
    if (!POC_HEADER_NAME.test(name)) return `${path} contains an invalid header name: ${name}`
    // A credential may be sent. Its value is redacted where the bundle is
    // written, so authenticating does not put a live token in a shared artifact.

    if (typeof headerValue !== "string" || !headerValue.length || headerValue.length > 1_024) {
      return `${path}.${name} must be a bounded string`
    }
    if (/[\u0000-\u001F\u007F-\u009F]/.test(headerValue)) return `${path}.${name} contains control characters`
  }
  return undefined
}

/**
 * The conditions a response either meets or does not.
 *
 * Exported because a skill's declarative check asserts in exactly this
 * vocabulary: one definition of what may be claimed means a check compiles
 * into a proof step without either side inventing a condition the other
 * cannot express.
 */
export function pocExpectationContractError(value: unknown, path = "expect"): string | undefined {
  return pocExpectationError(value, path)
}

/** Header rules for anything Cyrion will send: bounded, and never a credential. */
export function pocHeadersContractError(value: unknown, path = "headers"): string | undefined {
  return pocHeadersError(value, path)
}

function pocExpectationError(value: unknown, path: string, nested = false): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`
  const allowed = ["status", "headersPresent", "headersAbsent", "contentType", "bodyIncludes", "bodyExcludes"]
  const extra = unexpectedKey(value, nested ? allowed : [...allowed, "anyOf"])
  if (extra) return `${path} contains unexpected field ${extra}`
  if (!allowed.some((key) => key in value) && !("anyOf" in value)) {
    return `${path} must state at least one condition`
  }
  if ("anyOf" in value) {
    if (!Array.isArray(value.anyOf) || value.anyOf.length < 2 || value.anyOf.length > POC_MAX_ALTERNATIVES) {
      return `${path}.anyOf must offer 2 to ${POC_MAX_ALTERNATIVES} alternatives`
    }
    for (const [index, alternative] of value.anyOf.entries()) {
      // Depth one: an alternative states conditions, never further alternatives.
      const error = pocExpectationError(alternative, `${path}.anyOf[${index}]`, true)
      if (error) return error
    }
  }
  if ("status" in value) {
    if (!Array.isArray(value.status) || !value.status.length || value.status.length > 8) {
      return `${path}.status must name 1 to 8 statuses`
    }
    if (value.status.some((code) => !Number.isSafeInteger(code) || Number(code) < 100 || Number(code) > 599)) {
      return `${path}.status contains an invalid status code`
    }
  }
  for (const field of ["headersPresent", "headersAbsent"] as const) {
    if (!(field in value)) continue
    const names = value[field]
    if (!Array.isArray(names) || !names.length || names.length > 16) return `${path}.${field} must name 1 to 16 headers`
    if (names.some((name) => typeof name !== "string" || !POC_HEADER_NAME.test(name))) {
      return `${path}.${field} contains an invalid header name`
    }
  }
  for (const field of ["contentType", "bodyIncludes", "bodyExcludes"] as const) {
    if (!(field in value)) continue
    if (!validText(value[field], 256)) return `${path}.${field} must be a non-empty string of at most 256 characters`
  }
  return undefined
}

export function pocBundleContractError(value: unknown): string | undefined {
  if (!isRecord(value)) return "bundle must be an object"
  const extra = unexpectedKey(value, [
    "version", "engagementId", "findingId", "createdAt", "runner", "tool", "environment",
    "pins", "plan", "steps", "verdict", "script",
  ])
  if (extra) return `bundle contains unexpected field ${extra}`
  if (value.version !== POC_VERSION) return "unsupported PoC contract version"
  if (!validIdentifier(value.engagementId)) return "bundle.engagementId is invalid"
  if (!validIdentifier(value.findingId)) return "bundle.findingId is invalid"
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    return "bundle.createdAt is invalid"
  }
  if (value.runner !== "local" && value.runner !== "container") return "bundle.runner is invalid"
  if (!isRecord(value.tool) || !validTokenText(value.tool.binary, 128)) return "bundle.tool is invalid"
  if (!isRecord(value.environment)) return "bundle.environment must be an object"
  if (!Array.isArray(value.pins) || value.pins.length > 64) return "bundle.pins is invalid"
  if (!["reproduced", "not-reproduced", "inconclusive"].includes(String(value.verdict))) return "bundle.verdict is invalid"
  if (!validText(value.script, 65_536)) return "bundle.script must be a bounded string"
  if (!Array.isArray(value.steps) || !value.steps.length || value.steps.length > POC_MAX_STEPS) {
    return "bundle.steps is invalid"
  }
  const planError = pocPlanContractError(value.plan)
  if (planError) return `bundle plan is invalid: ${planError}`
  if ((value.plan as PocPlan).findingId !== value.findingId) return "bundle plan names a different finding"
  return undefined
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
    "expectedOutput", "findingId", "skillId",
  ])
  if (extra) return `${path} contains unexpected field ${extra}`
  if (!validIdentifier(value.id)) return `${path}.id must be a safe identifier`
  if (!validText(value.key, 512)) return `${path}.key must be a non-empty bounded string`
  if ("parentTaskId" in value && !validIdentifier(value.parentTaskId)) return `${path}.parentTaskId is invalid`
  if (!(WORKER_ROLES as readonly string[]).includes(String(value.role))) return `${path}.role is unsupported`
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
  if ("skillId" in value && !validIdentifier(value.skillId)) return `${path}.skillId is invalid`
  return undefined
}

function observationContractError(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`
  const extra = unexpectedKey(value, ["id", "asset", "summary", "source", "evidenceIds", "assets"])
  if (extra) return `${path} contains unexpected field ${extra}`
  if (!validIdentifier(value.id)) return `${path}.id is invalid`
  if (!validTokenText(value.asset, 2_048) || !validText(value.summary, 16_384) || !validIdentifier(value.source)) {
    return `${path} contains invalid text or source fields`
  }
  if ("assets" in value) {
    if (!Array.isArray(value.assets) || value.assets.length > MAX_DISCOVERED_ASSETS) {
      return `${path}.assets must be an array of at most ${MAX_DISCOVERED_ASSETS} entries`
    }
    if (value.assets.some((asset) => !validTokenText(asset, 2_048))) {
      return `${path}.assets contains an invalid address`
    }
  }
  return stringListError(value.evidenceIds, `${path}.evidenceIds`, { minimum: 1, safe: true })
}

function findingContractError(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`
  const extra = unexpectedKey(value, [
    "id", "title", "asset", "severity", "status", "summary", "discoveredBy", "validatedBy", "evidenceIds", "skillId",
    "reproduction",
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
  if ("skillId" in value && !validIdentifier(value.skillId)) return `${path}.skillId is invalid`
  if ("reproduction" in value) {
    const reproductionError = findingReproductionContractError(value.reproduction, `${path}.reproduction`)
    if (reproductionError) return reproductionError
  }
  return stringListError(value.evidenceIds, `${path}.evidenceIds`, { minimum: 1, safe: true })
}

function findingReproductionContractError(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`
  const extra = unexpectedKey(value, ["verdict", "bundleId", "steps", "runner", "at"])
  if (extra) return `${path} contains unexpected field ${extra}`
  if (!["reproduced", "not-reproduced", "inconclusive"].includes(String(value.verdict))) return `${path}.verdict is invalid`
  if (!validIdentifier(value.bundleId)) return `${path}.bundleId is invalid`
  if (!positiveSafeInteger(value.steps) || Number(value.steps) > POC_MAX_STEPS) return `${path}.steps is invalid`
  if (value.runner !== "local" && value.runner !== "container") return `${path}.runner is invalid`
  if (typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))) return `${path}.at is invalid`
  return undefined
}

export function evidenceRefContractError(value: unknown, path = "evidence"): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`
  const extra = unexpectedKey(value, ["id", "kind", "uri", "sha256", "capturedAt", "source", "contentType", "sizeBytes"])
  if (extra) return `${path} contains unexpected field ${extra}`
  if (!validIdentifier(value.id)) return `${path}.id is invalid`
  if (!["fixture", "request", "response", "log", "report", "poc"].includes(String(value.kind))) return `${path}.kind is invalid`
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

// ---------------------------------------------------------------------------
// JSON Schemas for provider-facing exchanges. Kept beside the contracts they
// mirror so a runtime adapter cannot drift from the validated shape.
// ---------------------------------------------------------------------------

export const identifierSchema = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 128 } as const
export const evidenceIdListSchema = {
  type: "array",
  minItems: 1,
  maxItems: 1_000,
  uniqueItems: true,
  items: identifierSchema,
} as const
export const taskSpecSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "key", "role", "objective", "target", "capabilities", "dependencies", "depth", "expectedOutput"],
  properties: {
    id: identifierSchema,
    key: { type: "string", minLength: 1, maxLength: 512 },
    parentTaskId: identifierSchema,
    role: { enum: [...WORKER_ROLES] },
    objective: { type: "string", minLength: 1, maxLength: 8_192 },
    target: { type: "string", minLength: 1, maxLength: 2_048 },
    capabilities: { type: "array", minItems: 1, maxItems: 1_000, uniqueItems: true, items: identifierSchema },
    dependencies: { type: "array", maxItems: 1_000, uniqueItems: true, items: identifierSchema },
    depth: { type: "integer", minimum: 1 },
    expectedOutput: { enum: ["inventory", "assessment", "validation", "report"] },
    findingId: identifierSchema,
    skillId: identifierSchema,
  },
} as const

export const findingReproductionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "bundleId", "steps", "runner", "at"],
  properties: {
    verdict: { enum: ["reproduced", "not-reproduced", "inconclusive"] },
    bundleId: identifierSchema,
    steps: { type: "integer", minimum: 1, maximum: POC_MAX_STEPS },
    runner: { enum: ["local", "container"] },
    at: { type: "string" },
  },
} as const

/**
 * Provider-facing shape of a reproduction plan. A model may propose one; the
 * contract validators above, not this schema, decide what actually runs.
 */
export const pocPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "findingId", "title", "rationale", "steps"],
  properties: {
    version: { const: POC_VERSION },
    findingId: identifierSchema,
    title: { type: "string", minLength: 1, maxLength: 512 },
    rationale: { type: "string", minLength: 1, maxLength: 4_096 },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: POC_MAX_STEPS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description", "method", "url", "expect"],
        properties: {
          id: identifierSchema,
          description: { type: "string", minLength: 1, maxLength: 512 },
          method: { enum: [...POC_METHODS] },
          body: { type: "string", maxLength: POC_MAX_BODY_BYTES },
          url: { type: "string", minLength: 1, maxLength: 2_048 },
          headers: { type: "object", additionalProperties: { type: "string", minLength: 1, maxLength: 1_024 } },
          expect: {
            type: "object",
            additionalProperties: false,
            minProperties: 1,
            properties: {
              status: { type: "array", minItems: 1, maxItems: 8, items: { type: "integer", minimum: 100, maximum: 599 } },
              headersPresent: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", maxLength: 64 } },
              headersAbsent: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", maxLength: 64 } },
              contentType: { type: "string", minLength: 1, maxLength: 256 },
              anyOf: {
                type: "array",
                minItems: 2,
                maxItems: POC_MAX_ALTERNATIVES,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    status: { type: "array", minItems: 1, maxItems: 8, items: { type: "integer" } },
                    headersPresent: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", maxLength: 64 } },
                    headersAbsent: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", maxLength: 64 } },
                    contentType: { type: "string", minLength: 1, maxLength: 256 },
                    bodyIncludes: { type: "string", minLength: 1, maxLength: 256 },
                    bodyExcludes: { type: "string", minLength: 1, maxLength: 256 },
                  },
                },
              },
              bodyIncludes: { type: "string", minLength: 1, maxLength: 256 },
              bodyExcludes: { type: "string", minLength: 1, maxLength: 256 },
            },
          },
        },
      },
    },
  },
} as const

export const rootDecisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "action"],
  properties: {
    version: { const: CONTRACT_VERSION },
    action: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "tasks", "rationale"],
          properties: {
            kind: { const: "delegate" },
            rationale: { type: "string", minLength: 1, maxLength: 4_096 },
            tasks: { type: "array", minItems: 1, maxItems: 1_000, items: taskSpecSchema },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "rationale"],
          properties: {
            kind: { const: "finish" },
            rationale: { type: "string", minLength: 1, maxLength: 4_096 },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "reason", "rationale"],
          properties: {
            kind: { const: "stop" },
            reason: { enum: ["budget", "deadline", "policy", "operator"] },
            rationale: { type: "string", minLength: 1, maxLength: 4_096 },
          },
        },
      ],
    },
  },
} as const

export const rootDecisionReviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "rationale"],
  properties: {
    verdict: { enum: ["accept", "stop"] },
    rationale: { type: "string", minLength: 1, maxLength: 4_096 },
  },
} as const

export const workerResultReviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary"],
  properties: {
    verdict: { enum: ["accept", "flag"] },
    summary: { type: "string", minLength: 1, maxLength: 16_384 },
  },
} as const

export const workerResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "observations", "findings", "evidence"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 16_384 },
    observations: {
      type: "array",
      maxItems: 1_000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "asset", "summary", "source", "evidenceIds"],
        properties: {
          id: identifierSchema,
          asset: { type: "string", minLength: 1, maxLength: 2_048 },
          summary: { type: "string", minLength: 1, maxLength: 16_384 },
          source: identifierSchema,
          evidenceIds: evidenceIdListSchema,
          assets: {
            type: "array",
            maxItems: MAX_DISCOVERED_ASSETS,
            items: { type: "string", minLength: 1, maxLength: 2_048 },
          },
        },
      },
    },
    findings: {
      type: "array",
      maxItems: 1_000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "asset", "severity", "status", "summary", "discoveredBy", "evidenceIds"],
        properties: {
          id: identifierSchema,
          title: { type: "string", minLength: 1, maxLength: 512 },
          asset: { type: "string", minLength: 1, maxLength: 2_048 },
          severity: { enum: ["info", "low", "medium", "high", "critical"] },
          status: { enum: ["candidate", "validating", "confirmed", "rejected", "inconclusive"] },
          skillId: identifierSchema,
          summary: { type: "string", minLength: 1, maxLength: 16_384 },
          discoveredBy: identifierSchema,
          validatedBy: identifierSchema,
          evidenceIds: evidenceIdListSchema,
          reproduction: findingReproductionSchema,
        },
      },
    },
    evidence: {
      type: "array",
      maxItems: 2_000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "uri", "sha256", "capturedAt"],
        properties: {
          id: identifierSchema,
          kind: { enum: ["fixture", "request", "response", "log", "report", "poc"] },
          uri: { type: "string", minLength: 1, maxLength: 2_048 },
          sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          capturedAt: { type: "string" },
          source: identifierSchema,
          contentType: { type: "string", minLength: 1, maxLength: 128 },
          sizeBytes: { type: "integer", minimum: 0 },
        },
      },
    },
    report: { type: "string", maxLength: 1_048_576 },
    usage: {
      type: "object",
      additionalProperties: false,
      required: ["inputTokens", "outputTokens", "costUsd"],
      properties: {
        inputTokens: { type: "integer", minimum: 0 },
        outputTokens: { type: "integer", minimum: 0 },
        costUsd: { type: "number", minimum: 0 },
      },
    },
    proposedTasks: {
      type: "array",
      maxItems: MAX_TASK_PROPOSALS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "objective", "target", "capabilities", "rationale"],
        properties: {
          role: { enum: [...WORKER_ROLES] },
          objective: { type: "string", minLength: 1, maxLength: 1_024 },
          target: { type: "string", minLength: 1, maxLength: 2_048 },
          capabilities: {
            type: "array",
            maxItems: 32,
            items: { type: "string", minLength: 1, maxLength: 128 },
          },
          rationale: { type: "string", minLength: 1, maxLength: 1_024 },
          skillId: identifierSchema,
        },
      },
    },
  },
} as const

/**
 * The engagement projection a planner is allowed to see: public records only,
 * no transcripts, no credentials, no artifact bodies.
 */
export function publicPlannerState(snapshot: EngagementSnapshot): object {
  return {
    engagement: {
      id: snapshot.manifest.id,
      objective: snapshot.manifest.objective,
      scope: snapshot.manifest.scope,
      budgets: snapshot.manifest.budgets,
    },
    status: snapshot.status,
    tasks: snapshot.tasks.map(({ id, role, objective, target, status, dependencies }) => ({
      id, role, objective, target, status, dependencies,
    })),
    findings: snapshot.findings,
    evidence: snapshot.evidence.map(({ id, kind, uri, sha256 }) => ({ id, kind, uri, sha256 })),
  }
}
