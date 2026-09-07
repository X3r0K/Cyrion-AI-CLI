import { StyledText, bg, bold, fg, type TextChunk } from "@opentui/core"
import type { AgentRole, AgentStatus, EngagementSnapshot, Finding, TaskStatus } from "@cyrion/contracts"
import { theme } from "./theme"

export type ViewName = "MISSION" | "SWARM" | "FINDINGS" | "EVIDENCE"

export interface RuntimeDisplay {
  mode: "fixture" | "opencode"
  provider?: string
}

export function formatSwarm(snapshot: EngagementSnapshot, selectedTaskId?: string): StyledText {
  const root = snapshot.agents.find((agent) => agent.role === "root")
  const workers = snapshot.agents.filter((agent) => agent.role !== "root")
  const selectedAgentId = snapshot.tasks.find((task) => task.id === selectedTaskId)?.agentId
  const chunks: TextChunk[] = []
  appendLine(chunks, [strong("ROOT ORCHESTRATOR"), plain("  "), status(root?.status ?? "queued", "root")])
  appendRule(chunks)
  appendLine(chunks, [accent("■  "), strong(root?.name ?? "root-agent")])
  for (const [index, worker] of workers.entries()) {
    const branch = index === workers.length - 1 ? "└─" : "├─"
    const name = ` ${worker.name}`
    appendLine(chunks, [
      dim(`${branch} `),
      statusGlyph(worker.status, worker.role),
      worker.id === selectedAgentId ? bg(theme.selection)(accent(`${name}  ‹`)) : plain(name),
    ])
    appendLine(chunks, [dim("   "), status(worker.status, worker.role), dim(`  ${worker.role.toUpperCase()}`)])
  }
  const active = snapshot.agents.filter((agent) => agent.status === "running").length
  appendRule(chunks)
  appendLine(chunks, [accent(`${active} ACTIVE`), dim(`  /  ${workers.length} WORKERS`)], false)
  return new StyledText(chunks)
}

export function formatMission(snapshot: EngagementSnapshot, runtime?: RuntimeDisplay): StyledText {
  const chunks: TextChunk[] = []
  appendLine(chunks, [accent("[ ROOT AGENT / BRIEFING ]")])
  appendLine(chunks, [])
  if (runtime) {
    appendLine(chunks, [
      dim("runtime   >  "),
      plain(`${runtime.mode.toUpperCase()} / LLM ${runtime.provider ?? "NOT CONFIGURED"}`),
    ])
  }
  appendLine(chunks, [dim("operator  >  "), plain(snapshot.manifest.objective)])
  appendLine(chunks, [accent("root      >  "), plain(missionSummary(snapshot))])
  if (snapshot.pendingApproval) {
    appendSection(chunks, "SUPERVISOR APPROVAL")
    appendLine(chunks, [warning("◇ REVIEW REQUIRED"), dim(`  ${sanitizeTerminalText(snapshot.pendingApproval.id.slice(0, 8))}`)])
    appendLine(chunks, [plain(sanitizeTerminalText(snapshot.pendingApproval.decision.action.rationale, 240))])
    for (const task of snapshot.pendingApproval.decision.action.tasks) {
      appendLine(chunks, [
        accent(`${sanitizeTerminalText(task.id, 128)}  `),
        plain(`${sanitizeTerminalText(task.role.toUpperCase(), 32)} → ${sanitizeTerminalText(task.target, 120)}`),
      ])
      appendLine(chunks, [dim("   capabilities  "), plain(sanitizeTerminalText(task.capabilities.join(", "), 240))])
    }
    appendLine(chunks, [success("[a] APPROVE"), dim("   "), fg(theme.danger)("[x] DENY")])
  }
  appendSection(chunks, "PLAN")
  if (!snapshot.tasks.length) appendLine(chunks, [dim("No tasks delegated yet.")])
  for (const [index, task] of snapshot.tasks.entries()) {
    const number = String(index + 1).padStart(2, "0")
    appendLine(chunks, [dim(`${number}  `), plain(task.objective.slice(0, 39).padEnd(40)), taskStatus(task.status)])
  }
  appendSection(chunks, "ACTIVITY FEED")
  for (const event of snapshot.events.filter((item) => item.type !== "task.heartbeat").slice(-5)) {
    appendLine(chunks, [
      dim(`${event.timestamp.slice(11, 19)}  `),
      accent((event.agentId ?? "controller").padEnd(15)),
      plain(eventLabel(event.type)),
    ])
  }
  const conversation = snapshot.events.filter((event) => event.type === "operator.message" || event.type === "root.message").slice(-2)
  if (conversation.length) {
    appendSection(chunks, "ROOT CHAT")
    for (const event of conversation) {
      const payload = event.payload as { content?: unknown }
      const content = typeof payload.content === "string" ? sanitizeTerminalText(payload.content, 240) : ""
      appendLine(chunks, [
        event.type === "operator.message" ? dim("operator  >  ") : accent("root      >  "),
        plain(content),
      ])
    }
  }
  return new StyledText(chunks)
}

