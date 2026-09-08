import type { EngagementSnapshot, Finding, Severity } from "@cyrion/contracts"
import { buildCommunityReport, type CommunityReport, type ReportContext } from "./report"

export const SARIF_SCHEMA = "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json"

/**
 * SARIF 2.1.0, for GitHub and GitLab code scanning.
 *
 * Status is carried by `kind` and severity by `level`, so a rejected candidate
 * appears as a passing result rather than silently disappearing: a reader of
 * the alert list should be able to see that Cyrion looked and found nothing,
 * which is a different statement from never having looked.
 */
export function renderSarifReport(snapshot: EngagementSnapshot, context: ReportContext = {}): string {
  const report = buildCommunityReport(snapshot, context)
  const rules = ruleIndex(report)

  return `${JSON.stringify({
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: "Cyrion Community",
          informationUri: "https://github.com/X3r0K/Cyrion-AI-CLI",
          rules: [...rules.values()],
        },
      },
      automationDetails: {
        id: `cyrion/${report.engagement.id}`,
        description: { text: report.engagement.objective },
      },
      invocations: [{
        executionSuccessful: report.engagement.status === "completed",
        ...(report.engagement.startedAt ? { startTimeUtc: report.engagement.startedAt } : {}),
        ...(report.engagement.finishedAt ? { endTimeUtc: report.engagement.finishedAt } : {}),
        properties: {
          scopeHash: report.scope.hash,
          ...(report.scope.attestation ? { attestation: report.scope.attestation } : {}),
          ...(report.environment.sandbox ? { sandbox: report.environment.sandbox } : {}),
          refusals: report.summary.refusals,
        },
      }],
      results: report.findings.map((finding) => result(finding, rules.has(ruleId(finding)) ? ruleId(finding) : undefined)),
      properties: {
        methodology: report.methodology,
        limitations: report.limitations,
      },
    }],
  }, null, 2)}\n`
}

/** One rule per methodology unit, so an alert links back to how it was produced. */
function ruleIndex(report: CommunityReport): Map<string, object> {
  const rules = new Map<string, object>()
  for (const finding of report.findings) {
    const id = ruleId(finding)
    if (rules.has(id)) continue
    rules.set(id, {
      id,
      name: finding.skillId ?? "finding",
      shortDescription: { text: finding.title },
      fullDescription: {
        text: finding.skillId
          ? `Produced by the ${finding.skillId} methodology. Findings are confirmed only by an independent `
            + "reproduction recorded separately from severity."
          : "Produced without a recorded methodology.",
      },
      defaultConfiguration: { level: level(finding.severity) },
      properties: { "security-severity": securitySeverity(finding.severity) },
    })
  }
  return rules
}

function ruleId(finding: Finding): string {
  return `cyrion/${finding.skillId ?? "finding"}`
}

function result(finding: Finding, rule: string | undefined): object {
  return {
    ...(rule ? { ruleId: rule } : {}),
    kind: kind(finding.status),
    level: finding.status === "confirmed" ? level(finding.severity) : "none",
    message: { text: `${finding.title}. ${finding.summary}` },
    locations: [{
      physicalLocation: {
        artifactLocation: { uri: finding.asset },
      },
    }],
    partialFingerprints: { cyrionFindingId: finding.id },
    properties: {
      status: finding.status,
      severity: finding.severity,
      discoveredBy: finding.discoveredBy,
      ...(finding.validatedBy ? { validatedBy: finding.validatedBy } : {}),
      ...(finding.skillId ? { skillId: finding.skillId } : {}),
      reproduction: finding.reproduction?.verdict ?? "not-attempted",
      ...(finding.reproduction ? { reproductionBundle: finding.reproduction.bundleId } : {}),
      evidence: finding.evidenceIds,
    },
  }
}

/**
 * SARIF result kinds carry Cyrion's verdicts without flattening them: a
 * candidate is open, an inconclusive verdict needs review, and one the target
 * refused to reproduce passed.
 */
function kind(status: Finding["status"]): string {
  if (status === "confirmed") return "fail"
  if (status === "rejected") return "pass"
  if (status === "inconclusive") return "review"
  return "open"
}

function level(severity: Severity): string {
  if (severity === "critical" || severity === "high") return "error"
  if (severity === "medium") return "warning"
  return "note"
}

/** GitHub reads this numeric band when it sorts alerts. */
function securitySeverity(severity: Severity): string {
  const scores: Record<Severity, string> = {
    critical: "9.5",
    high: "7.5",
    medium: "5.0",
    low: "3.0",
    info: "1.0",
  }
  return scores[severity]
}
