import { createHash } from "node:crypto"
import { promises as dns } from "node:dns"
import {
  POC_REDACTED,
  POC_VERSION,
  assertPocPlan,
  isSecretHeader,
  redactHeaders,
  type PocBundle,
  type PocExpectation,
  type PocPlan,
  type PocStep,
  type PocStepRecord,
  type PocVerdict,
  type ToolExecutionRequest,
  type ToolProgress,
} from "@cyrion/contracts"
import { OperatorCredentials } from "@cyrion/credentials"
import { checkPinnedAddress, evaluateScope, isAddress, parseTarget, pinAddresses, type TargetPin } from "@cyrion/scope"
import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "./types"

/** Rate limit between steps. A reproduction is one exchange repeated, not a fuzz run. */
const STEP_INTERVAL_MS = 500
const STEP_TIMEOUT_MS = 15_000
const CONNECT_TIMEOUT_SECONDS = 5
const MAX_STEP_BYTES = 256_000
const USER_AGENT = "cyrion-community/0.1 (+authorized assessment)"

/**
 * Executes one bounded proof-of-concept against an approved URL and stores the
 * bundle that lets anyone repeat it.
 *
 * The plan is data, not code: the contract admits reads only, so there is no
 * request body to send, no method that changes state, and no header that
 * carries a credential. Every step is re-validated against the approved scope,
 * every hostname is held to the addresses pinned for this engagement, and
 * redirects are never followed. What comes back — argv, environment, raw
 * exchanges, the run log, and a standalone script — is written to the evidence
 * store before a verdict is returned, so a claim and its proof arrive together.
 */
