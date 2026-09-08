import type { EngagementSnapshot, Finding, Severity } from "@cyrion/contracts"
import { buildCommunityReport, severities, type CommunityReport, type ReportContext } from "./report"
import { escapeHtml } from "./text"
import { reproductionText } from "./markdown"

/**
 * A self-contained HTML report: one file, no network, printable to PDF.
 *
 * Everything a reader needs is inline — no fonts, scripts, or stylesheets are
 * fetched — because a report that phones home when opened is not a report an
 * assessor can hand to a client. Artifact bodies stay out; digests go in.
 */
export function renderHtmlReport(snapshot: EngagementSnapshot, context: ReportContext = {}): string {
  const report = buildCommunityReport(snapshot, context)
  const title = `${report.engagement.name} — assessment report`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${styles()}</style>
</head>
<body>
<header>
  <h1>${escapeHtml(report.engagement.name)}</h1>
  <p class="sub">Assessment report · <code>${escapeHtml(report.version)}</code> · generated ${escapeHtml(report.generatedAt)}</p>
  <p class="sub">Engagement <code>${escapeHtml(report.engagement.id)}</code> ·
    <span class="pill ${report.engagement.status === "completed" ? "ok" : "warn"}">${escapeHtml(report.engagement.status.toUpperCase())}</span> ·
    ${escapeHtml(report.engagement.profile)} / ${escapeHtml(report.engagement.mode)}</p>
</header>

<section>
  <h2>Outcome</h2>
  <div class="tiles">
    ${tile("Confirmed", report.summary.confirmed, report.summary.confirmed ? "bad" : "ok")}
    ${tile("Reproduced", report.summary.reproduced, "neutral")}
    ${tile("Rejected", report.summary.rejected, "neutral")}
    ${tile("Unresolved", report.summary.unresolved, report.summary.unresolved ? "warn" : "ok")}
    ${tile("Artifacts", report.summary.artifacts, "neutral")}
    ${tile("Refusals", report.summary.refusals, report.summary.refusals ? "bad" : "ok")}
  </div>
  <p class="sub">Confirmed by severity: ${severities
    .map((severity) => `<span class="sev ${severity}">${escapeHtml(severity)} ${report.severities[severity]}</span>`)
    .join(" ")}</p>
</section>

<section>
  <h2>Authorization and scope</h2>
  <dl>
    <dt>Scope hash</dt><dd><code>${escapeHtml(report.scope.hash)}</code></dd>
    <dt>Attestation</dt><dd>${report.scope.attestation
      ? escapeHtml(report.scope.attestation)
      : '<span class="warn-text">none supplied</span>'}</dd>
    <dt>Targets</dt><dd>${codeList(report.scope.targets)}</dd>
    <dt>Excluded</dt><dd>${codeList(report.scope.excluded)}</dd>
    <dt>Capabilities</dt><dd>${codeList(report.scope.capabilities)}</dd>
    <dt>Methodology</dt><dd>${codeList(report.methodology)}</dd>
  </dl>
  <h3>Objective</h3>
  <p>${escapeHtml(report.engagement.objective)}</p>
</section>

<section>
  <h2>Environment</h2>
  <dl>
    <dt>Sandbox</dt><dd>${escapeHtml(report.environment.sandbox ?? "not recorded")}</dd>
    <dt>Root planner</dt><dd>${escapeHtml(report.environment.runtime?.planner ?? "not recorded")}</dd>
    <dt>Worker review</dt><dd>${escapeHtml(report.environment.runtime?.workers ?? "not recorded")}</dd>
    <dt>Tokens</dt><dd>${report.budgets.consumed.inputTokens + report.budgets.consumed.outputTokens}
      of ${report.budgets.granted.maxTokens}</dd>
    <dt>Cost</dt><dd>${report.budgets.consumed.costUsd} of ${report.budgets.granted.maxCostUsd} USD</dd>
  </dl>
  ${report.environment.models?.length
    ? table(["Role", "Endpoint", "Model"], report.environment.models.map((entry) => [entry.role, entry.endpoint, entry.model]))
    : ""}
  ${report.environment.tools?.length
    ? table(["Tool", "Version"], report.environment.tools.map((tool) => [tool.name, tool.version]))
    : ""}
</section>

<section>
  <h2>Findings</h2>
  ${report.findings.length ? report.findings.map(findingCard).join("\n") : "<p>No candidate or confirmed findings were recorded.</p>"}
</section>

<section>
  <h2>Validation records</h2>
  ${report.validations.length
    ? table(
      ["Finding", "Verdict", "Validator", "Reproduction"],
      report.validations.map((record) => [
        record.findingId,
        record.status,
        record.validatedBy ?? "none",
        record.reproduction ? `${record.reproduction.verdict} (${record.reproduction.bundleId})` : "no bundle",
      ]),
    )
    : "<p>No finding reached independent validation.</p>"}
</section>

<section>
  <h2>Evidence index</h2>
  <p class="sub">Artifact contents are deliberately omitted; each row identifies a local artifact and its digest.</p>
  ${table(
    ["ID", "Kind", "Source", "Bytes", "SHA-256", "URI"],
    report.evidence.map((evidence) => [
      evidence.id,
      evidence.kind,
      evidence.source ?? "unknown",
      String(evidence.sizeBytes ?? "unknown"),
      evidence.sha256,
      evidence.uri,
    ]),
  )}
</section>

<section>
  <h2>Limitations and coverage gaps</h2>
  <ul>${report.limitations.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
</section>

<footer>Generated by Cyrion Community. Only assess systems you are authorized to test.</footer>
</body>
</html>
`
}

function findingCard(finding: Finding): string {
  return `  <article class="finding ${escapeHtml(finding.status)}">
    <h3><span class="sev ${escapeHtml(finding.severity)}">${escapeHtml(finding.severity)}</span>
      <code>${escapeHtml(finding.id)}</code> ${escapeHtml(finding.title)}</h3>
    <p class="status">${escapeHtml(finding.status.toUpperCase())} · <code>${escapeHtml(finding.asset)}</code></p>
    <p>${escapeHtml(finding.summary)}</p>
    <dl>
      <dt>Discovered by</dt><dd><code>${escapeHtml(finding.discoveredBy)}</code></dd>
      <dt>Validated by</dt><dd>${finding.validatedBy
        ? `<code>${escapeHtml(finding.validatedBy)}</code>`
        : "not independently validated"}</dd>
      <dt>Methodology</dt><dd>${finding.skillId ? `<code>${escapeHtml(finding.skillId)}</code>` : "not recorded"}</dd>
      <dt>Reproduction</dt><dd>${escapeHtml(stripMarkdown(reproductionText(finding)))}</dd>
      <dt>Evidence</dt><dd>${codeList(finding.evidenceIds)}</dd>
    </dl>
  </article>`
}

/** The Markdown renderer's phrasing, without its backticks. */
function stripMarkdown(value: string): string {
  return value.replaceAll("`", "")
}

function tile(label: string, value: number, tone: string): string {
  return `<div class="tile ${tone}"><span class="value">${value}</span><span class="label">${escapeHtml(label)}</span></div>`
}

function codeList(values: readonly string[]): string {
  return values.length
    ? values.map((value) => `<code>${escapeHtml(value)}</code>`).join(" ")
    : "none"
}

function table(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  if (!rows.length) return "<p>none</p>"
  return `<table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>`
    + `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
}

function styles(): string {
  return `
:root { color-scheme: light dark; --bg:#ffffff; --fg:#16181d; --muted:#5b6070; --line:#dfe2ea; --panel:#f7f8fa; --accent:#1c6dd0; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0f1115; --fg:#e6e8ee; --muted:#98a0b3; --line:#262a33; --panel:#151922; --accent:#5aa2ff; }
}
* { box-sizing: border-box; }
body { margin:0 auto; max-width:60rem; padding:2rem 1.25rem 4rem; background:var(--bg); color:var(--fg);
  font:15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
h1 { font-size:1.7rem; margin:0 0 .25rem; }
h2 { font-size:1.15rem; margin:2.25rem 0 .75rem; padding-bottom:.35rem; border-bottom:1px solid var(--line); }
h3 { font-size:1rem; margin:1.25rem 0 .4rem; }
code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size:.86em;
  background:var(--panel); border:1px solid var(--line); border-radius:4px; padding:.05em .35em; overflow-wrap:anywhere; }
.sub { color:var(--muted); margin:.2rem 0; }
.pill { border-radius:999px; padding:.1em .6em; font-size:.8em; border:1px solid var(--line); }
.pill.ok { color:#0a7d38; } .pill.warn { color:#a05a00; }
.warn-text { color:#a05a00; }
.tiles { display:flex; flex-wrap:wrap; gap:.6rem; }
.tile { flex:1 1 7rem; border:1px solid var(--line); border-radius:8px; padding:.7rem .9rem; background:var(--panel); }
.tile .value { display:block; font-size:1.5rem; font-weight:650; }
.tile .label { color:var(--muted); font-size:.8rem; text-transform:uppercase; letter-spacing:.04em; }
.tile.bad .value { color:#c0392b; } .tile.ok .value { color:#0a7d38; } .tile.warn .value { color:#a05a00; }
.sev { border-radius:4px; padding:.05em .45em; font-size:.78em; text-transform:uppercase; letter-spacing:.03em;
  border:1px solid var(--line); }
.sev.critical, .sev.high { background:#c0392b; color:#fff; }
.sev.medium { background:#a05a00; color:#fff; }
.sev.low { background:#1c6dd0; color:#fff; }
.sev.info { background:var(--panel); color:var(--muted); }
dl { display:grid; grid-template-columns:11rem 1fr; gap:.3rem .9rem; margin:.6rem 0; }
dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
table { width:100%; border-collapse:collapse; margin:.6rem 0; font-size:.9rem; display:block; overflow-x:auto; }
th, td { text-align:left; border-bottom:1px solid var(--line); padding:.4rem .5rem; vertical-align:top;
  overflow-wrap:anywhere; }
th { color:var(--muted); font-weight:600; font-size:.8rem; text-transform:uppercase; letter-spacing:.04em; }
.finding { border:1px solid var(--line); border-left:4px solid var(--muted); border-radius:8px;
  padding:.9rem 1.1rem; margin:.9rem 0; background:var(--panel); }
.finding.confirmed { border-left-color:#c0392b; }
.finding.rejected { border-left-color:#0a7d38; }
.finding.inconclusive, .finding.candidate, .finding.validating { border-left-color:#a05a00; }
.finding .status { color:var(--muted); font-size:.85rem; margin:.1rem 0 .5rem; }
footer { margin-top:3rem; padding-top:1rem; border-top:1px solid var(--line); color:var(--muted); font-size:.85rem; }
@media print {
  body { max-width:none; padding:0; }
  .finding, .tile, table { break-inside:avoid; }
  h2 { break-after:avoid; }
}
`.trim()
}

export type { CommunityReport, Severity }
