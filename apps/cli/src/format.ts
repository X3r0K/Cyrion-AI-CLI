import { StyledText, bg, bold, fg, type TextChunk } from "@opentui/core"
import type {
  AgentRecord,
  AgentRole,
  AgentStatus,
  CyrionEvent,
  EngagementSnapshot,
  Finding,
  TaskRecord,
  TaskStatus,
} from "@cyrion/contracts"
import { scopeHash } from "@cyrion/scope"
import type { ProviderSummary } from "@cyrion/runtime-opencode"
import {
  llmEndpointConfigured,
  selectedSettingsField,
  settingsAreDirty,
  settingsFields,
  valueForField,
  type SettingsEditorState,
  type SettingsField,
} from "./settings-ui"
import { theme } from "./theme"

export type ViewName = "MISSION" | "SWARM" | "FINDINGS" | "EVIDENCE" | "SETTINGS"

export interface RuntimeDisplay {
  mode: "fixture" | "hybrid" | "live"
  provider?: string
  planner?: "fixture" | "opencode" | "llm" | "llm-author" | "assessment"
  workers?: "fixture" | "opencode" | "llm" | "capability"
  /** Where capabilities executed, when an engagement ran real tooling. */
  sandbox?: string
  /** Set when the operator supplied a scope lock the controller accepted. */
  attestation?: string
  /**
   * Why the requested planner or workers are not in use. Present when Cyrion
   * started anyway with the deterministic runtime instead of refusing to open.
   */
  notice?: string
}

export interface SettingsDisplay {
  environmentPath: string
  providers: ProviderSummary[]
  discovery: "idle" | "loading" | "ready" | "failed"
  message?: string
}

export type EvidenceVerification = "idle" | "loading" | "verified" | "failed"

/** Fallback pane widths used by tests and by the first frame before layout resolves. */
const SIDE_WIDTH = 30
const MAIN_WIDTH = 62

export function formatSwarm(snapshot: EngagementSnapshot, selectedTaskId?: string, width = SIDE_WIDTH): StyledText {
  const root = snapshot.agents.find((agent) => agent.role === "root")
  const workers = snapshot.agents.filter((agent) => agent.role !== "root")
  const selectedAgentId = snapshot.tasks.find((task) => task.id === selectedTaskId)?.agentId
  const chunks: TextChunk[] = []

  const rootName = root?.name ?? "root-agent"
  const rootState = agentStateLabel(root?.status ?? "queued", "root")
  appendLine(chunks, [
    plain(pad(rootName, Math.max(4, width - rootState.length - 1))),
    plain(" "),
    accent(rootState),
  ])
  appendRule(chunks, width)
  appendLine(chunks, [statusGlyph(root?.status ?? "queued", "root"), plain(`  ${root?.name ?? "root-agent"}`)])
  appendLine(chunks, [dim("   "), status(root?.status ?? "queued", "root")])

  for (const [index, worker] of workers.entries()) {
    const last = index === workers.length - 1
    const selected = worker.id === selectedAgentId
    const name = clip(worker.name, Math.max(8, width - 6))
    appendLine(chunks, [
      dim(last ? "└─ " : "├─ "),
      statusGlyph(worker.status, worker.role),
      selected ? bg(theme.selection)(accent(` ${name}`)) : plain(` ${name}`),
    ])
    appendLine(chunks, [dim(last ? "    " : "│   "), status(worker.status, worker.role)])
  }

  const active = snapshot.agents.filter((agent) => agent.status === "running").length
  appendRule(chunks, width)
  appendLine(chunks, [accent(`${active} active`), dim(`  /  ${workers.length} workers`)], false)
  return new StyledText(chunks)
}