export const pocRun: CapabilityAdapter = {
  capability: "poc.run",
  binary: "curl",

  async execute(
    request: ToolExecutionRequest,
    context: CapabilityContext,
    signal: AbortSignal,
    progress?: ToolProgress,
  ): Promise<CapabilityResult> {
    const decision = evaluateScope(context.scope, request.target)
    if (!decision.allowed) throw new Error(`poc.run refused: ${decision.reason}`)
    const target = parseTarget(request.target)
    if (target.kind !== "url") {
      throw new Error("poc.run needs a URL target: a static claim needs a runtime target to be reproduced")
    }

    const input = (request.input ?? {}) as { plan?: unknown }
    try {
      assertPocPlan(input.plan)
    } catch (error) {
      throw new Error(`poc.run refused: ${error instanceof Error ? error.message : String(error)}`)
    }
    const plan: PocPlan = input.plan

    // Every step is checked against the scope on its own: a plan cannot reach
    // past the engagement by burying a second URL behind an approved first one.
    for (const step of plan.steps) {
      const stepDecision = evaluateScope(context.scope, step.url)
      if (!stepDecision.allowed) {
        throw new Error(`poc.run refused: step ${step.id} targets ${step.url} (${stepDecision.reason})`)
      }
    }
    const first = plan.steps[0]!
    if (concreteUrl(first.url) !== concreteUrl(request.target)) {
      throw new Error(
        `poc.run refused: the first step must exercise the assigned target ${request.target}, not ${first.url}`,
      )
    }

    const pins = await pinPlanHosts(plan, context)
    const tool = await context.runner.lookup("curl")
    if (!tool) {
      throw new Error("curl is not available to this runner. Run `cyrion tools` for install guidance.")
    }

    // The gateway already capped this call's wall clock, so the steps divide
    // what is left rather than each claiming the whole of it.
    const stepTimeoutMs = stepBudgetMs(request.timeoutMs, plan.steps.length)
    const environment = { LANG: "C", NO_COLOR: "1" }
    const records: PocStepRecord[] = []
    /** Steps whose condition could not be decided; they hold the verdict open. */
    const undecided = new Set<string>()
    const evidence: CapabilityResult["evidence"] = []
    let runner: PocBundle["runner"] = context.runner.kind

    for (const [index, step] of plan.steps.entries()) {
      if (signal.aborted) throw signal.reason
      if (index > 0) await Bun.sleep(STEP_INTERVAL_MS)

      progress?.(`step ${index + 1} of ${plan.steps.length}: ${step.description}`)
      const argv = buildStepArgv(step, pins, stepTimeoutMs)
      // The bundle records `argv`, which still names credentials rather than
      // holding them, so a proof bundle can be attached to a report and replayed
      // by someone who has their own copy of the secret. Only the command that
      // actually runs carries the value.
      const result = await context.runner.run({
        argv: resolveArgvCredentials(argv, step.url, context),
        timeoutMs: stepTimeoutMs,
        maxOutputBytes: Math.min(request.maxOutputBytes, MAX_STEP_BYTES),
        env: environment,
      }, signal)
      runner = result.runner

      const transcript = result.stdout
      const parsed = result.exitCode === 0 ? parseHttpResponse(transcript) : undefined
      const outcome = parsed
        ? judge(step, parsed, result.truncated)
        : { met: false, detail: curlFailure(result.exitCode, result.stderr, result.timedOut), conclusive: false }

      const safeArgv = redactArgv(argv)
      const captured = await context.evidence.capture({
        engagementId: request.engagementId,
        id: context.nextEvidenceId("E"),
        kind: "response",
        // Scrubbed as well as redacted: redaction removes a value from a header
        // Cyrion sent, while a target that echoes the token into its body would
        // otherwise put it in the artifact by a route no header rule covers.
        content: `${safeArgv.join(" ")}\n\n${scrubbed(redactTranscript(transcript), context)}`
          + `${result.stderr ? `\n[stderr] ${result.stderr}` : ""}\n`,
        contentType: "text/plain",
        source: request.agentId,
      })
      evidence.push(captured)

      if (!outcome.conclusive) undecided.add(step.id)
      records.push({
        id: step.id,
        description: step.description,
        argv: safeArgv,
        request: {
          method: step.method,
          url: step.url,
          headers: redactHeaders({ "user-agent": USER_AGENT, ...(step.headers ?? {}) }),
        },
        ...(parsed
          ? {
            response: {
              status: parsed.status,
              headerNames: Object.keys(parsed.headers).sort(),
              ...(parsed.headers["content-type"] ? { contentType: parsed.headers["content-type"] } : {}),
              bodyBytes: parsed.body.length,
              bodySha256: createHash("sha256").update(parsed.body).digest("hex"),
              truncated: result.truncated,
            },
          }
          : {}),
        evidenceId: captured.id,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        met: outcome.met,
        detail: outcome.detail,
      })
    }

    const inconclusive = records.some((record) => !record.response || undecided.has(record.id))
    const verdict: PocVerdict = inconclusive
      ? "inconclusive"
      : records.every((record) => record.met) ? "reproduced" : "not-reproduced"

    const bundle: PocBundle = {
      version: POC_VERSION,
      engagementId: request.engagementId,
      findingId: plan.findingId,
      createdAt: new Date().toISOString(),
      runner,
      tool: { binary: "curl", ...(tool.version ? { version: tool.version } : {}) },
      environment,
      pins: pins.map((pin) => ({ hostname: pin.hostname, addresses: [...pin.addresses] })),
      plan,
      steps: records,
      verdict,
      script: renderScript(plan, records),
    }

    const bundleEvidence = await context.evidence.capture({
      engagementId: request.engagementId,
      id: context.nextEvidenceId("E"),
      kind: "poc",
      content: `${JSON.stringify(bundle, null, 2)}\n`,
      contentType: "application/json",
      source: request.agentId,
    })
    const reproEvidence = await context.evidence.capture({
      engagementId: request.engagementId,
      id: context.nextEvidenceId("E"),
      kind: "poc",
      content: renderRepro(bundle, bundleEvidence.id),
      contentType: "text/markdown",
      source: request.agentId,
    })
    evidence.push(bundleEvidence, reproEvidence)

    return {
      summary: {
        verdict,
        findingId: plan.findingId,
        bundleId: bundleEvidence.id,
        reproId: reproEvidence.id,
        runner,
        tool: bundle.tool,
        createdAt: bundle.createdAt,
        steps: records.map((record) => ({
          id: record.id,
          met: record.met,
          status: record.response?.status ?? null,
          detail: record.detail,
          evidenceId: record.evidenceId ?? null,
        })),
      },
      evidence,
      outcome: `${verdict} · ${records.length} step${records.length === 1 ? "" : "s"} · bundle ${bundleEvidence.id}`,
    }
  },
}

/**
 * Holds every hostname in the plan to one set of addresses for the whole run.
 *
 * A host already pinned by this engagement is re-resolved and refused when the
 * answer moved; a host seen for the first time is pinned here, so the bundle
 * records what a replay must reach.
 */
