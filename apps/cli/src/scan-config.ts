import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { EngagementManifest } from "@cyrion/contracts"
import { isAddress, parseCidr, parseTarget } from "@cyrion/scope"

/** Capabilities a scan may be given, in the order the form offers them. */
export const scanCapabilities = [
  { name: "dns.lookup", label: "Resolve and pin the host", safe: true },
  { name: "http.probe", label: "Fetch pages and read headers", safe: true },
  { name: "http.request", label: "Ask the requests a skill's checks declare", safe: true },
  { name: "http.crawl", label: "Follow the site's own links to find endpoints", safe: true },
  { name: "net.tls", label: "Inspect the TLS certificate", safe: true },
  { name: "poc.run", label: "Reproduce findings as replayable proof", safe: false },
  { name: "net.portscan", label: "Scan ports (noisy; hosts and ranges only)", safe: false },
  { name: "web.fuzz", label: "Content discovery with a wordlist", safe: false },
  { name: "vuln.scan", label: "Run nuclei templates against the target", safe: false },
  { name: "sqli.test", label: "Test for injection with sqlmap", safe: false },
  { name: "shell.exec", label: "Run commands the agent writes, in the sandbox", safe: false },
  { name: "python.exec", label: "Write and run proof-of-concept exploits", safe: false },
  { name: "repo.inventory", label: "Inventory a repository (repository targets only)", safe: true },
  { name: "repo.scan", label: "Static analysis with semgrep (repository targets only)", safe: true },
  { name: "repo.deps", label: "Known-vulnerable dependencies (repository targets only)", safe: true },
] as const

export type ScanCapability = (typeof scanCapabilities)[number]["name"]

/**
 * What a scan runs with. Only the target is required.
 *
 * Everything else has an answer that is right often enough to be the default:
 * an operator who typed an address wants that address assessed with whatever
 * Cyrion can bring to it, not a form.
 */
export interface ScanInput {
  target: string
  /** Kept only for the operator who wants the record; never required. */
  attestation?: string
  capabilities: ScanCapability[]
  sandbox: "local" | "container"
  mode: "autonomous" | "supervised"
  name?: string
  objective?: string
  excluded?: string[]
}

export const defaultScanInput: ScanInput = {
  target: "",
  // Everything applicable to the target. A capability the target kind cannot
  // use is dropped when the manifest is built, not asked about here.
  capabilities: scanCapabilities.map((capability) => capability.name),
  sandbox: "container",
  mode: "autonomous",
}

/**
 * Why this scan cannot start yet, in the operator's language.
 *
 * The only thing that can be wrong now is the address. A capability that does
 * not apply to the target kind is dropped rather than refused, because an
 * operator who typed one address and got a list of complaints about a form they
 * never filled in has learned nothing they wanted to know.
 */
export function scanInputError(input: ScanInput): string | undefined {
  const raw = input.target.trim()
  if (!raw) return "Enter an address to assess, such as https://example.com, an IP range, or ./path/to/repo"
  // Judge what will actually be scanned, not what was typed: `.` is a
  // repository and `example.com` is an https origin.
  const target = normalizeTarget(raw)
  try {
    parseTarget(target)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return undefined
}

/**
 * Turns one address into a complete engagement.
 *
 * Capabilities are narrowed to the ones the target kind can actually use, so
 * naming a repository does not carry `net.portscan` into the manifest and a URL
 * does not carry `repo.inventory`. That narrowing is why the defaults can be
 * "everything": the target decides what "everything" means.
 */
export function buildScanManifest(input: ScanInput, now = new Date()): EngagementManifest {
  const error = scanInputError(input)
  if (error) throw new Error(error)
  const target = normalizeTarget(input.target.trim())
  const parsed = parseTarget(target)
  const host = parsed.kind === "url" || parsed.kind === "host"
    ? parsed.host
    : parsed.root.split("/").filter(Boolean).at(-1) ?? "repository"
  const applicable = new Set(applicableCapabilities(target))
  const capabilities = input.capabilities.filter((capability) => applicable.has(capability))

  return {
    id: engagementId(target, now),
    name: input.name?.trim() || `Assessment of ${host}`,
    objective: input.objective?.trim()
      || (parsed.kind === "repo"
        ? `Inventory the approved repository at ${parsed.root} and record what it is built from.`
        : `Assess the approved surface at ${target} and independently validate every candidate finding.`),
    // A repository engagement is a different profile: nothing in it runs.
    profile: parsed.kind === "repo" ? "repository" : "web-api",
    mode: input.mode,
    scope: {
      targets: [target],
      excluded: [...(input.excluded ?? [])],
      capabilities,
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
  // A repository root is resolved here, once. A relative path in a manifest
  // would mean something different from whichever directory the run started in,
  // and the scope check and the capability would disagree about what was
  // approved.
  if (isRepositoryTarget(raw)) {
    const path = raw.startsWith("repo:") ? raw.slice("repo:".length) : raw
    const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path
    return `repo:${resolve(expanded)}`
  }
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
    if (parsed.kind === "url" || parsed.kind === "host") return parsed.host
    // A checkout is named by its directory, which is what an operator calls it.
    return parsed.root.split("/").filter(Boolean).at(-1) ?? "repository"
  } catch {
    return "target"
  }
}

/** A path an operator means as a checkout, rather than an address. */
export function isRepositoryTarget(value: string): boolean {
  if (value.startsWith("repo:")) return true
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false
  // `.` and `..` are how an operator names the directory they are standing in.
  if (value === "." || value === "..") return true
  return value.startsWith("./") || value.startsWith("../") || value.startsWith("/") || value.startsWith("~/")
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

/** Capabilities that are safe to offer for the kind of target given. */
export function applicableCapabilities(target: string): ScanCapability[] {
  let kind: string
  try {
    kind = parseTarget(normalizeTarget(target)).kind
  } catch {
    kind = "url"
  }
  return scanCapabilities
    .filter((capability) => {
      // Reads a checkout on disk; there is nothing to read without one.
      if (capability.name.startsWith("repo.")) return kind === "repo"
      // Needs an address to scan, which a URL target does not give it.
      if (capability.name === "net.portscan") return kind === "host"
      // Speak HTTP to one origin, so they need a URL rather than a range.
      if (capability.name === "web.fuzz" || capability.name === "sqli.test") return kind === "url"
      // A shell and a language apply to anything, including a checkout: the
      // agent may want to build the thing before it assesses it.
      if (capability.name === "shell.exec" || capability.name === "python.exec") return true
      // Nothing else that speaks HTTP applies to a checkout on disk.
      return kind !== "repo"
    })
    .map((capability) => capability.name)
}
