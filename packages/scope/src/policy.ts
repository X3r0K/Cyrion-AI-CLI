import { createHash } from "node:crypto"
import type { ScopePolicy } from "@cyrion/contracts"
import { cidrContains, isPrivateAddress, parseAddress, parseCidr } from "./address"
import {
  canonicalTarget,
  portInRanges,
  tryParseTarget,
  type HostTarget,
  type RepoTarget,
  type TargetSpec,
  type UrlTarget,
} from "./target"

export interface ScopeDecision {
  allowed: boolean
  /** Present when denied. Safe to record in an event. */
  reason?: string
  /** The scope entry that admitted the candidate. */
  matched?: string
  /** Ports the matched entry permits, when it restricts them. */
  allowedPorts?: string
}

export interface ScopeOptions {
  /** Rejects a candidate that names no port against an entry that restricts ports. */
  requirePort?: boolean
}

const allow = (target: TargetSpec): ScopeDecision => ({
  allowed: true,
  matched: canonicalTarget(target),
  ...(target.kind === "host" && target.ports
    ? { allowedPorts: target.ports.map((range) => (range.from === range.to ? `${range.from}` : `${range.from}-${range.to}`)).join(",") }
    : {}),
})

const deny = (reason: string): ScopeDecision => ({ allowed: false, reason })

/**
 * Decides whether one candidate target is inside the approved scope.
 * Exclusions are evaluated first and always win.
 */
export function evaluateScope(policy: ScopePolicy, candidate: string, options: ScopeOptions = {}): ScopeDecision {
  const parsed = tryParseTarget(candidate)
  if (typeof parsed === "string") return deny(`candidate is not a valid target: ${parsed}`)

  for (const expression of policy.excluded) {
    const excluded = tryParseTarget(expression)
    if (typeof excluded === "string") continue
    if (contains(excluded, parsed, { ...options, requirePort: false })) {
      return deny(`target is excluded by ${canonicalTarget(excluded)}`)
    }
  }

  for (const expression of policy.targets) {
    const target = tryParseTarget(expression)
    if (typeof target === "string") continue
    if (contains(target, parsed, options)) return allow(target)
  }
  return deny("target is not covered by the approved scope")
}

/** Rejects a policy that cannot be parsed, before any engagement starts. */
export function scopePolicyError(policy: ScopePolicy): string | undefined {
  for (const [label, expressions] of [["targets", policy.targets], ["excluded", policy.excluded]] as const) {
    for (const expression of expressions) {
      const parsed = tryParseTarget(expression)
      if (typeof parsed === "string") return `scope.${label} entry "${expression}" is invalid: ${parsed}`
    }
  }
  return undefined
}

export function contains(target: TargetSpec, candidate: TargetSpec, options: ScopeOptions = {}): boolean {
  if (target.kind !== candidate.kind) return false
  if (target.kind === "host") return hostContains(target, candidate as HostTarget, options)
  if (target.kind === "url") return urlContains(target, candidate as UrlTarget)
  return repoContains(target, candidate as RepoTarget)
}

function hostContains(target: HostTarget, candidate: HostTarget, options: ScopeOptions): boolean {
  if (!hostMatches(target, candidate)) return false
  if (!target.ports) return true
  if (!candidate.ports) return !options.requirePort
  return candidate.ports.every((range) =>
    portInRanges(range.from, target.ports!) && portInRanges(range.to, target.ports!))
}

function hostMatches(target: HostTarget, candidate: HostTarget): boolean {
  if (target.cidr) {
    const address = parseAddress(candidate.host)
    if (address) return cidrContains(target.cidr, address)
    const candidateCidr = candidate.cidr ?? parseCidr(candidate.host)
    if (!candidateCidr) return false
    // A candidate range is admitted only when it is fully inside the approved range.
    if (candidateCidr.version !== target.cidr.version || candidateCidr.prefix < target.cidr.prefix) return false
    const base = parseAddress(candidateCidr.canonical.split("/")[0] ?? "")
    return base ? cidrContains(target.cidr, base) : false
  }
  if (candidate.cidr) return false
  if (target.wildcard) return candidate.host.endsWith(`.${target.host}`) && candidate.host !== target.host
  return target.host === candidate.host
}

function urlContains(target: UrlTarget, candidate: UrlTarget): boolean {
  if (target.scheme !== candidate.scheme) return false
  const hostMatched = target.wildcard
    ? candidate.host.endsWith(`.${target.host}`) && candidate.host !== target.host
    : target.host === candidate.host
  if (!hostMatched) return false
  const defaultPort = target.scheme === "https" ? 443 : 80
  const targetPort = target.port ?? defaultPort
  const candidatePort = candidate.port ?? defaultPort
  if (targetPort !== candidatePort) return false
  // A bare origin covers the whole origin; any other path is a literal or a prefix.
  if (target.path === "/" && !target.pathPrefix) return true
  if (target.pathPrefix) return candidate.path.startsWith(target.path)
  return candidate.path === target.path
}