export function formatMission(
  snapshot: EngagementSnapshot,
  runtime?: RuntimeDisplay,
  width = MAIN_WIDTH,
): StyledText {
  const chunks: TextChunk[] = []
  appendPanelTitle(chunks, "MISSION CONTROL", width, snapshot.status.toUpperCase())
  appendLine(chunks, [accent("[ ROOT AGENT / BRIEFING ]")])
  appendLine(chunks, [])
  if (runtime) appendLine(chunks, [dim("runtime   >  "), plain(runtimeLabel(runtime))])
  appendLine(chunks, [dim("operator  >  "), plain(snapshot.manifest.objective)])
  appendLine(chunks, [accent("root      >  "), plain(missionSummary(snapshot))])

  if (snapshot.pendingApproval) {
    appendSection(chunks, "SUPERVISOR APPROVAL", width, "REVIEW REQUIRED")
    appendLine(chunks, [warning("◇ "), dim(sanitizeTerminalText(snapshot.pendingApproval.id.slice(0, 8)))])
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

  appendSection(chunks, "PLAN", width, `${snapshot.tasks.length} TASKS`)
  if (!snapshot.tasks.length) appendLine(chunks, [dim("No tasks delegated yet.")])
  const objectiveWidth = Math.max(12, width - 16)
  for (const [index, task] of snapshot.tasks.entries()) {
    const number = String(index + 1).padStart(2, "0")
    appendLine(chunks, [
      dim(`${number}  `),
      plain(pad(task.objective, objectiveWidth)),
      taskStatus(task.status),
    ])
  }

  appendSection(chunks, "ACTIVITY FEED", width, "LIVE")
  const feed = snapshot.events.filter((event) => event.type !== "task.heartbeat").slice(-6)
  if (!feed.length) appendLine(chunks, [dim("No controller events yet.")])
  for (const event of feed) appendActivity(chunks, snapshot, event, width)

  const conversation = snapshot.events
    .filter((event) => event.type === "operator.message" || event.type === "root.message")
    .slice(-2)
  if (conversation.length) {
    appendSection(chunks, "ROOT CHAT", width)
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

export function formatTaskBoard(
  snapshot: EngagementSnapshot,
  selectedTaskId?: string,
  width = MAIN_WIDTH,
): StyledText {
  const selected = resolveTask(snapshot, selectedTaskId)
  const chunks: TextChunk[] = []
  appendPanelTitle(chunks, "LIVE TASK BOARD", width, `${snapshot.tasks.length} TASKS`)

  const elapsedWidth = 7
  const stateWidth = 10
  const agentWidth = 14
  const taskWidth = Math.max(10, width - agentWidth - stateWidth - elapsedWidth - 13)
  const columns = [agentWidth, taskWidth, stateWidth, elapsedWidth]

  appendTableEdge(chunks, columns, "top")
  appendTableRow(chunks, ["AGENT", "TASK", "STATE", "ELAPSED"].map((label, index) =>
    dim(pad(label, columns[index] ?? 8))))
  appendTableEdge(chunks, columns, "middle")
  if (!snapshot.tasks.length) {
    appendTableRow(chunks, ["—", "Waiting for Root dispatch", "—", "--:--"].map((value, index) =>
      dim(pad(value, columns[index] ?? 8))))
  }
  for (const task of snapshot.tasks) {
    const agent = snapshot.agents.find((item) => item.taskId === task.id)
    const cells = [
      agent?.name ?? "queued",
      task.objective,
      task.status.toUpperCase(),
      taskElapsed(snapshot, task),
    ]
    const isSelected = task.id === selected?.id
    appendTableRow(chunks, cells.map((value, index) => {
      const text = pad(value, columns[index] ?? 8)
      const color = index === 2 ? taskColor(task.status) : isSelected ? theme.accentBright : theme.text
      return isSelected ? bg(theme.selection)(fg(color)(text)) : fg(color)(text)
    }), isSelected)
  }
  appendTableEdge(chunks, columns, "bottom")

  const agentName = snapshot.agents.find((item) => item.id === selected?.agentId)?.name ?? selected?.role ?? "root"
  appendSection(chunks, `${agentName.toUpperCase()} / LIVE ACTIVITY`, width, selected ? selected.id : "IDLE")
  const activity = selected
    ? snapshot.events.filter((event) => event.taskId === selected.id && event.type !== "task.heartbeat").slice(-6)
    : []
  if (!activity.length) appendLine(chunks, [dim("Waiting for Root dispatch.")])
  for (const event of activity) appendActivity(chunks, snapshot, event, width, false)

  appendLine(chunks, [])
  appendLine(chunks, [
    success("■ "), plain("Isolated worker"), dim("   |   "),
    accent("■ "), plain("Scope enforced"), dim("   |   "),
    heartbeatGlyph(snapshot), plain(` Heartbeat ${heartbeatLabel(snapshot)}`),
  ], false)
  return new StyledText(chunks)
}

export function formatRootDispatch(
  snapshot: EngagementSnapshot,
  selectedTaskId?: string,
  width = SIDE_WIDTH,
): StyledText {
  const chunks: TextChunk[] = []
  const running = snapshot.tasks.filter((task) => task.status === "running")
  const queued = snapshot.tasks.filter((task) => task.status === "queued")
  const completed = snapshot.tasks.filter((task) => task.status === "completed")
  appendPanelTitle(chunks, "ROOT DISPATCH", width, snapshot.status === "paused" ? "PAUSED" : "LIVE")
  appendLine(chunks, [plain("Root owns the plan")])
  appendLine(chunks, [])
  appendKeyValue(chunks, "Parallel", `${running.length} / ${snapshot.manifest.budgets.maxConcurrentAgents}`)
  appendKeyValue(chunks, "Queued", String(queued.length))
  appendKeyValue(chunks, "Running", String(running.length))
  appendKeyValue(chunks, "Completed", String(completed.length))

  const handoff = snapshot.events.findLast((event) => event.type === "task.started")
  appendSection(chunks, "LAST HANDOFF", width)
  if (!handoff) {
    appendLine(chunks, [dim("Root has not dispatched a task yet.")])
  } else {
    const task = snapshot.tasks.find((item) => item.id === handoff.taskId)
    const agent = snapshot.agents.find((item) => item.id === handoff.agentId)
    appendLine(chunks, [accent("root"), dim("  >  "), accent(agent?.name ?? handoff.agentId ?? "worker")])
    for (const line of wrap(task?.objective ?? "", width)) appendLine(chunks, [plain(line)])
  }

  const selected = resolveTask(snapshot, selectedTaskId)
  if (selected) {
    const agent = snapshot.agents.find((item) => item.id === selected.agentId)
    appendSection(chunks, "WORKER", width, selected.status.toUpperCase())
    appendKeyValue(chunks, "Agent", agent?.name ?? selected.role, width)
    appendKeyValue(chunks, "Target", selected.target, width)
    appendKeyValue(chunks, "Attempt", String(selected.attempt))
    appendKeyValue(chunks, "Lease", selected.lease ? "HEALTHY" : "RELEASED")
    appendLine(chunks, [dim(pad("Capabilities", 14)), plain(clip(selected.capabilities.join(", "), width - 14))], false)
  }
  return new StyledText(chunks)
}

export function formatFindings(
  snapshot: EngagementSnapshot,
  selectedFindingId?: string,
  width = MAIN_WIDTH,
): StyledText {
  const chunks: TextChunk[] = []
  appendPanelTitle(chunks, "FINDINGS", width, `${snapshot.findings.length} TOTAL`)
  appendLine(chunks, [dim(countFindings(snapshot.findings))])
  appendLine(chunks, [])
  if (!snapshot.findings.length) {
    appendLine(chunks, [dim("No candidates have been submitted.")], false)
    return new StyledText(chunks)
  }
  const cardWidth = Math.max(30, Math.min(width, 72))
  for (const [index, finding] of snapshot.findings.entries()) {
    const selected = finding.id === selectedFindingId || (!selectedFindingId && index === 0)
    const border = selected ? theme.accentBright : theme.borderMuted
    appendLine(chunks, [fg(border)(`┌${"─".repeat(cardWidth - 2)}┐`)])
    appendLine(chunks, [
      fg(border)("│ "),
      selected ? bold(accent(pad(finding.id, 8))) : plain(pad(finding.id, 8)),
      fg(border)("│  "),
      fg(severityColor(finding.severity))(pad(finding.severity.toUpperCase(), 9)),
      fg(border)("│  "),
      fg(findingColor(finding.status))(pad(finding.status.toUpperCase(), cardWidth - 26)),
      fg(border)("│"),
    ])
    appendLine(chunks, [
      fg(border)("│ "),
      plain(pad(finding.title, cardWidth - 4)),
      fg(border)(" │"),
    ])
    appendLine(chunks, [fg(border)(`└${"─".repeat(cardWidth - 2)}┘`)])
  }
  appendLine(chunks, [dim("[↑↓] select   [Enter] open evidence   [r] export report")], false)
  return new StyledText(chunks)
}

export function formatFindingDetail(
  snapshot: EngagementSnapshot,
  selectedFindingId?: string,
  width = SIDE_WIDTH,
  runtime?: RuntimeDisplay,
): StyledText {
  const finding = snapshot.findings.find((item) => item.id === selectedFindingId) ?? snapshot.findings.at(0)
  const chunks: TextChunk[] = []
  if (!finding) {
    appendPanelTitle(chunks, "FINDING INSPECTOR", width)
    appendLine(chunks, [dim("Select a finding when one is available.")], false)
    return new StyledText(chunks)
  }
  appendPanelTitle(chunks, `${finding.id} / ${finding.title.toUpperCase()}`, width, finding.severity.toUpperCase())
  appendKeyValue(chunks, "Asset", finding.asset, width)
  appendKeyValue(chunks, "Discovered", finding.discoveredBy, width)
  appendKeyValue(chunks, "Validated", finding.validatedBy ?? "pending", width)
  appendLine(chunks, [dim(pad("Verdict", 14)), fg(findingColor(finding.status))(finding.status.toUpperCase())])
  appendKeyValue(chunks, "Environment", environmentLabel(snapshot, runtime), width)

  appendSection(chunks, "VALIDATION", width)
  appendLine(chunks, [validationVerdict(finding.status)])
  appendLine(chunks, [dim(pad("Fresh evidence", 16)), plain(`${finding.evidenceIds.length} artifacts`)])
  appendLine(chunks, [dim(pad("Validator", 16)), plain(finding.validatedBy ?? "not assigned")])
  appendLine(chunks, [dim(pad("Reproduction", 16)), plain(reproductionLabel(finding))])

  appendSection(chunks, "EVIDENCE", width, String(finding.evidenceIds.length))
  for (const id of finding.evidenceIds) {
    const reference = snapshot.evidence.find((item) => item.id === id)
    appendLine(chunks, [
      accent("■ "), strong(pad(id, 8)), fg(theme.borderMuted)("│ "),
      plain(clip(reference ? evidenceLabel(reference.kind) : "linked artifact", Math.max(10, width - 13))),
    ])
  }

  appendSection(chunks, "REMEDIATION", width)
  for (const line of wrap(remediationFor(finding.status), width)) appendLine(chunks, [plain(line)])
  appendLine(chunks, [])
  appendLine(chunks, [accent("[e] "), plain("Evidence"), dim("   "), accent("[r] "), plain("Report")], false)
  return new StyledText(chunks)
}

export function formatEvidence(
  snapshot: EngagementSnapshot,
  selectedEvidenceId?: string,
  width = MAIN_WIDTH,
): StyledText {
  const chunks: TextChunk[] = []
  appendPanelTitle(chunks, "EVIDENCE INDEX", width, `${snapshot.evidence.length} ARTIFACTS`)
  if (!snapshot.evidence.length) appendLine(chunks, [dim("No artifacts captured.")], false)
  for (const [index, item] of snapshot.evidence.entries()) {
    const selected = item.id === selectedEvidenceId || (!selectedEvidenceId && index === 0)
    appendLine(chunks, [
      selected ? bg(theme.selection)(accent("› ")) : accent("■ "),
      strong(pad(item.id, 8)),
      warning(pad(item.kind.toUpperCase(), 10)),
      plain(clip(sanitizeTerminalText(item.uri), Math.max(12, width - 22))),
    ])
    appendLine(chunks, [dim(`   sha256  ${item.sha256.slice(0, Math.max(16, Math.min(48, width - 14)))}…`)])
  }
  return new StyledText(chunks)
}

export function formatWorkerInspector(
  snapshot: EngagementSnapshot,
  selectedTaskId?: string,
  width = SIDE_WIDTH,
): StyledText {
  const task = resolveTask(snapshot, selectedTaskId)
  const agent = snapshot.agents.find((item) => item.id === task?.agentId)
  const chunks: TextChunk[] = []
  if (!task) {
    appendPanelTitle(chunks, "WORKER INSPECTOR", width)
    appendLine(chunks, [dim("Waiting for Root to create a task.")], false)
    return new StyledText(chunks)
  }
  appendPanelTitle(chunks, `${agent?.name ?? task.role} / WORKER`, width, task.status.toUpperCase())
  appendKeyValue(chunks, "Role", task.role.toUpperCase())
  appendKeyValue(chunks, "Task", task.id)
  appendKeyValue(chunks, "Target", task.target, width)
  appendKeyValue(chunks, "Attempt", String(task.attempt))
  appendKeyValue(chunks, "Lease", task.lease ? "HEALTHY" : "RELEASED")
  appendKeyValue(chunks, "Elapsed", taskElapsed(snapshot, task))

  appendSection(chunks, "ASSIGNMENT", width)
  for (const line of wrap(sanitizeTerminalText(task.objective), width)) appendLine(chunks, [plain(line)])

  appendSection(chunks, "CAPABILITIES", width, String(task.capabilities.length))
  for (const capability of task.capabilities) appendLine(chunks, [success("■ "), plain(capability)])

  appendSection(chunks, "LAST ACTIVITY", width)
  const activity = snapshot.events
    .filter((event) => event.taskId === task.id && event.type !== "task.heartbeat")
    .slice(-4)
  if (!activity.length) appendLine(chunks, [dim("No worker events yet.")])
  for (const event of activity) appendActivity(chunks, snapshot, event, width, false)

  if (task.result?.summary) {
    appendSection(chunks, "RESULT", width)
    for (const line of wrap(sanitizeTerminalText(task.result.summary), width)) appendLine(chunks, [plain(line)])
  }
  return new StyledText(chunks)
}

export function formatEvidenceInspector(
  snapshot: EngagementSnapshot,
  selectedEvidenceId: string | undefined,
  preview: string,
  verification: EvidenceVerification,
  width = SIDE_WIDTH,
): StyledText {
  const evidence = snapshot.evidence.find((item) => item.id === selectedEvidenceId) ?? snapshot.evidence.at(0)
  const chunks: TextChunk[] = []
  if (!evidence) {
    appendPanelTitle(chunks, "EVIDENCE INSPECTOR", width)
    appendLine(chunks, [dim("Select an artifact when one is available.")], false)
    return new StyledText(chunks)
  }
  appendPanelTitle(chunks, `${evidence.id} / ARTIFACT`, width, evidence.kind.toUpperCase())
  appendKeyValue(chunks, "Source", evidence.source ?? "unknown", width)
  appendKeyValue(chunks, "Type", evidence.contentType ?? "unknown", width)
  appendKeyValue(chunks, "Bytes", String(evidence.sizeBytes ?? "unknown"))
  appendKeyValue(chunks, "Captured", evidence.capturedAt.slice(11, 19))
  appendLine(chunks, [dim(pad("Integrity", 14)), verificationStatus(verification)])

  appendSection(chunks, "SHA-256", width)
  appendLine(chunks, [dim(evidence.sha256.slice(0, 32))])
  appendLine(chunks, [dim(evidence.sha256.slice(32))])

  appendSection(chunks, "ARTIFACT PREVIEW", width, "UNTRUSTED")
  const body = preview || (verification === "loading" ? "Loading local artifact…" : "No preview available.")
  appendLine(chunks, [plain(body)], false)
  return new StyledText(chunks)
}

export function formatCommandHelp(width = SIDE_WIDTH): StyledText {
  const chunks: TextChunk[] = []
  appendPanelTitle(chunks, "COMMANDS", width)
  appendLine(chunks, [accent(pad("1–5", 11)), plain("Mission / Swarm / Findings / Evidence / Settings")])
  appendLine(chunks, [accent(pad("↑ ↓ / j k", 11)), plain("Move current selection")])
  appendLine(chunks, [accent(pad("← →", 11)), plain("Move views; adjust values in Settings")])
  appendLine(chunks, [accent(pad("[ / ]", 11)), plain("Move between views from any page")])
  appendLine(chunks, [accent(pad("Enter / e", 11)), plain("Open supporting evidence")])
  appendLine(chunks, [accent(pad("r", 11)), plain("Export the Markdown report")])
  appendLine(chunks, [accent(pad("Tab / i", 11)), plain("Focus or leave Root chat")])
  appendLine(chunks, [accent(pad("p", 11)), plain("Pause or resume dispatch")])
  appendLine(chunks, [accent(pad("a / x", 11)), plain("Approve or deny a supervised delegation")])
  appendLine(chunks, [accent(pad("? / Ctrl+K", 11)), plain("Toggle this command guide")])
  appendLine(chunks, [accent(pad("q", 11)), plain("Quit and cancel active workers")])
  appendSection(chunks, "SAFETY", width)
  appendLine(chunks, [success("■ SCOPE LOCKED")])
  appendLine(chunks, [success("■ LOCAL ARTIFACTS")])
  appendLine(chunks, [warning("◇ FIXTURE WORKERS ONLY")], false)
  return new StyledText(chunks)
}

export function formatSettings(
  state: SettingsEditorState,
  display: SettingsDisplay,
  width = MAIN_WIDTH,
): StyledText {
  const chunks: TextChunk[] = []
  appendPanelTitle(chunks, "GENERAL SETTINGS", width, "NEXT LAUNCH")
  appendLine(chunks, [dim(`    ${pad("OPTION", 22)} VALUE`)])
  for (const [index, field] of settingsFields.entries()) {
    const selected = index === state.selectedIndex
    const label = pad(settingLabel(field), 22)
    const value = formatSettingValue(field, valueForField(state.draft, field), display, state.draft.providerID)
    const row = `${selected ? "›" : " "}   ${label} ${value}`
    appendLine(chunks, [selected ? bg(theme.selection)(accent(row)) : plain(row)])
  }
  appendRule(chunks, width)
  appendLine(chunks, [
    settingsAreDirty(state) ? warning("◇ UNSAVED CHANGES") : success("■ SAVED"),
    dim("   [← →] change   [s] save   [r] revert   [d] discover"),
  ])
  if (display.message) appendLine(chunks, [dim("status  >  "), plain(sanitizeTerminalText(display.message, 180))])
  return new StyledText(chunks)
}

export function formatSettingsInspector(
  state: SettingsEditorState,
  display: SettingsDisplay,
  width = SIDE_WIDTH,
): StyledText {
  const field = selectedSettingsField(state)
  const chunks: TextChunk[] = []
  appendPanelTitle(chunks, "SETTING INSPECTOR", width)
  appendLine(chunks, [accent(settingLabel(field).toUpperCase())])
  appendLine(chunks, [])
  for (const line of wrap(settingDescription(field), width)) appendLine(chunks, [plain(line)])
  appendSection(chunks, "CURRENT VALUE", width)
  for (const line of wrap(
    formatSettingValue(field, valueForField(state.draft, field), display, state.draft.providerID),
    width,
  )) appendLine(chunks, [plain(line)])
  if (field === "provider" || field === "model") {
    const provider = display.providers.find((item) => item.id === state.draft.providerID)
    appendSection(chunks, "OPENCODE", width)
    appendLine(chunks, [dim(pad("Discovery", 14)), discoveryStatus(display.discovery)])
    appendLine(chunks, [dim(pad("Provider", 14)), provider ? success("■ CONNECTED") : warning("◇ NOT DISCOVERED")])
    const modelAvailable = provider?.models.some((model) => model.id === state.draft.modelID) ?? false
    appendLine(chunks, [dim(pad("Model", 14)), modelAvailable ? success("■ AVAILABLE") : warning("◇ NOT DISCOVERED")])
    appendLine(chunks, [])
    for (const line of wrap("Credentials are managed by OpenCode and never rendered here.", width)) {
      appendLine(chunks, [dim(line)])
    }
  }
  if (field === "llmKind" || field === "llmBaseUrl" || field === "llmModel" || field === "llmApiKeyEnv") {
    appendSection(chunks, "ENDPOINT", width)
    appendLine(chunks, [
      dim(pad("Configured", 14)),
      llmEndpointConfigured(state.draft) ? success("■ READY") : warning("◇ INCOMPLETE"),
    ])
    appendLine(chunks, [dim(pad("Credential", 14)), plain(state.draft.llmApiKeyEnv || "none (local server)")])
    appendLine(chunks, [])
    for (const line of wrap(
      "Cyrion stores the variable name, never the key. Run `cyrion models --check` to test the endpoint.",
      width,
    )) appendLine(chunks, [dim(line)])
  }
  appendSection(chunks, "APPLY", width)
  for (const line of wrap("Saved settings take effect on the next Cyrion launch.", width)) {
    appendLine(chunks, [plain(line)])
  }
  appendLine(chunks, [dim("The active engagement is never mutated by this page.")], false)
  return new StyledText(chunks)
}

export function formatSettingsSidebar(
  state: SettingsEditorState,
  display: SettingsDisplay,
  runtime: RuntimeDisplay,
  width = SIDE_WIDTH,
): StyledText {
  const chunks: TextChunk[] = []
  appendPanelTitle(chunks, "CONFIGURATION", width)
  appendLine(chunks, [success("■ CREDENTIALS HIDDEN")])
  appendLine(chunks, [success("■ OWNER-ONLY FILE")])
  appendLine(chunks, [settingsAreDirty(state) ? warning("◇ DRAFT MODIFIED") : success("■ DRAFT SYNCED")])
  appendSection(chunks, "CURRENT SESSION", width)
  appendKeyValue(chunks, "Runtime", runtime.mode.toUpperCase())
  appendKeyValue(chunks, "Root", runtime.planner?.toUpperCase() ?? "FIXTURE")
  appendKeyValue(chunks, "Workers", runtime.workers?.toUpperCase() ?? "FIXTURE")
  appendKeyValue(chunks, "LLM", runtime.provider ?? "NOT CONFIGURED", width)
  if (runtime.notice) {
    appendSection(chunks, "RUNTIME NOTICE", width)
    for (const line of wrap(sanitizeTerminalText(runtime.notice, 400), width)) appendLine(chunks, [warning(line)])
  }
  appendSection(chunks, "CONFIG FILE", width)
  for (const line of wrap(sanitizeTerminalText(display.environmentPath, 180), width)) appendLine(chunks, [dim(line)])
  return new StyledText(chunks)
}

export function formatEngagement(
  snapshot: EngagementSnapshot,
  runtime?: RuntimeDisplay,
  width = SIDE_WIDTH,
): StyledText {
  const elapsed = elapsedSeconds(snapshot)
  const chunks: TextChunk[] = []
  appendPanelTitle(chunks, "ENGAGEMENT", width, snapshot.manifest.mode.toUpperCase())
  appendKeyValue(chunks, "Target", snapshot.manifest.scope.targets[0] ?? "none", width)
  appendKeyValue(chunks, "Profile", snapshot.manifest.profile.replace("-", " + ").toUpperCase(), width)
  if (runtime) {
    appendKeyValue(chunks, "Runtime", runtime.mode.toUpperCase())
    appendKeyValue(chunks, "Root", runtime.planner?.toUpperCase() ?? "FIXTURE")
    appendKeyValue(chunks, "Workers", runtime.workers?.toUpperCase() ?? "FIXTURE")
    if (runtime.sandbox) appendKeyValue(chunks, "Sandbox", runtime.sandbox.toUpperCase(), width)
    else appendKeyValue(chunks, "LLM config", runtime.provider ?? "NOT CONFIGURED", width)
  }
  appendLine(chunks, [
    dim(pad("Scope", 14)),
    success("■ ENFORCED"),
    dim(`  ${scopeHash(snapshot.manifest.scope).slice(0, 8)}`),
  ])
  appendLine(chunks, [
    dim(pad("Attested", 14)),
    runtime?.attestation ? success("■ OPERATOR LOCK") : warning("◇ NO LOCK"),
  ])
  appendKeyValue(chunks, "Elapsed", clock(elapsed))

  appendSection(chunks, "BUDGET", width)
  const tokens = snapshot.usage.inputTokens + snapshot.usage.outputTokens
  appendBudget(chunks, "Tokens", tokens, snapshot.manifest.budgets.maxTokens, width,
    `${compactNumber(tokens)}/${compactNumber(snapshot.manifest.budgets.maxTokens)}`)
  appendBudget(chunks, "Time", elapsed * 1000, snapshot.manifest.budgets.maxDurationMs, width,
    `${clock(elapsed)}/${formatDuration(snapshot.manifest.budgets.maxDurationMs)}`)
  appendBudget(chunks, "Cost", snapshot.usage.costUsd, snapshot.manifest.budgets.maxCostUsd, width,
    `$${snapshot.usage.costUsd.toFixed(2)}/$${snapshot.manifest.budgets.maxCostUsd.toFixed(2)}`)
  appendLine(chunks, [])
  appendKeyValue(chunks, "Agents", `${snapshot.agents.length} / ${snapshot.manifest.budgets.maxAgents}`)
  appendKeyValue(chunks, "Tasks", `${snapshot.tasks.length} / ${snapshot.manifest.budgets.maxTasks}`)
  appendKeyValue(chunks, "Parallel", String(snapshot.manifest.budgets.maxConcurrentAgents))

  appendSection(chunks, "COUNTS", width)
  appendCount(chunks, snapshot.evidence.length, "artifacts", theme.accent)
  appendCount(chunks, countStatus(snapshot, "confirmed"), "confirmed", theme.success)
  appendCount(chunks, countStatus(snapshot, "candidate"), "candidate", theme.warning)
  appendCount(chunks, countStatus(snapshot, "validating"), "validating", theme.warning)
  appendCount(chunks, countStatus(snapshot, "rejected"), "rejected", theme.danger)
  appendCount(chunks, countStatus(snapshot, "inconclusive"), "inconclusive", theme.muted, false)
  return new StyledText(chunks)
}

/** Header engagement identity: engagement ID, primary target, autonomy profile. */
export function formatHeaderMeta(snapshot: EngagementSnapshot): string {
  const target = sanitizeTerminalText(snapshot.manifest.scope.targets[0] ?? "no target", 64)
  return `${snapshot.manifest.id}  |  ${target}  |  ${snapshot.manifest.mode.toUpperCase()}`
}

export function sanitizeTerminalText(value: string, maxLength = 2_400): string {
  const clean = stripControlCharacters(value.replaceAll("\r\n", "\n").replaceAll("\r", "\n"))
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

function countStatus(snapshot: EngagementSnapshot, value: Finding["status"]): number {
  return snapshot.findings.filter((finding) => finding.status === value).length
}

function resolveTask(snapshot: EngagementSnapshot, selectedTaskId?: string): TaskRecord | undefined {
  return snapshot.tasks.find((task) => task.id === selectedTaskId)
    ?? snapshot.tasks.findLast((task) => task.status === "running")
    ?? snapshot.tasks.at(-1)
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

function appendRule(chunks: TextChunk[], width = SIDE_WIDTH): void {
  appendLine(chunks, [fg(theme.border)("─".repeat(Math.max(4, width)))])
}

/** Panel heading: bold label left, muted state token right, rule underneath. */
function appendPanelTitle(chunks: TextChunk[], label: string, width: number, meta?: string): void {
  appendLine(chunks, meta
    ? [strong(pad(label, Math.max(8, width - meta.length))), dim(meta)]
    : [strong(clip(label, width))])
  appendRule(chunks, width)
}

/** Section heading inside a panel: blank line, accent label, optional right token, rule. */
function appendSection(chunks: TextChunk[], label: string, width = MAIN_WIDTH, meta?: string): void {
  appendLine(chunks, [])
  appendLine(chunks, meta
    ? [accent(pad(label, Math.max(8, width - meta.length))), dim(meta)]
    : [accent(clip(label, width))])
  appendLine(chunks, [fg(theme.borderMuted)("─".repeat(Math.max(4, width)))])
}

function appendKeyValue(chunks: TextChunk[], key: string, value: string, width?: number): void {
  appendLine(chunks, [dim(pad(key, 14)), plain(width ? clip(value, Math.max(8, width - 14)) : value)])
}

function appendCount(chunks: TextChunk[], value: number, label: string, color: string, newline = true): void {
  appendLine(chunks, [fg(color)("■ "), strong(pad(String(value), 4)), plain(label)], newline)
}

function appendBudget(
  chunks: TextChunk[],
  label: string,
  used: number,
  limit: number,
  width: number,
  value: string,
): void {
  const meterWidth = Math.max(8, Math.min(width - 4, 20))
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0
  const filled = Math.round(ratio * meterWidth)
  const percent = `${Math.round(ratio * 100)}% used`
  appendLine(chunks, [dim(pad(label, 10)), plain(pad(value, Math.max(1, width - 10 - percent.length))), dim(percent)])
  appendLine(chunks, [
    fg(theme.borderMuted)("["),
    accent("■".repeat(filled)),
    fg(theme.borderMuted)("□".repeat(meterWidth - filled)),
    fg(theme.borderMuted)("]"),
  ])
}

function appendActivity(
  chunks: TextChunk[],
  snapshot: EngagementSnapshot,
  event: CyrionEvent,
  width: number,
  withAgent = true,
): void {
  const stamp = clock(Math.max(0, Math.floor((Date.parse(event.timestamp) - startedMs(snapshot)) / 1000)))
  const agent = withAgent ? pad(agentName(snapshot, event.agentId), 15) : ""
  const message = clip(eventPhrase(event), Math.max(12, width - stamp.length - agent.length - 4))
  appendLine(chunks, withAgent
    ? [dim(`${stamp}  `), accent(agent), plain(message)]
    : [dim(`${stamp}  `), plain(message)])
}

function appendTableEdge(chunks: TextChunk[], columns: number[], kind: "top" | "middle" | "bottom"): void {
  const [left, join, right] = kind === "top"
    ? ["┌", "┬", "┐"]
    : kind === "middle" ? ["├", "┼", "┤"] : ["└", "┴", "┘"]
  const cells = columns.map((column) => "─".repeat(column + 2))
  appendLine(chunks, [fg(theme.borderMuted)(`${left}${cells.join(join)}${right}`)])
}

function appendTableRow(chunks: TextChunk[], cells: TextChunk[], selected = false): void {
  const divider = fg(selected ? theme.accentDark : theme.borderMuted)
  const parts: TextChunk[] = [fg(theme.borderMuted)("│ ")]
  for (const [index, cell] of cells.entries()) {
    parts.push(cell)
    parts.push(index === cells.length - 1 ? fg(theme.borderMuted)(" │") : divider(" │ "))
  }
  appendLine(chunks, parts)
}

function status(value: AgentStatus, role: AgentRole): TextChunk {
  return fg(agentColor(value, role))(agentStateLabel(value, role))
}

function statusGlyph(value: AgentStatus, role: AgentRole): TextChunk {
  return fg(agentColor(value, role))("■")
}

function agentStateLabel(value: AgentStatus, role: AgentRole): string {
  if (value === "running" && role === "root") return "ORCHESTRATING"
  if (value === "running" && role === "validator") return "VERIFYING"
  if (value === "running" && role === "reporter") return "REPORTING"
  if (value === "completed") return "COMPLETE"
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

function agentName(snapshot: EngagementSnapshot, agentId?: string): string {
  if (!agentId) return "controller"
  const agent: AgentRecord | undefined = snapshot.agents.find((item) => item.id === agentId)
  return agent?.name ?? agentId
}

function taskStatus(value: TaskStatus): TextChunk {
  return fg(taskColor(value))(value.toUpperCase())
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

function heartbeatLabel(snapshot: EngagementSnapshot): string {
  if (snapshot.status === "paused") return "paused"
  const running = snapshot.tasks.filter((task) => task.status === "running")
  return !running.length || running.every((task) => task.lease) ? "healthy" : "stale"
}

function heartbeatGlyph(snapshot: EngagementSnapshot): TextChunk {
  if (snapshot.status === "paused") return warning("◇")
  if (snapshot.status !== "running") return success("■")
  const running = snapshot.tasks.filter((task) => task.status === "running")
  return !running.length || running.every((task) => task.lease) ? success("■") : warning("◇")
}

function validationVerdict(value: Finding["status"]): TextChunk {
  if (value === "confirmed") return success("■ REPRODUCTION PASS")
  if (value === "rejected") return fg(theme.danger)("■ REPRODUCTION REJECTED")
  if (value === "inconclusive") return warning("◇ REPRODUCTION INCONCLUSIVE")
  return warning("◇ REPRODUCTION PENDING")
}

function environmentLabel(snapshot: EngagementSnapshot, runtime?: RuntimeDisplay): string {
  const profile = snapshot.manifest.profile.replace("-", " + ").toUpperCase()
  if (!runtime) return profile
  return `LAB / ${runtime.mode.toUpperCase()} ${profile}`
}

/** Reproducibility is reported beside the verdict, never folded into it. */
function reproductionLabel(finding: Finding): string {
  const record = finding.reproduction
  if (!record) {
    return finding.status === "candidate" || finding.status === "validating" ? "not attempted" : "no proof bundle"
  }
  const verdict = record.verdict === "reproduced"
    ? "replayed"
    : record.verdict === "not-reproduced" ? "did not replay" : "inconclusive"
  return `${verdict} · bundle ${record.bundleId}`
}

function evidenceLabel(kind: string): string {
  if (kind === "request") return "Request metadata"
  if (kind === "response") return "Response comparison"
  if (kind === "log") return "Validation log"
  if (kind === "report") return "Report artifact"
  if (kind === "poc") return "Proof bundle"
  return "Fixture artifact"
}

function settingLabel(field: SettingsField): string {
  if (field === "provider") return "OpenCode provider"
  if (field === "model") return "OpenCode model"
  if (field === "llmKind") return "LLM endpoint kind"
  if (field === "llmBaseUrl") return "LLM endpoint URL"
  if (field === "llmModel") return "LLM model"
  if (field === "llmApiKeyEnv") return "LLM key variable"
  if (field === "defaultPlanner") return "Root planner"
  if (field === "defaultWorkers") return "Worker review"
  if (field === "defaultMode") return "Default mode"
  if (field === "defaultFixture") return "Demo scenario"
  return "Color profile"
}

function settingDescription(field: SettingsField): string {
  if (field === "provider") return "Connected OpenCode provider, discovered from your OpenCode installation."
  if (field === "model") return "Model selected from the active OpenCode provider's discovered catalog."
  if (field === "llmKind") {
    return "How Cyrion talks to the endpoint. OPENAI COMPATIBLE covers vLLM, llama.cpp, LM Studio, OpenRouter, and Ollama's /v1 path."
  }
  if (field === "llmBaseUrl") {
    return "Endpoint for the LLM planner and worker review, such as http://127.0.0.1:11434. Press Enter to type one. Cleartext to a remote host is refused."
  }
  if (field === "llmModel") return "Model the endpoint serves, such as qwen3:14b. Press Enter to type one."
  if (field === "llmApiKeyEnv") {
    return "Name of the environment variable holding the key, such as OPENAI_API_KEY. The key itself is never read or rendered here. Leave empty for a local server."
  }
  if (field === "defaultPlanner") {
    return "Fixture plans deterministically. OpenCode and LLM review each controller transition; LLM-AUTHOR lets the model propose transitions, which the controller still validates."
  }
  if (field === "defaultWorkers") {
    return "OpenCode and LLM review canonical worker results but cannot alter findings, evidence, verdicts, or reports."
  }
  if (field === "defaultMode") return "Default controller supervision policy when --mode is not supplied."
  if (field === "defaultFixture") return "Default deterministic demo scenario when --fixture is not supplied."
  return "Terminal color behavior. Auto follows NO_COLOR; explicit profiles override it."
}

function formatSettingValue(field: SettingsField, value: string, display: SettingsDisplay, providerID: string): string {
  if (field === "provider") {
    const provider = display.providers.find((item) => item.id === value)
    return provider ? `${provider.name} / ${provider.id}` : value || "NOT CONFIGURED"
  }
  if (field === "model") {
    const model = display.providers.find((provider) => provider.id === providerID)?.models.find((item) => item.id === value)
    return model && model.name !== model.id ? `${model.name} / ${model.id}` : value || "NOT CONFIGURED"
  }
  // Operator-typed text is shown as written; only the fixed choices are shouted.
  if (field === "llmBaseUrl" || field === "llmModel" || field === "llmApiKeyEnv") {
    return sanitizeTerminalText(value, 120) || "NOT CONFIGURED"
  }
  return value.toUpperCase().replaceAll("-", " ")
}

function runtimeLabel(runtime: RuntimeDisplay): string {
  const planner = runtime.planner?.toUpperCase() ?? "FIXTURE"
  const workers = runtime.workers?.toUpperCase() ?? "FIXTURE"
  const execution = runtime.sandbox
    ? `SANDBOX ${runtime.sandbox.toUpperCase()}`
    : `LLM ${runtime.provider ?? "NOT CONFIGURED"}`
  return `${runtime.mode.toUpperCase()} / ROOT ${planner} / WORKERS ${workers} / ${execution}`
}

function discoveryStatus(value: SettingsDisplay["discovery"]): TextChunk {
  if (value === "ready") return success("■ READY")
  if (value === "loading") return warning("◇ DISCOVERING")
  if (value === "failed") return fg(theme.danger)("! FAILED")
  return dim("◇ NOT STARTED")
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

/** Operator-facing sentence for one controller event. Never renders untrusted payload text. */
const eventPhrases: Partial<Record<CyrionEvent["type"], string>> = {
  "engagement.started": "Engagement started",
  "engagement.recovered": "Engagement recovered",
  "engagement.paused": "Dispatch paused",
  "engagement.resumed": "Dispatch resumed",
  "engagement.cancelled": "Engagement cancelled",
  "engagement.completed": "Engagement complete",
  "engagement.failed": "Engagement failed",
  "root.decision.proposed": "Root proposed the next action",
  "root.decision.rejected": "Root decision rejected",
  "root.decision.awaiting_approval": "Awaiting supervisor approval",
  "root.decision.approved": "Delegation approved",
  "root.decision.denied": "Delegation denied",
  "root.message": "Root replied to the operator",
  "task.queued": "Task queued",
  "task.started": "Task dispatched",
  "task.lease.acquired": "Lease acquired",
  "task.heartbeat": "Lease heartbeat",
  "task.reconciled": "Task reconciled",
  "task.cancelled": "Task cancelled",
  "task.completed": "Result accepted",
  "task.failed": "Task failed",
  "task.result.rejected": "Result rejected",
  "tool.request.accepted": "Tool call accepted",
  "tool.request.completed": "Tool call completed",
  "tool.request.rejected": "Tool call rejected",
  "budget.updated": "Budget updated",
  "budget.exceeded": "Budget exceeded",
  "finding.updated": "Finding updated",
  "operator.message": "Operator message",
}

function eventPhrase(event: CyrionEvent): string {
  return eventPhrases[event.type] ?? event.type.replaceAll(".", " / ")
}

function startedMs(snapshot: EngagementSnapshot): number {
  return snapshot.startedAt ? Date.parse(snapshot.startedAt) : Date.now()
}

function elapsedSeconds(snapshot: EngagementSnapshot): number {
  if (!snapshot.startedAt) return 0
  const end = snapshot.finishedAt ? Date.parse(snapshot.finishedAt) : Date.now()
  return Math.max(0, Math.floor((end - startedMs(snapshot)) / 1000))
}

function taskElapsed(snapshot: EngagementSnapshot, task: TaskRecord): string {
  const started = snapshot.events.find((event) => event.taskId === task.id && event.type === "task.started")
  if (!started) return "--:--"
  const terminal = snapshot.events.findLast((event) =>
    event.taskId === task.id
    && (event.type === "task.completed" || event.type === "task.failed" || event.type === "task.cancelled"))
  const end = terminal ? Date.parse(terminal.timestamp) : Date.now()
  return clock(Math.max(0, Math.floor((end - Date.parse(started.timestamp)) / 1000)))
}

function clock(totalSeconds: number): string {
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0")
  const seconds = String(totalSeconds % 60).padStart(2, "0")
  return `${minutes}:${seconds}`
}

function compactNumber(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}K` : String(value)
}

function formatDuration(value: number): string {
  return clock(Math.floor(value / 1000))
}

function clip(value: string, width: number): string {
  if (width <= 1) return ""
  return value.length <= width ? value : `${value.slice(0, Math.max(1, width - 1))}…`
}

function pad(value: string, width: number): string {
  return clip(value, width).padEnd(width)
}

function wrap(value: string, width: number): string[] {
  const limit = Math.max(12, width)
  const lines: string[] = []
  for (const paragraph of value.split("\n")) {
    let current = ""
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!current.length) current = word
      else if (current.length + word.length + 1 <= limit) current = `${current} ${word}`
      else {
        lines.push(current)
        current = word
      }
    }
    lines.push(current)
  }
  return lines.length ? lines : [""]
}

/**
 * Drops C0/C1 control characters while keeping tab and newline, so untrusted
 * worker, provider, and artifact text cannot emit terminal escape sequences.
 */
function stripControlCharacters(value: string): string {
  let output = ""
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code === 9 || code === 10) output += character
    else if (code < 32 || (code >= 127 && code <= 159)) continue
    else output += character
  }
  return output
}