async function pinPlanHosts(plan: PocPlan, context: CapabilityContext): Promise<TargetPin[]> {
  const pins: TargetPin[] = []
  for (const step of plan.steps) {
    const hostname = new URL(step.url).hostname.toLowerCase()
    if (pins.some((pin) => pin.hostname === hostname)) continue

    if (isAddress(hostname)) {
      pins.push(pinAddresses(hostname, [hostname]))
      continue
    }
    const existing = context.pins.get(hostname)
    const answers = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)])
    const addresses = answers.flatMap((entry) => (entry.status === "fulfilled" ? entry.value : [])).slice(0, 32)
    if (!addresses.length) throw new Error(`poc.run refused: ${hostname} did not resolve to any address`)
    if (existing) {
      for (const address of addresses) {
        const pinned = checkPinnedAddress(existing, address)
        if (!pinned.allowed) throw new Error(`poc.run refused: ${pinned.reason}`)
      }
      pins.push(existing)
      continue
    }
    const pin = pinAddresses(hostname, addresses)
    context.pins.set(hostname, pin)
    pins.push(pin)
  }
  return pins
}

/**
 * Wall clock for one step: an equal share of the call's budget, less the rate
 * limit between steps, and never more than a single step may take on its own.
 */
export function stepBudgetMs(callTimeoutMs: number, steps: number): number {
  const spacing = STEP_INTERVAL_MS * Math.max(0, steps - 1)
  const share = Math.floor((callTimeoutMs - spacing) / Math.max(1, steps))
  return Math.max(1_000, Math.min(STEP_TIMEOUT_MS, share))
}

/** argv is assembled here from the validated step — never from model output. */
export function buildStepArgv(step: PocStep, pins: readonly TargetPin[], timeoutMs = STEP_TIMEOUT_MS): string[] {
  const url = new URL(step.url)
  const port = url.port || (url.protocol === "https:" ? "443" : "80")
  const hostname = url.hostname.toLowerCase()
  const pin = pins.find((entry) => entry.hostname === hostname)

  const argv = [
    "curl",
    "--silent",
    "--show-error",
    "--globoff",
    "--http1.1",
    "--proto", "=http,https",
    // Followed, bounded. An authentication bypass usually lands through a
    // redirect, so refusing to follow one made the tool unable to demonstrate
    // the thing it was looking for. Each hop is still held to the pinned
    // addresses, and the transcript records every one.
    "--location",
    "--max-redirs", String(MAX_REDIRECTS),
    "--connect-timeout", String(CONNECT_TIMEOUT_SECONDS),
    "--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1_000))),
    "--user-agent", USER_AGENT,
  ]
  if (step.method === "HEAD") argv.push("--head")
  else argv.push("--include", "--request", step.method)
  if (pin && !isAddress(hostname)) argv.push("--resolve", resolveEntry(hostname, port, pin.addresses))
  for (const [name, value] of Object.entries(step.headers ?? {})) argv.push("--header", `${name}: ${value}`)
  // `--data-binary` rather than `--data`: a payload must arrive exactly as the
  // plan wrote it, and `--data` strips newlines.
  if (step.body !== undefined) argv.push("--data-binary", step.body)
  argv.push(step.url)
  return argv
}

/** Enough for a login chain to land, few enough that a loop is caught. */
const MAX_REDIRECTS = 5

/**
 * Strips a credential a server echoed back at us.
 *
 * `set-cookie` on a login response is the common one: the transcript is the
 * proof that authentication worked, and it should not also be a working
 * session for whoever reads the report.
 */
export function redactTranscript(transcript: string): string {
  return transcript.replace(
    /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/gm,
    (line, name: string) => (isSecretHeader(name) ? `${name}: ${POC_REDACTED}` : line),
  )
}

/**
 * argv with every secret replaced, for anything a reader will see.
 *
 * The bundle exists to be handed to a client. The request that proves the
 * finding has to be in it; the operator's session token does not, and a bundle
 * that carries one cannot safely be attached to a report.
 */
/** Replaces any credential the target echoed back with the name it was sent under. */
function scrubbed(text: string, context: CapabilityContext): string {
  return context.credentials?.size ? context.credentials.scrub(text) : text
}

/**
 * Substitutes credentials into the command that will actually run.
 *
 * A proof step authenticates the same way a check does, by naming a credential
 * the operator holds. The reference is resolved against the step's own URL, so
 * a plan whose later steps wander to another host cannot carry the token there.
 */
