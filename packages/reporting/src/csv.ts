import type { EngagementSnapshot } from "@cyrion/contracts"
import { buildCommunityReport, type ReportContext } from "./report"
import { csvRow } from "./text"

const columns = [
  "id",
  "title",
  "asset",
  "severity",
  "status",
  "reproduction",
  "bundle",
  "methodology",
  "discoveredBy",
  "validatedBy",
  "evidence",
  "summary",
] as const

/**
 * Findings as CSV, for import into a tracker.
 *
 * Reproduction is its own column rather than folded into status, so a filter
 * for "confirmed" and a filter for "actually replayed" stay different filters.
 */
export function renderCsvReport(snapshot: EngagementSnapshot, context: ReportContext = {}): string {
  const report = buildCommunityReport(snapshot, context)
  const rows = [csvRow(columns)]
  for (const finding of report.findings) {
    rows.push(csvRow([
      finding.id,
      finding.title,
      finding.asset,
      finding.severity,
      finding.status,
      finding.reproduction?.verdict ?? "not-attempted",
      finding.reproduction?.bundleId ?? "",
      finding.skillId ?? "",
      finding.discoveredBy,
      finding.validatedBy ?? "",
      finding.evidenceIds.join(" "),
      finding.summary,
    ]))
  }
  return `${rows.join("\r\n")}\r\n`
}
