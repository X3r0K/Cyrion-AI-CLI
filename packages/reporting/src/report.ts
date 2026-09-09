import type {
  EngagementBudgets,
  EngagementLimits,
  EngagementSnapshot,
  Finding,
  FindingReproduction,
  ResourceUsage,
  Severity,
} from "@cyrion/contracts"
import { DEFAULT_ENGAGEMENT_LIMITS } from "@cyrion/contracts"
import { scopeHash } from "@cyrion/scope"


export const REPORT_VERSION = "cyrion.community/report-v2" as const

export const severities: readonly Severity[] = ["critical", "high", "medium", "low", "info"]

/**
 * What the engagement record cannot know about itself.
 *
 * Models, tool versions, the sandbox, and the operator's attestation are facts
 * about the run rather than about its findings. The caller supplies them; the
 * report never invents them, and says "not recorded" when they are absent.
 */
export interface ReportContext {
  attestation?: string
  sandbox?: string
  runtime?: { planner: string; workers: string }
  models?: Array<{ role: string; endpoint: string; model: string }>
  tools?: Array<{ name: string; version: string }>
  /** The corpus a worker was allowed to consult, and how it was searched. */
  knowledge?: KnowledgeRecord
}

/**
 * Which knowledge base produced this report.
 *
 * The corpus version is a digest over the ingested documents, so two reports
 * citing the same version cited the same text. Without it "we consulted the
 * standard" names nothing a reader can check.
 */
export interface KnowledgeRecord {
  corpusVersion: string
  documents: number
  chunks: number
  retrieval: "lexical" | "hybrid"
  sources: Array<{ id: string; license: string; documents: number }>
  embeddingModel?: string
}

export interface ReportValidation {
  findingId: string
  title: string
  status: Finding["status"]
  severity: Severity
  validatedBy?: string
  reproduction?: FindingReproduction
}

export interface CommunityReport {
  version: typeof REPORT_VERSION
  generatedAt: string
  engagement: {
    id: string
    name: string
    objective: string
    status: EngagementSnapshot["status"]
    profile: string
    mode: string
    startedAt?: string
    finishedAt?: string
    elapsedMs?: number
  }
  scope: {
    hash: string
    targets: string[]
    excluded: string[]
    capabilities: string[]
    /** Operator authorization bound to this exact scope, when a lock was used. */
    attestation?: string
  }
  /** Skills that produced the tasks in this engagement, in the order they ran. */
  methodology: string[]
  summary: {
    tasks: number
    completedTasks: number
    confirmed: number
    /** Confirmed findings an independent replay reproduced, counted apart. */
    reproduced: number
    rejected: number
    inconclusive: number
    unresolved: number
    artifacts: number
    /** Scope, policy, and evidence refusals recorded during the run. Should be zero. */
    refusals: number
  }
  severities: Record<Severity, number>
  budgets: {
    granted: EngagementBudgets
    consumed: ResourceUsage
  }
  /**
   * What one host was held to, whoever was asking.
   *
   * Stated because a client reading this report is entitled to know how hard
   * their machine was pushed, and because a run that found nothing under a very
   * slow pace is a different result from one that found nothing at full speed.
   */
  limits: EngagementLimits
  findings: Finding[]
  validations: ReportValidation[]
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
  environment: {
    sandbox?: string
    runtime?: { planner: string; workers: string }
    models?: Array<{ role: string; endpoint: string; model: string }>
    tools?: Array<{ name: string; version: string }>
    knowledge?: KnowledgeRecord
  }
  limitations: string[]
}