export function formatTaskBoard(snapshot: EngagementSnapshot, selectedTaskId?: string): StyledText {
  const selected = snapshot.tasks.find((task) => task.id === selectedTaskId)
    ?? snapshot.tasks.findLast((task) => task.status === "running")
    ?? snapshot.tasks.at(-1)
  const chunks: TextChunk[] = []
  appendLine(chunks, [strong("LIVE TASK BOARD"), dim("  /  ROOT DISPATCH")])
  appendRule(chunks, 62)
  appendLine(chunks, [dim("AGENT           TASK                              STATE")])
  for (const task of snapshot.tasks) {
    const agent = snapshot.agents.find((item) => item.taskId === task.id)
    const agentName = (agent?.name ?? "queued").padEnd(15)
    const objective = task.objective.slice(0, 33).padEnd(34)
    const row = `${agentName} ${objective} ${task.status.toUpperCase().padEnd(10)}`
    if (task.id === selected?.id) {
      appendLine(chunks, [bg(theme.selection)(fg(taskColor(task.status))(row))])
    } else {
      appendLine(chunks, [fg(taskColor(task.status))(row)])
    }
  }
  appendSection(chunks, `${(selected?.role ?? "root").toUpperCase()} / LIVE ACTIVITY`)
  const activity = selected
    ? snapshot.events.filter((event) => event.taskId === selected.id).slice(-5)
    : []
  if (!activity.length) appendLine(chunks, [dim("Waiting for Root dispatch.")])
  for (const event of activity) {
    appendLine(chunks, [dim(`${event.timestamp.slice(11, 19)}  `), accent(eventLabel(event.type))])
  }
  appendLine(chunks, [])
  appendLine(chunks, [
    success("■ ISOLATED"), dim("  |  "), accent("■ SCOPE ENFORCED"), dim("  |  "), success("■ HEARTBEAT HEALTHY"),
  ], false)
  return new StyledText(chunks)
}

export function formatFindings(snapshot: EngagementSnapshot, selectedFindingId?: string): StyledText {
  const chunks: TextChunk[] = []
  appendLine(chunks, [strong("FINDINGS"), dim(`  /  ${countFindings(snapshot.findings)}`)])
  appendRule(chunks, 62)
  if (!snapshot.findings.length) {
    appendLine(chunks, [dim("No candidates have been submitted.")], false)
    return new StyledText(chunks)
  }
  for (const [index, finding] of snapshot.findings.entries()) {
    const severity = fg(severityColor(finding.severity))(finding.severity.toUpperCase().padEnd(10))
    const verdict = fg(findingColor(finding.status))(finding.status.toUpperCase())
    const title = `${finding.id}  ${finding.title}`
    const selected = finding.id === selectedFindingId || (!selectedFindingId && index === 0)
    appendLine(chunks, [selected ? bg(theme.selection)(accent(`› ${title}`)) : plain(`  ${title}`)])
    appendLine(chunks, [plain("  "), severity, dim("  |  "), verdict])
    appendRule(chunks, 62)
  }
  appendLine(chunks, [dim("FILTER  "), accent("severity:any  status:any  validator:any")], false)
  return new StyledText(chunks)
}

