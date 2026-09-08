import type { EngagementSnapshot, Finding, Severity } from "@cyrion/contracts"
import { atOrAbove, buildCommunityReport, type ReportContext } from "./report"
import { escapeXml } from "./text"

export interface GateOptions extends ReportContext {
  /** Confirmed findings at or above this severity fail the gate. */
  failOn?: Severity
  /** Treat an unresolved candidate or inconclusive verdict as a failure too. */
  failOnUnresolved?: boolean
}

export interface GateOutcome {
  passed: boolean
  failOn: Severity
  /** Findings that tripped the gate. */
  failures: Finding[]
  /** Why the gate failed, in the operator's language. */
  reasons: string[]
}

/**
 * Decides whether a run should stop a pipeline.
 *
 * A gate answers one question — is this bad enough to block? — so it counts
 * only confirmed findings by default. A candidate nobody validated is not
 * evidence of a problem, and failing on it teaches people to ignore the gate.
 */
export function evaluateGate(snapshot: EngagementSnapshot, options: GateOptions = {}): GateOutcome {
  const failOn = options.failOn ?? "high"
  const admitted = new Set(atOrAbove(failOn))
  const failures = snapshot.findings.filter((finding) =>
    finding.status === "confirmed" && admitted.has(finding.severity))
  const reasons: string[] = []
  if (failures.length) {
    reasons.push(`${failures.length} confirmed finding(s) at or above ${failOn}`)
  }
  if (options.failOnUnresolved) {
    const unresolved = snapshot.findings.filter((finding) =>
      finding.status === "candidate" || finding.status === "validating" || finding.status === "inconclusive")
    if (unresolved.length) reasons.push(`${unresolved.length} finding(s) left unresolved`)
  }
  // An engagement that did not finish proves nothing about the target.
  if (snapshot.status !== "completed") reasons.push(`the engagement ended as ${snapshot.status}`)
  return { passed: reasons.length === 0, failOn, failures, reasons }
}

/**
 * JUnit XML, so a pipeline shows each finding as a test.
 *
 * One case per finding: confirmed at or above the gate fails, an unresolved
 * verdict is skipped rather than silently passed, and a rejected candidate
 * passes — the target was checked and did not reproduce it.
 */
export function renderJUnitReport(snapshot: EngagementSnapshot, options: GateOptions = {}): string {
  const report = buildCommunityReport(snapshot, options)
  const gate = evaluateGate(snapshot, options)
  const failing = new Set(gate.failures.map((finding) => finding.id))
  const skipped = report.findings.filter((finding) =>
    finding.status === "candidate" || finding.status === "validating" || finding.status === "inconclusive")

  const cases: string[] = []
  for (const finding of report.findings) {
    const name = `${finding.id} ${finding.title}`
    const body = failing.has(finding.id)
      ? `      <failure message="${escapeXml(`${finding.severity} confirmed on ${finding.asset}`)}" type="${escapeXml(finding.severity)}">`
        + `${escapeXml(detail(finding))}</failure>\n`
      : finding.status === "confirmed" || finding.status === "rejected"
        ? ""
        : `      <skipped message="${escapeXml(`${finding.status}: ${finding.summary}`)}"/>\n`
    cases.push(
      `    <testcase classname="${escapeXml(finding.skillId ?? "cyrion")}" name="${escapeXml(name)}">\n`
      + body
      + "    </testcase>",
    )
  }

  // The run itself is a test: an engagement that failed or was cancelled must
  // not look like a clean pipeline.
  cases.push(
    `    <testcase classname="cyrion" name="engagement ${escapeXml(report.engagement.id)} completed">\n`
    + (report.engagement.status === "completed"
      ? ""
      : `      <failure message="${escapeXml(`engagement ended as ${report.engagement.status}`)}"/>\n`)
    + "    </testcase>",
    `    <testcase classname="cyrion" name="no scope or policy refusals">\n`
    + (report.summary.refusals === 0
      ? ""
      : `      <failure message="${escapeXml(`${report.summary.refusals} refusal(s) recorded`)}"/>\n`)
    + "    </testcase>",
  )

  const failures = gate.failures.length
    + (report.engagement.status === "completed" ? 0 : 1)
    + (report.summary.refusals === 0 ? 0 : 1)
  const seconds = ((report.engagement.elapsedMs ?? 0) / 1_000).toFixed(3)

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="cyrion" tests="${cases.length}" failures="${failures}" skipped="${skipped.length}" time="${seconds}">`,
    `  <testsuite name="${escapeXml(report.engagement.name)}" tests="${cases.length}" failures="${failures}"`
      + ` skipped="${skipped.length}" time="${seconds}"`
      + `${report.engagement.finishedAt ? ` timestamp="${escapeXml(report.engagement.finishedAt)}"` : ""}>`,
    "    <properties>",
    `      <property name="scopeHash" value="${escapeXml(report.scope.hash)}"/>`,
    `      <property name="failOn" value="${escapeXml(gate.failOn)}"/>`,
    `      <property name="confirmed" value="${report.summary.confirmed}"/>`,
    `      <property name="reproduced" value="${report.summary.reproduced}"/>`,
    ...(report.environment.sandbox
      ? [`      <property name="sandbox" value="${escapeXml(report.environment.sandbox)}"/>`]
      : []),
    "    </properties>",
    ...cases,
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n")
}

function detail(finding: Finding): string {
  return [
    finding.summary,
    `Asset: ${finding.asset}`,
    `Methodology: ${finding.skillId ?? "not recorded"}`,
    `Validated by: ${finding.validatedBy ?? "not independently validated"}`,
    `Reproduction: ${finding.reproduction?.verdict ?? "not attempted"}`,
    `Evidence: ${finding.evidenceIds.join(", ") || "none"}`,
  ].join("\n")
}
