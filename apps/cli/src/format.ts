import type { AgentRecord, EngagementSnapshot, Finding } from "@cyrion/contracts"

export type ViewName = "MISSION" | "SWARM" | "FINDINGS" | "EVIDENCE"

const stateLabel = (status: AgentRecord["status"]): string => status.toUpperCase().padEnd(13)

export function formatSwarm(snapshot: EngagementSnapshot): string {
  const root = snapshot.agents.find((agent) => agent.role === "root")
  const workers = snapshot.agents.filter((agent) => agent.role !== "root")
  const lines = [
    `${root?.name ?? "root-agent"}  ${stateLabel(root?.status ?? "queued")}`,
    "────────────────────────────",
    `■  ${root?.name ?? "root-agent"}`,
  ]
  for (const [index, worker] of workers.entries()) {
    const branch = index === workers.length - 1 ? "└─" : "├─"
    lines.push(`│`, `${branch} ■  ${worker.name}`, `│     ${stateLabel(worker.status)}`)
  }
  const active = snapshot.agents.filter((agent) => agent.status === "running").length
  lines.push("", "────────────────────────────", `${active} active / ${workers.length} workers`)
  return lines.join("\n")
}

export function formatMission(snapshot: EngagementSnapshot): string {
  const plan = snapshot.tasks.map((task, index) => {
    const number = String(index + 1).padStart(2, "0")
    return `${number}  ${task.objective.slice(0, 42).padEnd(42)} ${task.status.toUpperCase()}`
  })
  const feed = snapshot.events.slice(-6).map((event) => {
    const time = event.timestamp.slice(11, 19)
    return `${time}  ${(event.agentId ?? "controller").padEnd(15)} ${event.type}`
  })
  return [
    "[ ROOT AGENT / BRIEFING ]",
    "",
    `operator  >  ${snapshot.manifest.objective}`,
    `root      >  ${missionSummary(snapshot)}`,
    "",
    "──────────────── PLAN ────────────────",
    ...(plan.length ? plan : ["No tasks delegated yet."]),
    "",
    "──────────── ACTIVITY FEED ───────────",
    ...feed,
  ].join("\n")
}

export function formatTaskBoard(snapshot: EngagementSnapshot): string {
  const rows = snapshot.tasks.map((task) => {
    const agent = snapshot.agents.find((item) => item.taskId === task.id)
    return `${(agent?.name ?? "queued").padEnd(15)} ${task.objective.slice(0, 33).padEnd(34)} ${task.status.toUpperCase().padEnd(10)}`
  })
  const selected = snapshot.tasks.findLast((task) => task.status === "running") ?? snapshot.tasks.at(-1)
  const activity = selected
    ? snapshot.events
      .filter((event) => event.taskId === selected.id)
      .slice(-5)
      .map((event) => `${event.timestamp.slice(11, 19)}  ${event.type}`)
    : ["Waiting for Root dispatch."]
  return [
    "LIVE TASK BOARD",
    "────────────────────────────────────────────────────────────",
    "AGENT           TASK                               STATE",
    ...rows,
    "",
    `── ${(selected?.role ?? "root").toUpperCase()} / LIVE ACTIVITY ─────────────────────────`,
    ...activity,
    "",
    "■ Isolated session  |  ■ Scope enforced  |  ■ Event stream healthy",
  ].join("\n")
}

export function formatFindings(snapshot: EngagementSnapshot): string {
  if (!snapshot.findings.length) return "FINDINGS\n\nNo candidates have been submitted."
  return [
    `FINDINGS\n${countFindings(snapshot.findings)}`,
    "",
    ...snapshot.findings.flatMap((finding) => [
      `${finding.id}  |  ${finding.severity.toUpperCase()}  |  ${finding.status.toUpperCase()}`,
      finding.title,
      "────────────────────────────",
    ]),
  ].join("\n")
}

export function formatFindingDetail(snapshot: EngagementSnapshot): string {
  const finding = snapshot.findings.at(0)
  if (!finding) return "FINDING INSPECTOR\n\nSelect a finding when one is available."
  return [
    `${finding.id} / ${finding.title.toUpperCase()}`,
    "",
    `Asset          :  ${finding.asset}`,
    `Discovered     :  ${finding.discoveredBy}`,
    `Validated      :  ${finding.validatedBy ?? "pending"}`,
    `Verdict        :  ${finding.status.toUpperCase()}`,
    "",
    "──────────────── VALIDATION ─────────────────",
    finding.status === "confirmed" ? "Independent reproduction: PASS" : "Independent reproduction: PENDING",
    `Fresh evidence: ${finding.evidenceIds.length} artifacts`,
    "",
    "──────────────── EVIDENCE ───────────────────",
    ...finding.evidenceIds.map((id) => `${id}  |  linked artifact`),
    "",
    "──────────────── REMEDIATION ────────────────",
    "Enforce object-level authorization for every request.",
  ].join("\n")
}

export function formatEvidence(snapshot: EngagementSnapshot): string {
  if (!snapshot.evidence.length) return "EVIDENCE\n\nNo artifacts captured."
  return [
    `EVIDENCE INDEX  /  ${snapshot.evidence.length} ARTIFACTS`,
    "",
    ...snapshot.evidence.map((item) => [
      `${item.id}  ${item.kind.toUpperCase().padEnd(9)} ${item.uri}`,
      `     sha256 ${item.sha256.slice(0, 24)}…`,
    ].join("\n")),
  ].join("\n")
}

export function formatEngagement(snapshot: EngagementSnapshot): string {
  const elapsed = snapshot.startedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.startedAt)) / 1000))
    : 0
  const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0")
  const seconds = String(elapsed % 60).padStart(2, "0")
  return [
    "ENGAGEMENT",
    "────────────────────────────",
    `Target     ${snapshot.manifest.scope.targets[0]}`,
    `Profile    ${snapshot.manifest.profile.replace("-", " + ").toUpperCase()}`,
    `Scope      LOCKED`,
    `Elapsed    ${minutes}:${seconds}`,
    "",
    "BUDGET",
    "────────────────────────────",
    `Agents     ${snapshot.agents.length}/${snapshot.manifest.budgets.maxAgents}`,
    `Tasks      ${snapshot.tasks.length}/${snapshot.manifest.budgets.maxTasks}`,
    `Parallel   ${snapshot.manifest.budgets.maxConcurrentAgents}`,
    "",
    "COUNTS",
    "────────────────────────────",
    `${snapshot.findings.filter((item) => item.status === "confirmed").length} confirmed`,
    `${snapshot.findings.filter((item) => item.status === "candidate").length} candidate`,
    `${snapshot.evidence.length} artifacts`,
  ].join("\n")
}

function missionSummary(snapshot: EngagementSnapshot): string {
  if (snapshot.status === "completed") return "Mission complete. Report and evidence are ready."
  if (snapshot.status === "paused") return "Dispatch paused by operator; active operations are visible."
  const running = snapshot.tasks.filter((task) => task.status === "running").map((task) => task.role)
  if (running.length) return `${running.join(" + ")} workers are running in bounded sessions.`
  return "Building the next bounded dispatch decision."
}

function countFindings(findings: Finding[]): string {
  const confirmed = findings.filter((finding) => finding.status === "confirmed").length
  const candidate = findings.filter((finding) => finding.status === "candidate").length
  return `${confirmed} confirmed / ${candidate} candidate`
}