export function formatFindingDetail(snapshot: EngagementSnapshot, selectedFindingId?: string): StyledText {
  const finding = snapshot.findings.find((item) => item.id === selectedFindingId) ?? snapshot.findings.at(0)
  const chunks: TextChunk[] = []
  appendLine(chunks, [strong("FINDING INSPECTOR")])
  appendRule(chunks)
  if (!finding) {
    appendLine(chunks, [dim("Select a finding when one is available.")], false)
    return new StyledText(chunks)
  }
  appendLine(chunks, [accent(finding.id), plain(` / ${finding.title.toUpperCase()}`)])
  appendLine(chunks, [])
  appendKeyValue(chunks, "Asset", finding.asset)
  appendKeyValue(chunks, "Discovered", finding.discoveredBy)
  appendKeyValue(chunks, "Validated", finding.validatedBy ?? "pending")
  appendLine(chunks, [dim("Verdict       "), fg(findingColor(finding.status))(finding.status.toUpperCase())])
  appendSection(chunks, "VALIDATION", 30)
  appendLine(chunks, [validationVerdict(finding.status)])
  appendLine(chunks, [dim("Fresh evidence  "), plain(`${finding.evidenceIds.length} artifacts`)])
  appendSection(chunks, "EVIDENCE", 30)
  for (const id of finding.evidenceIds) appendLine(chunks, [accent("■ "), plain(`${id}  linked artifact`)])
  appendSection(chunks, "REMEDIATION", 30)
  appendLine(chunks, [plain(remediationFor(finding.status))], false)
  return new StyledText(chunks)
}

export function formatEvidence(snapshot: EngagementSnapshot, selectedEvidenceId?: string): StyledText {
  const chunks: TextChunk[] = []
  appendLine(chunks, [strong("EVIDENCE INDEX"), dim(`  /  ${snapshot.evidence.length} ARTIFACTS`)])
  appendRule(chunks, 62)
  if (!snapshot.evidence.length) appendLine(chunks, [dim("No artifacts captured.")], false)
  for (const [index, item] of snapshot.evidence.entries()) {
    const selected = item.id === selectedEvidenceId || (!selectedEvidenceId && index === 0)
    appendLine(chunks, [
      selected ? bg(theme.selection)(accent("› ")) : accent("■ "),
      strong(item.id),
      warning(`  ${item.kind.toUpperCase().padEnd(9)}`),
      plain(sanitizeTerminalText(item.uri)),
    ])
    appendLine(chunks, [dim(`   sha256  ${item.sha256.slice(0, 32)}…`)])
  }
  return new StyledText(chunks)
}

export function formatWorkerInspector(snapshot: EngagementSnapshot, selectedTaskId?: string): StyledText {
  const task = snapshot.tasks.find((item) => item.id === selectedTaskId)
    ?? snapshot.tasks.findLast((item) => item.status === "running")
    ?? snapshot.tasks.at(-1)
  const agent = snapshot.agents.find((item) => item.id === task?.agentId)
  const chunks: TextChunk[] = []
  appendLine(chunks, [strong("WORKER INSPECTOR")])
  appendRule(chunks)
  if (!task) {
    appendLine(chunks, [dim("Waiting for Root to create a task.")], false)
    return new StyledText(chunks)
  }
  appendLine(chunks, [accent(agent?.name ?? task.role), dim("  /  "), taskStatus(task.status)])
  appendLine(chunks, [])
  appendKeyValue(chunks, "Role", task.role.toUpperCase())
  appendKeyValue(chunks, "Task", task.id)
  appendKeyValue(chunks, "Target", task.target)
  appendKeyValue(chunks, "Attempt", String(task.attempt))
  appendKeyValue(chunks, "Lease", task.lease ? "HEALTHY" : "RELEASED")
  appendSection(chunks, "ASSIGNMENT", 30)
  appendLine(chunks, [plain(sanitizeTerminalText(task.objective))])
  appendSection(chunks, "CAPABILITIES", 30)
  for (const capability of task.capabilities) appendLine(chunks, [success("■ "), plain(capability)])
  appendSection(chunks, "LAST ACTIVITY", 30)
  const activity = snapshot.events.filter((event) => event.taskId === task.id).slice(-4)
  if (!activity.length) appendLine(chunks, [dim("No worker events yet.")])
  for (const event of activity) {
    appendLine(chunks, [dim(`${event.timestamp.slice(11, 19)}  `), accent(eventLabel(event.type))])
  }
  if (task.result?.summary) {
    appendSection(chunks, "RESULT", 30)
    appendLine(chunks, [plain(sanitizeTerminalText(task.result.summary))], false)
  }
  return new StyledText(chunks)
}