export function buildCommunityReport(snapshot: EngagementSnapshot, context: ReportContext = {}): CommunityReport {
  const confirmed = snapshot.findings.filter((finding) => finding.status === "confirmed")
  const started = snapshot.startedAt ? Date.parse(snapshot.startedAt) : undefined
  const finished = snapshot.finishedAt ? Date.parse(snapshot.finishedAt) : undefined

  return {
    version: REPORT_VERSION,
    generatedAt: snapshot.finishedAt ?? snapshot.startedAt ?? new Date(0).toISOString(),
    engagement: {
      id: snapshot.manifest.id,
      name: snapshot.manifest.name,
      objective: snapshot.manifest.objective,
      status: snapshot.status,
      profile: snapshot.manifest.profile,
      mode: snapshot.manifest.mode,
      ...(snapshot.startedAt ? { startedAt: snapshot.startedAt } : {}),
      ...(snapshot.finishedAt ? { finishedAt: snapshot.finishedAt } : {}),
      ...(started !== undefined && finished !== undefined ? { elapsedMs: Math.max(0, finished - started) } : {}),
    },
    scope: {
      hash: scopeHash(snapshot.manifest.scope),
      targets: [...snapshot.manifest.scope.targets],
      excluded: [...snapshot.manifest.scope.excluded],
      capabilities: [...snapshot.manifest.scope.capabilities],
      ...(context.attestation ? { attestation: context.attestation } : {}),
    },
    methodology: [...new Set(snapshot.tasks.map((task) => task.skillId).filter((id): id is string => !!id))],
    summary: {
      tasks: snapshot.tasks.length,
      completedTasks: snapshot.tasks.filter((task) => task.status === "completed").length,
      confirmed: confirmed.length,
      reproduced: confirmed.filter((finding) => finding.reproduction?.verdict === "reproduced").length,
      rejected: count(snapshot, "rejected"),
      inconclusive: count(snapshot, "inconclusive"),
      unresolved: snapshot.findings.filter((finding) =>
        finding.status === "candidate" || finding.status === "validating" || finding.status === "inconclusive"
      ).length,
      artifacts: snapshot.evidence.length,
      refusals: snapshot.events.filter((event) =>
        event.type === "tool.request.rejected"
        || event.type === "root.decision.rejected"
        || event.type === "task.result.rejected").length,
    },
    severities: Object.fromEntries(
      severities.map((severity) => [severity, confirmed.filter((finding) => finding.severity === severity).length]),
    ) as Record<Severity, number>,
    budgets: {
      granted: structuredClone(snapshot.manifest.budgets),
      consumed: structuredClone(snapshot.usage),
    },
    limits: structuredClone(snapshot.manifest.limits ?? DEFAULT_ENGAGEMENT_LIMITS),
    findings: structuredClone(snapshot.findings),
    validations: snapshot.findings
      .filter((finding) => finding.validatedBy || finding.reproduction)
      .map((finding) => ({
        findingId: finding.id,
        title: finding.title,
        status: finding.status,
        severity: finding.severity,
        ...(finding.validatedBy ? { validatedBy: finding.validatedBy } : {}),
        ...(finding.reproduction ? { reproduction: structuredClone(finding.reproduction) } : {}),
      })),
    evidence: structuredClone(snapshot.evidence),
    environment: {
      ...(context.sandbox ? { sandbox: context.sandbox } : {}),
      ...(context.runtime ? { runtime: { ...context.runtime } } : {}),
      ...(context.models?.length ? { models: context.models.map((entry) => ({ ...entry })) } : {}),
      ...(context.tools?.length ? { tools: context.tools.map((entry) => ({ ...entry })) } : {}),
      ...(context.knowledge
        ? { knowledge: { ...context.knowledge, sources: context.knowledge.sources.map((entry) => ({ ...entry })) } }
        : {}),
    },
    limitations: limitationsFor(snapshot, context),
  }
}

/**
 * What this report does not establish.
 *
 * Derived rather than fixed, because a fixture run and a live assessment are
 * limited by different things and a reader deserves to be told which one they
 * are holding.
 */
function limitationsFor(snapshot: EngagementSnapshot, context: ReportContext): string[] {
  const fixture = snapshot.evidence.some((evidence) => evidence.kind === "fixture")
  const confirmed = snapshot.findings.filter((finding) => finding.status === "confirmed")
  const unproven = confirmed.filter((finding) => finding.reproduction?.verdict !== "reproduced").length
  const lines = [
    fixture
      ? "This run used deterministic fixture workers and did not perform a live network assessment."
      : "Coverage is bounded by the capabilities the manifest granted and the skills that were loaded; "
        + "an issue outside them is absent from this report, not absent from the target.",
    "Only independently validated records marked confirmed should be treated as confirmed findings.",
    "Reproducibility is recorded separately from severity."
      + (unproven
        ? ` ${unproven} of ${confirmed.length} confirmed finding(s) carry no proof bundle and rest on the`
          + " validator's own observation rather than a replayable reproduction."
        : confirmed.length
          ? " Every confirmed finding carries a proof bundle that replays from its own record."
          : ""),
    "Artifact references identify local evidence; artifact contents are intentionally omitted from this report export.",
  ]

  // Correlated model error is a real failure mode, and disclosing it is cheaper
  // than being caught by it.
  const models = context.models ?? []
  const discovery = models.find((entry) => entry.role === "worker" || entry.role === "planner")
  const validator = models.find((entry) => entry.role === "validator")
  if (discovery && validator && discovery.model === validator.model) {
    lines.push(
      `Discovery and validation both used ${validator.model}. A model that is wrong in one session `
      + "tends to be wrong the same way in the next, so agreement between them is weaker evidence than "
      + "agreement between two different models.",
    )
  }
  if (context.knowledge) {
    const { knowledge } = context
    lines.push(
      `Workers could consult corpus ${knowledge.corpusVersion} (${knowledge.documents} document(s), `
      + `${knowledge.retrieval} retrieval). Retrieved text informed which checks were run; it is never `
      + "evidence for a finding, and a claim rests only on what the target returned.",
    )
  }
  if (!context.attestation) {
    lines.push("No operator attestation was bound to this run; the scope hash above is the only authorization record.")
  }
  return lines
}

function count(snapshot: EngagementSnapshot, status: Finding["status"]): number {
  return snapshot.findings.filter((finding) => finding.status === status).length
}

/** Severity ordering for gates: a threshold admits everything at or above it. */
export function atOrAbove(threshold: Severity): Severity[] {
  return severities.slice(0, severities.indexOf(threshold) + 1)
}
