import type { EngagementSnapshot, Finding } from "@cyrion/contracts"
import { buildCommunityReport, type CommunityReport, type ReportContext } from "./report"
import { clean, inline, paragraph } from "./text"

export function renderJsonReport(snapshot: EngagementSnapshot, context: ReportContext = {}): string {
  return `${JSON.stringify(buildCommunityReport(snapshot, context), null, 2)}\n`
}

export function renderMarkdownReport(snapshot: EngagementSnapshot, context: ReportContext = {}): string {
  const report = buildCommunityReport(snapshot, context)
  const lines = [
    `# ${inline(report.engagement.name)} — assessment report`,
    "",
    `Report contract: \`${report.version}\``,
    "",
    "## Engagement",
    "",
    `- ID: \`${inline(report.engagement.id)}\``,
    `- Status: **${inline(report.engagement.status.toUpperCase())}**`,
    `- Profile: \`${inline(report.engagement.profile)}\` in \`${inline(report.engagement.mode)}\` mode`,
    `- Started: ${inline(report.engagement.startedAt ?? "not recorded")}`,
    `- Finished: ${inline(report.engagement.finishedAt ?? "not recorded")}`,
    "",
    "## Authorization and scope",
    "",
    `- Scope hash: \`${inline(report.scope.hash)}\``,
    `- Attestation: ${report.scope.attestation ? paragraph(report.scope.attestation) : "**none supplied**"}`,
    `- Targets: ${list(report.scope.targets)}`,
    `- Excluded: ${list(report.scope.excluded)}`,
    `- Capabilities: ${list(report.scope.capabilities)}`,
    "",
    "## Objective",
    "",
    paragraph(report.engagement.objective),
    "",
    "## Outcome",
    "",
    "| Tasks | Completed | Confirmed | Reproduced | Rejected | Inconclusive | Unresolved | Artifacts | Refusals |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${report.summary.tasks} | ${report.summary.completedTasks} | ${report.summary.confirmed} `
      + `| ${report.summary.reproduced} | ${report.summary.rejected} | ${report.summary.inconclusive} `
      + `| ${report.summary.unresolved} | ${report.summary.artifacts} | ${report.summary.refusals} |`,
    "",
    "Confirmed findings by severity: "
      + Object.entries(report.severities).map(([name, total]) => `${name} ${total}`).join(", "),
    "",
    "## Methodology",
    "",
    report.methodology.length
      ? report.methodology.map((skill) => `- \`${inline(skill)}\``).join("\n")
      : "- No skill was recorded for the tasks in this engagement.",
    "",
    "## Environment",
    "",
    `- Sandbox: ${report.environment.sandbox ? `\`${inline(report.environment.sandbox)}\`` : "not recorded"}`,
    `- Root planner: ${report.environment.runtime ? `\`${inline(report.environment.runtime.planner)}\`` : "not recorded"}`,
    `- Worker review: ${report.environment.runtime ? `\`${inline(report.environment.runtime.workers)}\`` : "not recorded"}`,
    "",
  ]

  if (report.environment.models?.length) {
    lines.push("| Role | Endpoint | Model |", "| --- | --- | --- |")
    for (const entry of report.environment.models) {
      lines.push(`| ${inline(entry.role)} | ${inline(entry.endpoint)} | ${inline(entry.model)} |`)
    }
    lines.push("")
  }
  if (report.environment.tools?.length) {
    lines.push("| Tool | Version |", "| --- | --- |")
    for (const tool of report.environment.tools) lines.push(`| ${inline(tool.name)} | ${inline(tool.version)} |`)
    lines.push("")
  }
  if (report.environment.knowledge) {
    const knowledge = report.environment.knowledge
    lines.push(
      "### Knowledge base",
      "",
      `- Corpus: \`${inline(knowledge.corpusVersion)}\` — ${knowledge.documents} document(s), ${knowledge.chunks} chunk(s)`,
      `- Retrieval: ${inline(knowledge.retrieval)}`
        + (knowledge.embeddingModel ? ` via \`${inline(knowledge.embeddingModel)}\`` : ""),
      "",
      "| Source | Licence | Documents |",
      "| --- | --- | ---: |",
      ...knowledge.sources.map((source) => `| ${inline(source.id)} | ${inline(source.license)} | ${source.documents} |`),
      "",
    )
  }

  lines.push(
    "## Budgets",
    "",
    "| | Granted | Consumed |",
    "| --- | ---: | ---: |",
    `| Tokens | ${report.budgets.granted.maxTokens} | ${report.budgets.consumed.inputTokens + report.budgets.consumed.outputTokens} |`,
    `| Cost (USD) | ${report.budgets.granted.maxCostUsd} | ${report.budgets.consumed.costUsd} |`,
    `| Tasks | ${report.budgets.granted.maxTasks} | ${report.summary.tasks} |`,
    "",
    "## Findings",
    "",
  )

  if (!report.findings.length) lines.push("No candidate or confirmed findings were recorded.", "")
  for (const finding of report.findings) {
    lines.push(
      `### ${inline(finding.id)} — ${inline(finding.title)}`,
      "",
      `- Status: **${inline(finding.status.toUpperCase())}**`,
      `- Severity: **${inline(finding.severity.toUpperCase())}**`,
      `- Asset: \`${inline(finding.asset)}\``,
      `- Discovered by: \`${inline(finding.discoveredBy)}\``,
      `- Methodology: ${finding.skillId ? `\`${inline(finding.skillId)}\`` : "not recorded"}`,
      `- Validated by: ${finding.validatedBy ? `\`${inline(finding.validatedBy)}\`` : "not independently validated"}`,
      `- Reproduction: ${reproductionText(finding)}`,
      `- Evidence: ${finding.evidenceIds.map((id) => `\`${inline(id)}\``).join(", ") || "none"}`,
      "",
      paragraph(finding.summary),
      "",
    )
  }

  lines.push("## Validation records", "")
  if (!report.validations.length) lines.push("No finding reached independent validation.", "")
  else {
    lines.push("| Finding | Verdict | Validator | Reproduction |", "| --- | --- | --- | --- |")
    for (const record of report.validations) {
      lines.push(
        `| ${inline(record.findingId)} | ${inline(record.status)} | ${inline(record.validatedBy ?? "none")} `
        + `| ${record.reproduction ? `${inline(record.reproduction.verdict)} (\`${inline(record.reproduction.bundleId)}\`)` : "no bundle"} |`,
      )
    }
    lines.push("")
  }

  lines.push(
    "## Evidence index",
    "",
    "| ID | Kind | Source | Bytes | SHA-256 | URI |",
    "| --- | --- | --- | ---: | --- | --- |",
  )
  for (const evidence of report.evidence) {
    lines.push(
      `| ${inline(evidence.id)} | ${inline(evidence.kind)} | ${inline(evidence.source ?? "unknown")} `
      + `| ${evidence.sizeBytes ?? "unknown"} | \`${inline(evidence.sha256)}\` | \`${inline(evidence.uri)}\` |`,
    )
  }
  if (!report.evidence.length) lines.push("| _none_ |  |  |  |  |  |")

  lines.push("", "## Limitations and coverage gaps", "")
  for (const limitation of report.limitations) lines.push(`- ${paragraph(limitation)}`)
  lines.push("")
  return lines.join("\n")
}

export function reproductionText(finding: Finding): string {
  const record = finding.reproduction
  if (!record) {
    return finding.status === "candidate" || finding.status === "validating"
      ? "not attempted; this candidate has not been validated yet"
      : "no proof bundle; this verdict rests on the validator's own observation"
  }
  const verdict = record.verdict === "reproduced"
    ? "reproduced independently"
    : record.verdict === "not-reproduced" ? "did not reproduce" : "inconclusive"
  return `${verdict} — ${record.steps} step(s) on ${inline(record.runner)} at ${inline(record.at)}, `
    + `bundle \`${inline(record.bundleId)}\``
}

function list(values: readonly string[]): string {
  return values.length ? values.map((value) => `\`${inline(value)}\``).join(", ") : "none"
}

export type { CommunityReport }
export { clean }
