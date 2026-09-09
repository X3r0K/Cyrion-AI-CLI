import type { ToolExecutionRequest, ToolProgress } from "@cyrion/contracts"
import { evaluateScope, parseTarget } from "@cyrion/scope"
import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "./types"

/**
 * The tools an operator would reach for by hand, as typed capabilities.
 *
 * Each of these has a shell equivalent an agent could run through `shell.exec`,
 * and that is deliberately still true. What an adapter adds is a parsed answer
 * instead of a wall of output, a bounded run instead of one that discovers a
 * whole subnet, and a summary a worker can reason about without spending its
 * context on a banner. The scope check is here too, so pointing one of these
 * somewhere the manifest never approved fails before the process starts.
 */

/** Content discovery. Bounded so a fuzz is a fuzz and not a denial of service. */
export const webFuzz: CapabilityAdapter = {
  capability: "web.fuzz",
  binary: "ffuf",

  async execute(
    request: ToolExecutionRequest,
    context: CapabilityContext,
    signal: AbortSignal,
    progress?: ToolProgress,
  ): Promise<CapabilityResult> {
    const decision = evaluateScope(context.scope, request.target)
    if (!decision.allowed) throw new Error(`web.fuzz refused: ${decision.reason}`)
    const target = parseTarget(request.target)
    if (target.kind !== "url") throw new Error("web.fuzz needs a url target")

    const wordlist = readString(request.input, "wordlist") ?? "/usr/share/wordlists/dirb/common.txt"
    const rate = clamp(readNumber(request.input, "rate") ?? 20, 1, 100)
    const base = request.target.replace(/\/+$/, "")

    const result = await context.runner.run({
      argv: [
        "ffuf",
        "-u", `${base}/FUZZ`,
        "-w", wordlist,
        "-rate", String(rate),      // requests per second, capped above
        "-t", "10",                 // concurrency, well under a stress test
        "-timeout", "10",
        "-mc", "200,201,202,204,301,302,307,401,403,405",
        "-of", "json",
        "-o", "/dev/stdout",
        "-s",
      ],
      timeoutMs: Math.min(request.timeoutMs, 600_000),
      maxOutputBytes: Math.min(request.maxOutputBytes, 4_000_000),
      ...(progress ? { onOutput: (chunk: string) => progress(firstLine(chunk)) } : {}),
    }, signal)

    if (result.timedOut) throw new Error(`web.fuzz timed out after ${request.timeoutMs}ms`)
    const hits = parseFfuf(result.stdout)
    const evidence = await context.evidence.capture({
      engagementId: request.engagementId,
      id: context.nextEvidenceId("E"),
      kind: "log",
      content: `${result.argv.join(" ")}\n\n${result.stdout}`,
      contentType: "application/json",
      source: request.agentId,
    })

    return {
      summary: {
        target: base,
        wordlist,
        hits: hits.length,
        // Discovered paths are a report about the target, not permission to
        // reach them: the controller holds every one to the manifest.
        found: hits.slice(0, 200),
        truncated: result.truncated,
        durationMs: result.durationMs,
        runner: result.runner,
      },
      evidence: [evidence],
      outcome: `${hits.length} path(s) answered under ${base}`,
    }
  },
}

/** Template-driven checks. The templates are the methodology, so they are named. */
export const vulnScan: CapabilityAdapter = {
  capability: "vuln.scan",
  binary: "nuclei",

  async execute(
    request: ToolExecutionRequest,
    context: CapabilityContext,
    signal: AbortSignal,
    progress?: ToolProgress,
  ): Promise<CapabilityResult> {
    const decision = evaluateScope(context.scope, request.target)
    if (!decision.allowed) throw new Error(`vuln.scan refused: ${decision.reason}`)

    const severity = readString(request.input, "severity") ?? "low,medium,high,critical"
    if (!/^[a-z,]+$/.test(severity)) throw new Error("vuln.scan severity must be a comma-separated list")
    const tags = readString(request.input, "tags")
    if (tags && !/^[a-z0-9,_-]+$/i.test(tags)) throw new Error("vuln.scan tags must be alphanumeric")

    const result = await context.runner.run({
      argv: [
        "nuclei",
        "-target", request.target,
        "-severity", severity,
        ...(tags ? ["-tags", tags] : []),
        "-rate-limit", "50",
        "-timeout", "10",
        "-jsonl",
        "-silent",
        "-no-interactsh",   // no out-of-band callbacks: nothing leaves for a third party
        "-disable-update-check",
      ],
      timeoutMs: Math.min(request.timeoutMs, 900_000),
      maxOutputBytes: Math.min(request.maxOutputBytes, 4_000_000),
      ...(progress ? { onOutput: (chunk: string) => progress(firstLine(chunk)) } : {}),
    }, signal)

    if (result.timedOut) throw new Error(`vuln.scan timed out after ${request.timeoutMs}ms`)
    const findings = parseNuclei(result.stdout)
    const evidence = await context.evidence.capture({
      engagementId: request.engagementId,
      id: context.nextEvidenceId("E"),
      kind: "log",
      content: `${result.argv.join(" ")}\n\n${result.stdout}`,
      contentType: "application/x-ndjson",
      source: request.agentId,
    })

    return {
      summary: {
        target: request.target,
        severity,
        ...(tags ? { tags } : {}),
        matched: findings.length,
        // A template match is a candidate. Confirming it is the validator's
        // job, the same as for anything a skill raised.
        findings: findings.slice(0, 100),
        truncated: result.truncated,
        durationMs: result.durationMs,
        runner: result.runner,
      },
      evidence: [evidence],
      outcome: `${findings.length} template(s) matched on ${request.target}`,
    }
  },
}

