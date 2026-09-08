import { createHash } from "node:crypto"
import type { EngagementManifest } from "@cyrion/contracts"
import { isAddress, parseCidr, parseTarget } from "@cyrion/scope"

/** Capabilities a scan may be given, in the order the form offers them. */
export const scanCapabilities = [
  { name: "dns.lookup", label: "Resolve and pin the host", safe: true },
  { name: "http.probe", label: "Fetch pages and read headers", safe: true },
  { name: "net.tls", label: "Inspect the TLS certificate", safe: true },
  { name: "poc.run", label: "Reproduce findings as replayable proof", safe: false },
  { name: "net.portscan", label: "Scan ports (noisy; hosts and ranges only)", safe: false },
] as const

export type ScanCapability = (typeof scanCapabilities)[number]["name"]

/** What an operator has to decide before a scan can start. */
export interface ScanInput {
  target: string
  attestation: string
  capabilities: ScanCapability[]
  sandbox: "local" | "container"
  mode: "autonomous" | "supervised"
  name?: string
  objective?: string
  excluded?: string[]
}

export const defaultScanInput: ScanInput = {
  target: "",
  attestation: "",
  // The read-only pair: enough to inventory a site and check its responses,
  // and nothing that repeats a condition against it.
  capabilities: ["dns.lookup", "http.probe"],
  sandbox: "local",
  mode: "autonomous",
}

/**
 * Why this scan cannot start yet, in the operator's language.
 *
 * Every reason is something they can act on from the form, and authorization is
 * one of them: a scan without an attestation is refused here rather than at the
 * controller, so the requirement is visible before any work begins.
 */
export function scanInputError(input: ScanInput): string | undefined {
  const target = input.target.trim()
  if (!target) return "Enter the address you are authorized to assess, such as https://example.com"
  let parsed
  try {
    parsed = parseTarget(target)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  if (parsed.kind === "repo") return "Repository targets are inventoried by a different profile, not by a web scan"
  if (parsed.kind === "url" && parsed.scheme === "http" && !isLoopback(parsed.host)) {
    return "Plain http to a remote host sends the assessment in cleartext; use https, or a loopback address for a local lab"
  }
  if (!input.capabilities.length) return "Choose at least one capability; a scan with none can observe nothing"
  if (parsed.kind === "url" && input.capabilities.includes("net.portscan")) {
    return "net.portscan needs a host or range target, not a URL. Remove it, or scan the host instead"
  }
  if (input.attestation.trim().length < 8) {
    return "State who authorized this assessment and under what reference; it is recorded in the report"
  }
  return undefined
}

/**
 * Turns one approved address into a complete engagement.
 *
 * The budgets are deliberately modest: a first scan of one site should finish,
 * not run until something stops it. Reproduction moves the run to supervised,
 * because a capability that repeats a condition against a live target is one an
 * operator should watch the first time.
 */
export function buildScanManifest(input: ScanInput, now = new Date()): EngagementManifest {
  const error = scanInputError(input)
  if (error) throw new Error(error)
  const target = normalizeTarget(input.target.trim())
  const parsed = parseTarget(target)
  const host = parsed.kind === "url" || parsed.kind === "host" ? parsed.host : "target"
  const reproduces = input.capabilities.includes("poc.run")

  return {
    id: engagementId(target, now),
    name: input.name?.trim() || `Assessment of ${host}`,
    objective: input.objective?.trim()
      || `Assess the approved surface at ${target} and independently validate every candidate finding.`,
    profile: "web-api",
    // Reproduction is supervised on a first run whatever the form said.
    mode: reproduces ? "supervised" : input.mode,
    scope: {
      targets: [target],
      excluded: [...(input.excluded ?? [])],
      capabilities: [...input.capabilities],
    },
    budgets: {
      maxConcurrentAgents: 3,
      maxAgents: 40,
      maxDepth: 3,
      maxTasks: 40,
      // Room for a provider in the loop; a deterministic run finishes in seconds.
      maxDurationMs: 1_800_000,
      maxTokens: 200_000,
      maxCostUsd: 2,
    },
  }
}

/**
 * A bare origin covers everything under it, which is what a site scan means.
 *
 * A bare name is assumed to be a website, because that is what an operator
 * typing one means. An address, a range, or a port list is not: those are
 * network targets, and turning them into URLs would quietly remove the
 * capabilities that only apply to a host.
 */
export function normalizeTarget(value: string): string {
  const raw = value.trim()
  if (isNetworkTarget(raw)) return raw
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== "http:" && url.protocol !== "https:") return value
    if (url.username || url.password) throw new Error("A target must not carry credentials")
    // Keep an explicit path; otherwise scope the whole origin.
    const path = url.pathname === "/" ? "/" : url.pathname
    return `${url.protocol}//${url.host}${path}`
  } catch {
    return value
  }
}

/** Readable, unique, and stable for one target within a second. */
export function engagementId(target: string, now: Date): string {
  const parsed = tryHost(target)
  const readable = parsed.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "target"
  const digest = createHash("sha256").update(`${target}${now.toISOString().slice(0, 19)}`).digest("hex").slice(0, 8)
  return `ENG-${readable}-${digest}`
}

function tryHost(target: string): string {
  try {
    const parsed = parseTarget(target)
    return parsed.kind === "url" || parsed.kind === "host" ? parsed.host : "target"
  } catch {
    return "target"
  }
}

/** Shapes that are unambiguously a host or a range rather than a site. */
export function isNetworkTarget(value: string): boolean {
  if (value.startsWith("host:")) return true
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false
  const [host = "", ports] = splitPorts(value)
  if (ports !== undefined && /^[0-9,\-]+$/.test(ports)) return true
  return isAddress(host) || parseCidr(value) !== undefined
}

/** Splits `host:ports`, leaving an IPv6 literal's own colons alone. */
function splitPorts(value: string): [string, string | undefined] {
  if (value.startsWith("[")) {
    const close = value.indexOf("]")
    if (close < 0) return [value, undefined]
    const rest = value.slice(close + 1)
    return [value.slice(0, close + 1), rest.startsWith(":") ? rest.slice(1) : undefined]
  }
  const index = value.lastIndexOf(":")
  if (index < 0 || value.indexOf(":") !== index) return [value, undefined]
  return [value.slice(0, index), value.slice(index + 1)]
}

function isLoopback(host: string): boolean {
  const clean = host.replace(/^\[|\]$/g, "").toLowerCase()
  return clean === "localhost" || clean === "::1" || clean.startsWith("127.")
}

/** Capabilities that are safe to offer for the kind of target given. */
export function applicableCapabilities(target: string): ScanCapability[] {
  let kind: string
  try {
    kind = parseTarget(normalizeTarget(target)).kind
  } catch {
    kind = "url"
  }
  return scanCapabilities
    .filter((capability) => capability.name !== "net.portscan" || kind === "host")
    .map((capability) => capability.name)
}