export type EvidenceVerification = "idle" | "loading" | "verified" | "failed"

export function formatEvidenceInspector(
  snapshot: EngagementSnapshot,
  selectedEvidenceId: string | undefined,
  preview: string,
  verification: EvidenceVerification,
): StyledText {
  const evidence = snapshot.evidence.find((item) => item.id === selectedEvidenceId) ?? snapshot.evidence.at(0)
  const chunks: TextChunk[] = []
  appendLine(chunks, [strong("EVIDENCE INSPECTOR")])
  appendRule(chunks)
  if (!evidence) {
    appendLine(chunks, [dim("Select an artifact when one is available.")], false)
    return new StyledText(chunks)
  }
  appendLine(chunks, [accent(evidence.id), dim("  /  "), warning(evidence.kind.toUpperCase())])
  appendLine(chunks, [])
  appendKeyValue(chunks, "Source", evidence.source ?? "unknown")
  appendKeyValue(chunks, "Type", evidence.contentType ?? "unknown")
  appendKeyValue(chunks, "Bytes", String(evidence.sizeBytes ?? "unknown"))
  appendKeyValue(chunks, "Captured", evidence.capturedAt.slice(11, 19))
  appendLine(chunks, [dim("Integrity     "), verificationStatus(verification)])
  appendSection(chunks, "SHA-256", 30)
  appendLine(chunks, [dim(evidence.sha256.slice(0, 32))])
  appendLine(chunks, [dim(evidence.sha256.slice(32))])
  appendSection(chunks, "ARTIFACT PREVIEW", 30)
  appendLine(chunks, [plain(preview || (verification === "loading" ? "Loading local artifact…" : "No preview available."))], false)
  return new StyledText(chunks)
}

export function formatCommandHelp(): StyledText {
  const chunks: TextChunk[] = []
  appendLine(chunks, [strong("COMMANDS")])
  appendRule(chunks)
  appendLine(chunks, [accent("1–4       "), plain("Mission / Swarm / Findings / Evidence")])
  appendLine(chunks, [accent("↑ ↓ / j k "), plain("Move current selection")])
  appendLine(chunks, [accent("← → / h l "), plain("Move between views")])
  appendLine(chunks, [accent("Enter / e "), plain("Open supporting evidence")])
  appendLine(chunks, [accent("Tab / i   "), plain("Focus or leave Root chat")])
  appendLine(chunks, [accent("p         "), plain("Pause or resume dispatch")])
  appendLine(chunks, [accent("a / x     "), plain("Approve or deny a supervised delegation")])
  appendLine(chunks, [accent("? / Ctrl+K"), plain("Toggle this command guide")])
  appendLine(chunks, [accent("q         "), plain("Quit and cancel active workers")])
  appendSection(chunks, "SAFETY", 28)
  appendLine(chunks, [success("■ SCOPE LOCKED")])
  appendLine(chunks, [success("■ LOCAL ARTIFACTS")])
  appendLine(chunks, [warning("◇ FIXTURE WORKERS ONLY")], false)
  return new StyledText(chunks)
}