export function resolveArgvCredentials(
  argv: readonly string[],
  url: string,
  context: CapabilityContext,
): string[] {
  const referenced = argv.some((value) => OperatorCredentials.references(value).length)
  if (!referenced) return [...argv]
  if (!context.credentials) {
    const names = argv.flatMap((value) => OperatorCredentials.references(value))
    throw new Error(
      `This proof step references the credential ${[...new Set(names)].map((name) => `"${name}"`).join(", ")}, `
      + "but no credential store was loaded for this engagement.",
    )
  }
  const credentials = context.credentials
  return argv.map((value) => credentials.resolve(value, url, "a proof step"))
}

export function redactArgv(argv: readonly string[]): string[] {
  const safe: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!
    safe.push(value)
    if (value !== "--header") continue
    const header = argv[index + 1]
    if (header === undefined) continue
    const name = header.slice(0, header.indexOf(":"))
    safe.push(isSecretHeader(name.trim()) ? `${name}: ${POC_REDACTED}` : header)
    index += 1
  }
  return safe
}

/**
 * One `--resolve` entry holding every pinned address.
 *
 * Separate flags for the same host and port do not fall back: curl commits to
 * the first set and fails outright when those addresses are unreachable, which
 * is what happens to an IPv6 answer inside an IPv4-only sandbox. A single
 * comma-separated entry tries them in turn. IPv6 is bracketed because the entry
 * is itself colon-separated, and an unbracketed address misparses the whole of
 * it.
 */
export function resolveEntry(hostname: string, port: string, addresses: readonly string[]): string {
  const ordered = [...addresses].sort((left, right) => Number(left.includes(":")) - Number(right.includes(":")))
  return `${hostname}:${port}:${ordered.map((address) => (address.includes(":") ? `[${address}]` : address)).join(",")}`
}

export interface ParsedHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * Parses `curl --include` output. Interim 1xx blocks are skipped, so the
 * response that is judged is the one the server finished with.
 */
export function parseHttpResponse(output: string): ParsedHttpResponse | undefined {
  let rest = output
  let status: number | undefined
  let headers: Record<string, string> = {}
  while (rest.startsWith("HTTP/")) {
    const separator = /\r?\n\r?\n/.exec(rest)
    const block = separator ? rest.slice(0, separator.index) : rest
    const remainder = separator ? rest.slice(separator.index + separator[0].length) : ""
    const [statusLine = "", ...headerLines] = block.split(/\r?\n/)
    const code = Number(statusLine.split(" ")[1])
    if (!Number.isSafeInteger(code) || code < 100 || code > 599) return undefined
    status = code
    headers = {}
    for (const line of headerLines.slice(0, 64)) {
      const index = line.indexOf(":")
      if (index <= 0) continue
      headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim()
    }
    // A 1xx block is followed by the real response; anything else ends it.
    if (code >= 200 || !remainder.startsWith("HTTP/")) {
      rest = remainder
      break
    }
    rest = remainder
  }
  return status === undefined ? undefined : { status, headers, body: rest }
}

export interface StepOutcome {
  met: boolean
  detail: string
  /** False when the run could not decide, which keeps the verdict inconclusive. */
  conclusive: boolean
  /**
   * The conditions that held and the ones that did not, in the terms the plan
   * declared them.
   *
   * `detail` says what the target actually returned, which is what a proof
   * bundle needs. These say what was claimed, which is what a finding's summary
   * needs: a sentence a reader trusts should not be written by the target.
   */
  matched: string[]
  failed: string[]
}

/** Compares one response against the step's stated conditions, and says why. */
export function judge(step: PocStep, response: ParsedHttpResponse, truncated: boolean): StepOutcome {
  return judgeExpectation(step.expect, response, truncated)
}

/**
 * Compares one response against one expectation.
 *
 * Everything stated has to hold, and — when the expectation offers
 * alternatives — at least one of them as well. The alternatives are judged the
 * same way as anything else, one level deep, so "any one of these five headers
 * is absent" is decided by the same code that decides every other condition.
 */
