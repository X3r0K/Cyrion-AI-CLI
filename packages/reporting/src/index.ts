import type { EngagementSnapshot, Finding } from "@cyrion/contracts"

export const REPORT_VERSION = "cyrion.community/report-v1" as const

export interface CommunityReport {
  version: typeof REPORT_VERSION
  generatedAt: string
  engagement: {
    id: string
    name: string
    objective: string
    status: EngagementSnapshot["status"]
    profile: string
    targets: string[]
    startedAt?: string
    finishedAt?: string
  }
  summary: {
    tasks: number
    completedTasks: number
    confirmed: number
    rejected: number
    inconclusive: number
    unresolved: number
    artifacts: number
  }
  findings: Finding[]
  evidence: Array<{
    id: string
    kind: string
    uri: string
    sha256: string
    capturedAt: string
    source?: string
    contentType?: string
    sizeBytes?: number
  }>
  limitations: string[]
}

export function buildCommunityReport(snapshot: EngagementSnapshot): CommunityReport {
  return {
    version: REPORT_VERSION,
    generatedAt: snapshot.finishedAt ?? snapshot.startedAt ?? new Date(0).toISOString(),
    engagement: {
      id: snapshot.manifest.id,
      name: snapshot.manifest.name,
      objective: snapshot.manifest.objective,
      status: snapshot.status,
      profile: snapshot.manifest.profile,
      targets: [...snapshot.manifest.scope.targets],
      ...(snapshot.startedAt ? { startedAt: snapshot.startedAt } : {}),
      ...(snapshot.finishedAt ? { finishedAt: snapshot.finishedAt } : {}),
    },
    summary: {
      tasks: snapshot.tasks.length,
      completedTasks: snapshot.tasks.filter((task) => task.status === "completed").length,
      confirmed: count(snapshot, "confirmed"),
      rejected: count(snapshot, "rejected"),
      inconclusive: count(snapshot, "inconclusive"),
      unresolved: snapshot.findings.filter((finding) =>
        finding.status === "candidate" || finding.status === "validating" || finding.status === "inconclusive"
      ).length,
      artifacts: snapshot.evidence.length,
    },
    findings: structuredClone(snapshot.findings),
    evidence: structuredClone(snapshot.evidence),
    limitations: [
      "This community alpha uses deterministic fixture workers and does not perform a live network assessment.",
      "Only independently validated records marked confirmed should be treated as confirmed findings.",
      "Artifact references identify local evidence; artifact contents are intentionally omitted from this report export.",
    ],
  }
}

export function renderJsonReport(snapshot: EngagementSnapshot): string {
  return `${JSON.stringify(buildCommunityReport(snapshot), null, 2)}\n`
}

export function renderMarkdownReport(snapshot: EngagementSnapshot): string {
  const report = buildCommunityReport(snapshot)
  const lines = [
    `# ${inline(report.engagement.name)} — assessment report`,
    "",
    `Report contract: \`${report.version}\``,
    "",
    "## Engagement",
    "",
    `- ID: \`${inline(report.engagement.id)}\``,
    `- Status: **${inline(report.engagement.status.toUpperCase())}**`,
    `- Profile: \`${inline(report.engagement.profile)}\``,
    `- Targets: ${report.engagement.targets.map((target) => `\`${inline(target)}\``).join(", ")}`,
    `- Started: ${inline(report.engagement.startedAt ?? "not recorded")}`,
    `- Finished: ${inline(report.engagement.finishedAt ?? "not recorded")}`,
    "",
    "## Objective",
    "",
    paragraph(report.engagement.objective),
    "",
    "## Outcome",
    "",
    "| Tasks | Completed | Confirmed | Rejected | Inconclusive | Unresolved | Artifacts |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${report.summary.tasks} | ${report.summary.completedTasks} | ${report.summary.confirmed} | ${report.summary.rejected} | ${report.summary.inconclusive} | ${report.summary.unresolved} | ${report.summary.artifacts} |`,
    "",
    "## Findings",
    "",
  ]

  if (!report.findings.length) lines.push("No candidate or confirmed findings were recorded.", "")
  for (const finding of report.findings) {
    lines.push(
      `### ${inline(finding.id)} — ${inline(finding.title)}`,
      "",
      `- Status: **${inline(finding.status.toUpperCase())}**`,
      `- Severity: **${inline(finding.severity.toUpperCase())}**`,
      `- Asset: \`${inline(finding.asset)}\``,
      `- Discovered by: \`${inline(finding.discoveredBy)}\``,
      `- Validated by: ${finding.validatedBy ? `\`${inline(finding.validatedBy)}\`` : "not independently validated"}`,
      `- Evidence: ${finding.evidenceIds.map((id) => `\`${inline(id)}\``).join(", ") || "none"}`,
      "",
      paragraph(finding.summary),
      "",
    )
  }

  lines.push(
    "## Evidence index",
    "",
    "| ID | Kind | Source | Bytes | SHA-256 | URI |",
    "| --- | --- | --- | ---: | --- | --- |",
  )
  for (const evidence of report.evidence) {
    lines.push(`| ${cell(evidence.id)} | ${cell(evidence.kind)} | ${cell(evidence.source ?? "unknown")} | ${evidence.sizeBytes ?? "unknown"} | \`${inline(evidence.sha256)}\` | \`${inline(evidence.uri)}\` |`)
  }
  if (!report.evidence.length) lines.push("| _none_ |  |  |  |  |  |")

  lines.push("", "## Limitations", "")
  for (const limitation of report.limitations) lines.push(`- ${paragraph(limitation)}`)
  lines.push("")
  return lines.join("\n")
}

function count(snapshot: EngagementSnapshot, status: Finding["status"]): number {
  return snapshot.findings.filter((finding) => finding.status === status).length
}

function paragraph(value: string): string {
  return clean(value).replaceAll("\n", " ")
}

function inline(value: string): string {
  return clean(value).replaceAll("`", "\\`").replaceAll("|", "\\|").replaceAll("\n", " ")
}

function cell(value: string): string {
  return inline(value)
}

function clean(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "")
}