export function formatEngagement(snapshot: EngagementSnapshot, runtime?: RuntimeDisplay): StyledText {
  const elapsed = snapshot.startedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.startedAt)) / 1000))
    : 0
  const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0")
  const seconds = String(elapsed % 60).padStart(2, "0")
  const chunks: TextChunk[] = []
  appendLine(chunks, [strong("ENGAGEMENT")])
  appendRule(chunks)
  appendKeyValue(chunks, "Target", snapshot.manifest.scope.targets[0] ?? "none")
  appendKeyValue(chunks, "Profile", snapshot.manifest.profile.replace("-", " + ").toUpperCase())
  if (runtime) {
    appendKeyValue(chunks, "Runtime", runtime.mode.toUpperCase())
    appendKeyValue(chunks, "LLM config", runtime.provider ?? "NOT CONFIGURED")
  }
  appendLine(chunks, [dim("Scope         "), success("■ LOCKED")])
  appendKeyValue(chunks, "Elapsed", `${minutes}:${seconds}`)
  appendSection(chunks, "BUDGET", 28)
  appendBudget(chunks, "Agents", snapshot.agents.length, snapshot.manifest.budgets.maxAgents)
  appendBudget(chunks, "Tasks", snapshot.tasks.length, snapshot.manifest.budgets.maxTasks)
  appendBudget(
    chunks,
    "Time",
    elapsed * 1000,
    snapshot.manifest.budgets.maxDurationMs,
    `${minutes}:${seconds}/${formatDuration(snapshot.manifest.budgets.maxDurationMs)}`,
  )
  const tokens = snapshot.usage.inputTokens + snapshot.usage.outputTokens
  appendBudget(
    chunks,
    "Tokens",
    tokens,
    snapshot.manifest.budgets.maxTokens,
    `${compactNumber(tokens)}/${compactNumber(snapshot.manifest.budgets.maxTokens)}`,
  )
  appendBudget(
    chunks,
    "Cost",
    snapshot.usage.costUsd,
    snapshot.manifest.budgets.maxCostUsd,
    `$${snapshot.usage.costUsd.toFixed(2)}/$${snapshot.manifest.budgets.maxCostUsd.toFixed(2)}`,
  )
  appendKeyValue(chunks, "Parallel", String(snapshot.manifest.budgets.maxConcurrentAgents))
  appendSection(chunks, "COUNTS", 28)
  appendLine(chunks, [success("■ "), plain(`${snapshot.findings.filter((item) => item.status === "confirmed").length} confirmed`)])
  appendLine(chunks, [warning("■ "), plain(`${snapshot.findings.filter((item) => item.status === "candidate").length} candidate`)])
  appendLine(chunks, [warning("◆ "), plain(`${snapshot.findings.filter((item) => item.status === "validating").length} validating`)])
  appendLine(chunks, [fg(theme.danger)("■ "), plain(`${snapshot.findings.filter((item) => item.status === "rejected").length} rejected`)])
  appendLine(chunks, [warning("◇ "), plain(`${snapshot.findings.filter((item) => item.status === "inconclusive").length} inconclusive`)])
  appendLine(chunks, [accent("■ "), plain(`${snapshot.evidence.length} artifacts`)], false)
  return new StyledText(chunks)
}

export function sanitizeTerminalText(value: string, maxLength = 2_400): string {
  const clean = value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "")
  if (clean.length <= maxLength) return clean
  return `${clean.slice(0, maxLength)}\n… preview truncated …`
}

function missionSummary(snapshot: EngagementSnapshot): string {
  if (snapshot.status === "completed") return "Mission complete. Report and evidence are ready."
  if (snapshot.status === "cancelled") return "Mission cancelled. Active leases were released."
  if (snapshot.status === "paused") return "Dispatch paused by operator; active operations are visible."
  if (snapshot.pendingApproval?.status === "pending") return "Root is waiting for supervisor approval before dispatch."
  if (snapshot.pendingApproval?.status === "approved") return "Approved delegation is being committed to the task queue."
  const running = snapshot.tasks.filter((task) => task.status === "running").map((task) => task.role)
  if (running.length) return `${running.join(" + ")} workers are running in bounded sessions.`
  return "Building the next bounded dispatch decision."
}

function countFindings(findings: Finding[]): string {
  const confirmed = findings.filter((finding) => finding.status === "confirmed").length
  const candidate = findings.filter((finding) => finding.status === "candidate").length
  const validating = findings.filter((finding) => finding.status === "validating").length
  const rejected = findings.filter((finding) => finding.status === "rejected").length
  const inconclusive = findings.filter((finding) => finding.status === "inconclusive").length
  return `${confirmed} confirmed / ${candidate} candidate / ${validating} validating / ${rejected} rejected / ${inconclusive} inconclusive`
}

const plain = (value: string): TextChunk => fg(theme.text)(value)
const dim = (value: string): TextChunk => fg(theme.dim)(value)
const accent = (value: string): TextChunk => fg(theme.accent)(value)
const success = (value: string): TextChunk => fg(theme.success)(value)
const warning = (value: string): TextChunk => fg(theme.warning)(value)
const strong = (value: string): TextChunk => bold(fg(theme.text)(value))

function appendLine(chunks: TextChunk[], parts: TextChunk[], newline = true): void {
  chunks.push(...parts)
  if (newline) chunks.push(dim("\n"))
}