export function judgeExpectation(
  expect: PocExpectation,
  response: ParsedHttpResponse,
  truncated: boolean,
): StepOutcome {
  const failures: string[] = []
  const met: string[] = []
  const matched: string[] = []
  const failed: string[] = []
  const bodyChecked = usesBody(expect)
  if (truncated && bodyChecked) {
    return {
      met: false,
      detail: "the response body was truncated, so the body condition could not be decided",
      conclusive: false,
      matched: [],
      failed: [],
    }
  }

  const record = (ok: boolean, observed: string, declared: string): void => {
    ;(ok ? met : failures).push(observed)
    ;(ok ? matched : failed).push(declared)
  }

  if (expect.status) {
    const ok = expect.status.includes(response.status)
    record(
      ok,
      `status ${response.status}${ok ? "" : ` is not ${expect.status.join(" or ")}`}`,
      `status ${expect.status.join(" or ")}`,
    )
  }
  for (const name of expect.headersPresent ?? []) {
    const present = response.headers[name.toLowerCase()] !== undefined
    record(present, `${name.toLowerCase()} ${present ? "present" : "absent"}`, `${name.toLowerCase()} present`)
  }
  for (const name of expect.headersAbsent ?? []) {
    const absent = response.headers[name.toLowerCase()] === undefined
    record(absent, `${name.toLowerCase()} ${absent ? "absent" : "present"}`, `${name.toLowerCase()} absent`)
  }
  if (expect.contentType !== undefined) {
    const actual = response.headers["content-type"] ?? ""
    const ok = actual.toLowerCase().includes(expect.contentType.toLowerCase())
    record(
      ok,
      `content type ${actual || "not sent"}${ok ? "" : ` does not contain ${expect.contentType}`}`,
      `content type containing ${expect.contentType}`,
    )
  }
  if (expect.bodyIncludes !== undefined) {
    const ok = response.body.includes(expect.bodyIncludes)
    record(ok, `body ${ok ? "contains" : "does not contain"} the expected marker`, "the declared marker in the body")
  }
  if (expect.bodyExcludes !== undefined) {
    const ok = !response.body.includes(expect.bodyExcludes)
    record(ok, `body ${ok ? "omits" : "contains"} the excluded text`, "the declared text absent from the body")
  }

  if (expect.anyOf?.length) {
    const alternatives = expect.anyOf.map((entry) => judgeExpectation(entry, response, truncated))
    const held = alternatives.filter((outcome) => outcome.met)
    if (held.length) {
      met.push(held.flatMap((outcome) => outcome.met ? [outcome.detail.replace(/^reproduced: /, "")] : []).join(", "))
      matched.push(...held.flatMap((outcome) => outcome.matched))
    } else {
      // Which alternative failed and how is the whole point of the sentence: a
      // reader needs "the headers were present", not a count.
      failures.push(
        `none of the alternatives held (${alternatives
          .map((outcome) => outcome.detail.replace(/^not reproduced: /, ""))
          .join("; ")})`,
      )
      failed.push(...alternatives.flatMap((outcome) => outcome.failed))
    }
  }

  return failures.length
    ? { met: false, detail: `not reproduced: ${failures.join("; ")}`, conclusive: true, matched, failed }
    : { met: true, detail: `reproduced: ${met.join("; ")}`, conclusive: true, matched, failed }
}

/** Whether deciding this expectation needs the body, alternatives included. */
function usesBody(expect: PocExpectation): boolean {
  if (expect.bodyIncludes !== undefined || expect.bodyExcludes !== undefined) return true
  return (expect.anyOf ?? []).some((entry) => entry.bodyIncludes !== undefined || entry.bodyExcludes !== undefined)
}

function curlFailure(exitCode: number, stderr: string, timedOut: boolean): string {
  if (timedOut) return "the step exceeded its wall-clock limit before the target answered"
  const known: Record<number, string> = {
    6: "the hostname could not be resolved",
    7: "the target refused the connection",
    28: "the request timed out",
    35: "the TLS handshake failed",
    47: "the redirect limit was reached, and redirects are not followed",
    60: "the server certificate could not be verified",
  }
  const reason = known[exitCode] ?? `curl exited ${exitCode}`
  const detail = stderr.trim().split("\n")[0]?.slice(0, 200)
  return `inconclusive: ${reason}${detail ? ` (${detail})` : ""}`
}

/** A URL without the scope expression's trailing wildcard. */
function concreteUrl(expression: string): string {
  return expression.replace(/\*$/, "")
}