/** Injection testing against one approved URL. */
export const sqliTest: CapabilityAdapter = {
  capability: "sqli.test",
  binary: "sqlmap",

  async execute(
    request: ToolExecutionRequest,
    context: CapabilityContext,
    signal: AbortSignal,
    progress?: ToolProgress,
  ): Promise<CapabilityResult> {
    const decision = evaluateScope(context.scope, request.target)
    if (!decision.allowed) throw new Error(`sqli.test refused: ${decision.reason}`)
    const target = parseTarget(request.target)
    if (target.kind !== "url") throw new Error("sqli.test needs a url target")

    const level = clamp(readNumber(request.input, "level") ?? 1, 1, 5)
    const risk = clamp(readNumber(request.input, "risk") ?? 1, 1, 3)
    const data = readString(request.input, "data")

    const result = await context.runner.run({
      argv: [
        "sqlmap",
        "-u", request.target,
        ...(data ? ["--data", data] : []),
        "--level", String(level),
        "--risk", String(risk),
        "--batch",                  // never prompt: there is no operator at this keyboard
        "--disable-coloring",
        "--answers=quit=N,crack=N",
        "--timeout", "15",
        "--retries", "1",
        "--threads", "4",
      ],
      timeoutMs: Math.min(request.timeoutMs, 900_000),
      maxOutputBytes: Math.min(request.maxOutputBytes, 4_000_000),
      ...(progress ? { onOutput: (chunk: string) => progress(firstLine(chunk)) } : {}),
    }, signal)

    if (result.timedOut) throw new Error(`sqli.test timed out after ${request.timeoutMs}ms`)
    const injectable = /is vulnerable|sqlmap identified the following injection point/i.test(result.stdout)
    const evidence = await context.evidence.capture({
      engagementId: request.engagementId,
      id: context.nextEvidenceId("E"),
      kind: "log",
      content: `${result.argv.join(" ")}\n\n${result.stdout}\n${result.stderr}`,
      contentType: "text/plain",
      source: request.agentId,
    })

    return {
      summary: {
        target: request.target,
        level,
        risk,
        injectable,
        techniques: parseSqlmapTechniques(result.stdout),
        exitCode: result.exitCode,
        truncated: result.truncated,
        durationMs: result.durationMs,
        runner: result.runner,
      },
      evidence: [evidence],
      outcome: injectable ? `injection point identified on ${request.target}` : "no injection point identified",
    }
  },
}

export interface FuzzHit {
  path: string
  status: number
  length: number
}

/** ffuf's JSON report, tolerant of the banner some builds print first. */
export function parseFfuf(output: string): FuzzHit[] {
  const start = output.indexOf("{")
  if (start < 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(output.slice(start))
  } catch {
    return []
  }
  const results = (parsed as { results?: unknown }).results
  if (!Array.isArray(results)) return []
  const hits: FuzzHit[] = []
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue
    const row = entry as Record<string, unknown>
    const path = typeof row.input === "object" && row.input
      ? String((row.input as Record<string, unknown>).FUZZ ?? "")
      : ""
    if (!path) continue
    hits.push({
      path: path.slice(0, 512),
      status: typeof row.status === "number" ? row.status : 0,
      length: typeof row.length === "number" ? row.length : 0,
    })
  }
  return hits
}

export interface TemplateMatch {
  templateId: string
  name: string
  severity: string
  matchedAt: string
}

/** nuclei's JSONL, one object per line, ignoring anything that is not one. */
export function parseNuclei(output: string): TemplateMatch[] {
  const matches: TemplateMatch[] = []
  for (const line of output.split("\n")) {
    const clean = line.trim()
    if (!clean.startsWith("{")) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(clean) as Record<string, unknown>
    } catch {
      continue
    }
    const info = (row.info ?? {}) as Record<string, unknown>
    matches.push({
      templateId: String(row["template-id"] ?? row.templateID ?? "").slice(0, 200),
      name: String(info.name ?? "").slice(0, 200),
      severity: String(info.severity ?? "unknown").slice(0, 32),
      matchedAt: String(row["matched-at"] ?? row.host ?? "").slice(0, 512),
    })
  }
  return matches
}

/** Which techniques sqlmap says worked, from its own summary lines. */
export function parseSqlmapTechniques(output: string): string[] {
  const found = new Set<string>()
  for (const line of output.split("\n")) {
    const match = /^\s*Type:\s*(.+)$/.exec(line)
    if (match?.[1]) found.add(match[1].trim().slice(0, 80))
  }
  return [...found].slice(0, 16)
}

function readString(input: unknown, field: string): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const value = (input as Record<string, unknown>)[field]
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 1_024) : undefined
}

function readNumber(input: unknown, field: string): number | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const value = (input as Record<string, unknown>)[field]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Math.round(value)))
}

function firstLine(chunk: string): string {
  return chunk.split("\n").find((line) => line.trim())?.trim().slice(0, 160) ?? ""
}