function appendRule(chunks: TextChunk[], width = 28): void {
  appendLine(chunks, [fg(theme.border)("─".repeat(width))])
}

function appendSection(chunks: TextChunk[], label: string, width = 48): void {
  appendLine(chunks, [])
  const side = Math.max(2, Math.floor((width - label.length - 2) / 2))
  appendLine(chunks, [fg(theme.border)("─".repeat(side)), accent(` ${label} `), fg(theme.border)("─".repeat(side))])
}

function appendKeyValue(chunks: TextChunk[], key: string, value: string): void {
  appendLine(chunks, [dim(key.padEnd(14)), plain(value)])
}

function appendBudget(chunks: TextChunk[], label: string, used: number, limit: number, value?: string): void {
  const width = 12
  const filled = limit > 0 ? Math.min(width, Math.round((used / limit) * width)) : 0
  appendLine(chunks, [
    dim(label.padEnd(9)),
    accent("■".repeat(filled)),
    fg(theme.borderMuted)("·".repeat(width - filled)),
    plain(`  ${value ?? `${used}/${limit}`}`),
  ])
}

function status(value: AgentStatus, role: AgentRole): TextChunk {
  return fg(agentColor(value, role))(agentStateLabel(value, role).padEnd(13))
}

function statusGlyph(value: AgentStatus, role: AgentRole): TextChunk {
  return fg(agentColor(value, role))(value === "running" ? "◆" : value === "completed" ? "■" : value === "failed" ? "!" : "◇")
}

function agentStateLabel(value: AgentStatus, role: AgentRole): string {
  if (value === "running" && role === "root") return "ORCHESTRATING"
  if (value === "running" && role === "validator") return "VERIFYING"
  if (value === "running" && role === "reporter") return "REPORTING"
  return value.toUpperCase()
}

function agentColor(value: AgentStatus, role: AgentRole): string {
  if (value === "running" && role === "validator") return theme.warning
  if (value === "running") return theme.accentBright
  if (value === "completed") return theme.success
  if (value === "failed" || value === "cancelled") return theme.danger
  if (value === "waiting") return theme.warning
  return theme.dim
}

function taskStatus(value: TaskStatus): TextChunk {
  return fg(taskColor(value))(value.toUpperCase().padEnd(10))
}

function taskColor(value: TaskStatus): string {
  if (value === "running") return theme.accentBright
  if (value === "completed") return theme.success
  if (value === "failed" || value === "cancelled") return theme.danger
  return theme.dim
}

function findingColor(value: Finding["status"]): string {
  if (value === "confirmed") return theme.success
  if (value === "rejected") return theme.danger
  if (value === "candidate" || value === "validating" || value === "inconclusive") return theme.warning
  return theme.dim
}

function verificationStatus(value: EvidenceVerification): TextChunk {
  if (value === "verified") return success("■ VERIFIED")
  if (value === "failed") return fg(theme.danger)("! HASH MISMATCH")
  if (value === "loading") return warning("◇ VERIFYING")
  return dim("◇ NOT CHECKED")
}

function validationVerdict(value: Finding["status"]): TextChunk {
  if (value === "confirmed") return success("■ REPRODUCTION PASS")
  if (value === "rejected") return fg(theme.danger)("■ REPRODUCTION REJECTED")
  if (value === "inconclusive") return warning("◇ REPRODUCTION INCONCLUSIVE")
  return warning("◇ REPRODUCTION PENDING")
}

function remediationFor(value: Finding["status"]): string {
  if (value === "confirmed") return "Enforce object-level authorization for every request."
  if (value === "rejected") return "No remediation required; preserve the validation record."
  if (value === "inconclusive") return "Collect fresh comparison evidence before reporting."
  return "Await independent validation before recommending a change."
}

function severityColor(value: Finding["severity"]): string {
  if (value === "critical" || value === "high") return theme.danger
  if (value === "medium") return theme.warning
  if (value === "low") return theme.accentBright
  return theme.muted
}

function eventLabel(value: string): string {
  return value.replaceAll(".", " / ").toUpperCase()
}

function compactNumber(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}K` : String(value)
}

function formatDuration(value: number): string {
  const seconds = Math.floor(value / 1000)
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}