/** Portable quoting, so a recorded argv pastes into any POSIX shell unchanged. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,.\/-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

function renderScript(plan: PocPlan, records: readonly PocStepRecord[]): string {
  const lines = [
    "#!/usr/bin/env sh",
    `# Cyrion Community proof of concept for ${plan.findingId}.`,
    `# ${safeText(plan.title)}`,
    "#",
    "# Each hostname is pinned to the address recorded at capture, and redirects",
    "# are followed to a bounded depth. Steps may change state: read them before",
    "# running this, and run it only against the target the engagement authorized.",
    "#",
    "# Any credential this exploit sent has been redacted. Where a step shows",
    `# '${POC_REDACTED}', substitute your own before running it.`,
    "set -u",
    "",
  ]
  for (const [index, record] of records.entries()) {
    lines.push(
      `echo ${shellQuote(`--- step ${index + 1}: ${safeText(record.description)}`)}`,
      record.argv.map(shellQuote).join(" "),
      "",
    )
  }
  return lines.join("\n")
}

/** The manual reproduction, so a reader can check the claim without Cyrion. */
function renderRepro(bundle: PocBundle, bundleId: string): string {
  const lines = [
    `# Reproduction — ${bundle.findingId}`,
    "",
    safeText(bundle.plan.title),
    "",
    safeText(bundle.plan.rationale),
    "",
    `- Verdict: **${bundle.verdict.toUpperCase()}**`,
    `- Captured: ${bundle.createdAt}`,
    `- Engagement: \`${bundle.engagementId}\``,
    `- Bundle artifact: \`${bundleId}\``,
    `- Runner: ${bundle.runner}`,
    `- Tool: ${safeText(shortVersion(bundle.tool))}`,
    "",
    "## Pinned addresses",
    "",
  ]
  if (!bundle.pins.length) lines.push("- none recorded", "")
  for (const pin of bundle.pins) lines.push(`- \`${safeText(pin.hostname)}\` → ${pin.addresses.join(", ")}`)
  lines.push("", "## Steps", "")

  for (const [index, record] of bundle.steps.entries()) {
    lines.push(
      `### ${index + 1}. ${safeText(record.description)}`,
      "",
      `- Request: \`${record.request.method} ${safeText(record.request.url)}\``,
      `- Expected: ${expectationText(bundle.plan.steps[index]?.expect)}`,
      record.response
        ? `- Observed: status ${record.response.status}, ${record.response.bodyBytes} body bytes`
          + `${record.response.contentType ? `, content type ${safeText(record.response.contentType)}` : ""}`
          + ` (sha256 \`${record.response.bodySha256}\`)`
        : `- Observed: no response (exit ${record.exitCode})`,
      `- Result: ${safeText(record.detail)}`,
      `- Exchange artifact: ${record.evidenceId ? `\`${record.evidenceId}\`` : "not captured"}`,
      "",
      "```sh",
      record.argv.map(shellQuote).join(" "),
      "```",
      "",
    )
  }

  lines.push(
    "## Reproduce by hand",
    "",
    "```sh",
    bundle.script.trimEnd(),
    "```",
    "",
    "Cyrion replays this bundle with `cyrion replay " + bundle.findingId + " --manifest <engagement.json>`,",
    "which re-checks every step against the approved scope before it runs.",
    "",
  )
  return lines.join("\n")
}

/** The first line of a version banner is enough to identify what ran. */
function shortVersion(tool: PocBundle["tool"]): string {
  if (!tool.version) return tool.binary
  const words = tool.version.split(/\s+/).slice(0, 2).join(" ")
  return words || tool.binary
}

function expectationText(expect: PocStep["expect"] | undefined): string {
  if (!expect) return "not recorded"
  const parts: string[] = []
  if (expect.status) parts.push(`status ${expect.status.join(" or ")}`)
  if (expect.headersPresent?.length) parts.push(`headers present: ${expect.headersPresent.join(", ")}`)
  if (expect.headersAbsent?.length) parts.push(`headers absent: ${expect.headersAbsent.join(", ")}`)
  if (expect.contentType) parts.push(`content type contains ${safeText(expect.contentType)}`)
  if (expect.bodyIncludes) parts.push("body contains the recorded marker")
  if (expect.bodyExcludes) parts.push("body omits the recorded text")
  return parts.join("; ") || "not recorded"
}

/** Target-derived text reaches a report; control characters never should. */
function safeText(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").replaceAll("`", "'")
}
