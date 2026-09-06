import { StyledText, bg, bold, fg, type TextChunk } from "@opentui/core"
import type { AgentRole, AgentStatus, EngagementSnapshot, Finding, TaskStatus } from "@cyrion/contracts"
import { theme } from "./theme"

export type ViewName = "MISSION" | "SWARM" | "FINDINGS" | "EVIDENCE"

export function formatSwarm(snapshot: EngagementSnapshot): StyledText {
  const root = snapshot.agents.find((agent) => agent.role === "root")
  const workers = snapshot.agents.filter((agent) => agent.role !== "root")
  const chunks: TextChunk[] = []
  appendLine(chunks, [strong("ROOT ORCHESTRATOR"), plain("  "), status(root?.status ?? "queued", "root")])
  appendRule(chunks)
  appendLine(chunks, [accent("■  "), strong(root?.name ?? "root-agent")])
  for (const [index, worker] of workers.entries()) {
    const branch = index === workers.length - 1 ? "└─" : "├─"
    appendLine(chunks, [dim(`${branch} `), statusGlyph(worker.status, worker.role), plain(` ${worker.name}`)])
    appendLine(chunks, [dim("   "), status(worker.status, worker.role), dim(`  ${worker.role.toUpperCase()}`)])
  }
  const active = snapshot.agents.filter((agent) => agent.status === "running").length
  appendRule(chunks)
  appendLine(chunks, [accent(`${active} ACTIVE`), dim(`  /  ${workers.length} WORKERS`)], false)
  return new StyledText(chunks)
}

export function formatMission(snapshot: EngagementSnapshot): StyledText {
  const chunks: TextChunk[] = []
  appendLine(chunks, [accent("[ ROOT AGENT / BRIEFING ]")])
  appendLine(chunks, [])
  appendLine(chunks, [dim("operator  >  "), plain(snapshot.manifest.objective)])
  appendLine(chunks, [accent("root      >  "), plain(missionSummary(snapshot))])
  appendSection(chunks, "PLAN")
  if (!snapshot.tasks.length) appendLine(chunks, [dim("No tasks delegated yet.")])
  for (const [index, task] of snapshot.tasks.entries()) {
    const number = String(index + 1).padStart(2, "0")
    appendLine(chunks, [dim(`${number}  `), plain(task.objective.slice(0, 39).padEnd(40)), taskStatus(task.status)])
  }
  appendSection(chunks, "ACTIVITY FEED")
  for (const event of snapshot.events.slice(-6)) {
    appendLine(chunks, [
      dim(`${event.timestamp.slice(11, 19)}  `),
      accent((event.agentId ?? "controller").padEnd(15)),
      plain(eventLabel(event.type)),
    ])
  }
  return new StyledText(chunks)
}

export function formatTaskBoard(snapshot: EngagementSnapshot): StyledText {
  const selected = snapshot.tasks.findLast((task) => task.status === "running") ?? snapshot.tasks.at(-1)
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

export function formatFindings(snapshot: EngagementSnapshot): StyledText {
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
    appendLine(chunks, [index === 0 ? bg(theme.selection)(accent(`› ${title}`)) : plain(`  ${title}`)])
    appendLine(chunks, [plain("  "), severity, dim("  |  "), verdict])
    appendRule(chunks, 62)
  }
  appendLine(chunks, [dim("FILTER  "), accent("severity:any  status:any  validator:any")], false)
  return new StyledText(chunks)
}

export function formatFindingDetail(snapshot: EngagementSnapshot): StyledText {
  const finding = snapshot.findings.at(0)
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

export function formatEvidence(snapshot: EngagementSnapshot): StyledText {
  const chunks: TextChunk[] = []
  appendLine(chunks, [strong("EVIDENCE INDEX"), dim(`  /  ${snapshot.evidence.length} ARTIFACTS`)])
  appendRule(chunks, 62)
  if (!snapshot.evidence.length) appendLine(chunks, [dim("No artifacts captured.")], false)
  for (const item of snapshot.evidence) {
    appendLine(chunks, [accent("■ "), strong(item.id), warning(`  ${item.kind.toUpperCase().padEnd(9)}`), plain(item.uri)])
    appendLine(chunks, [dim(`   sha256  ${item.sha256.slice(0, 32)}…`)])
  }
  return new StyledText(chunks)
}

export function formatEngagement(snapshot: EngagementSnapshot): StyledText {
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

function missionSummary(snapshot: EngagementSnapshot): string {
  if (snapshot.status === "completed") return "Mission complete. Report and evidence are ready."
  if (snapshot.status === "cancelled") return "Mission cancelled. Active leases were released."
  if (snapshot.status === "paused") return "Dispatch paused by operator; active operations are visible."
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
  if (value === "candidate") return theme.warning
  return theme.dim
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