function repoContains(target: RepoTarget, candidate: RepoTarget): boolean {
  return candidate.root === target.root || candidate.root.startsWith(`${target.root}/`)
}

/** Checks a resolved address against every host entry, for an egress decision. */
export function evaluateAddress(policy: ScopePolicy, address: string): ScopeDecision {
  const parsed = parseAddress(address)
  if (!parsed) return deny("resolved value is not an IP address")
  for (const expression of policy.excluded) {
    const excluded = tryParseTarget(expression)
    if (typeof excluded !== "string" && excluded.kind === "host" && addressMatchesHost(excluded, parsed.canonical)) {
      return deny(`address is excluded by ${canonicalTarget(excluded)}`)
    }
  }
  for (const expression of policy.targets) {
    const target = tryParseTarget(expression)
    if (typeof target !== "string" && target.kind === "host" && addressMatchesHost(target, parsed.canonical)) {
      return allow(target)
    }
  }
  return deny("address is not covered by the approved scope")
}

function addressMatchesHost(target: HostTarget, canonical: string): boolean {
  const address = parseAddress(canonical)
  if (!address) return false
  if (target.cidr) return cidrContains(target.cidr, address)
  return target.host === canonical
}

export interface TargetPin {
  hostname: string
  addresses: string[]
  pinnedAt: string
  /** Whether every pinned address was private at pin time. */
  private: boolean
}

/**
 * Records the addresses a hostname resolved to when a task started. Every later
 * connection must use one of them, so a second answer cannot move the task to a
 * host the operator never approved.
 */
export function pinAddresses(hostname: string, addresses: readonly string[], now = new Date()): TargetPin {
  const canonical: string[] = []
  for (const address of addresses) {
    const parsed = parseAddress(address)
    if (!parsed) throw new Error(`Cannot pin "${address}": not an IP address`)
    if (!canonical.includes(parsed.canonical)) canonical.push(parsed.canonical)
  }
  if (!canonical.length) throw new Error(`Cannot pin ${hostname}: no addresses were resolved`)
  return {
    hostname: hostname.toLowerCase(),
    addresses: canonical.sort(),
    pinnedAt: now.toISOString(),
    private: canonical.every((value) => isPrivateAddress(parseAddress(value)!)),
  }
}

export function checkPinnedAddress(pin: TargetPin, address: string): ScopeDecision {
  const parsed = parseAddress(address)
  if (!parsed) return deny("connection address is not an IP address")
  if (pin.addresses.includes(parsed.canonical)) return { allowed: true, matched: pin.hostname }
  const rebinding = !pin.private && isPrivateAddress(parsed)
  return deny(
    rebinding
      ? `${pin.hostname} now resolves to the private address ${parsed.canonical}, which looks like DNS rebinding`
      : `${pin.hostname} resolved to ${parsed.canonical}, which was not pinned at task start`,
  )
}

export interface RedirectOptions extends ScopeOptions {
  /** Following https to http would downgrade the transport; refused by default. */
  allowDowngrade?: boolean
}

/** Decides whether a redirect may be followed. An out-of-scope hop is observed, not chased. */
export function checkRedirect(
  policy: ScopePolicy,
  from: string,
  to: string,
  options: RedirectOptions = {},
): ScopeDecision {
  const source = tryParseTarget(from)
  const destination = tryParseTarget(to)
  if (typeof destination === "string") return deny(`redirect destination is not a valid target: ${destination}`)
  if (destination.kind !== "url") return deny("redirect destination must be a URL")
  if (
    typeof source !== "string" && source.kind === "url"
    && source.scheme === "https" && destination.scheme === "http" && !options.allowDowngrade
  ) {
    return deny("redirect downgrades https to http")
  }
  const decision = evaluateScope(policy, to, options)
  return decision.allowed ? decision : deny(`redirect leaves the approved scope: ${decision.reason}`)
}

/** Stable text for hashing and display: parsed, canonicalized, sorted, deduplicated. */
export function canonicalScope(policy: ScopePolicy): string {
  const canonicalList = (expressions: readonly string[]): string[] =>
    [...new Set(expressions.map((expression) => {
      const parsed = tryParseTarget(expression)
      return typeof parsed === "string" ? `invalid:${expression}` : canonicalTarget(parsed)
    }))].sort()
  return [
    `targets:\n${canonicalList(policy.targets).map((line) => `  ${line}`).join("\n")}`,
    `excluded:\n${canonicalList(policy.excluded).map((line) => `  ${line}`).join("\n")}`,
    `capabilities:\n${[...new Set(policy.capabilities)].sort().map((line) => `  ${line}`).join("\n")}`,
  ].join("\n")
}

export function scopeHash(policy: ScopePolicy): string {
  return createHash("sha256").update(canonicalScope(policy)).digest("hex")
}
