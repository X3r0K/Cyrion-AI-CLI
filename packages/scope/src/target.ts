import { isAddress, parseAddress, parseCidr, type ParsedCidr } from "./address"

export type TargetKind = "url" | "host" | "repo"

export interface PortRange {
  from: number
  to: number
}

export interface HostTarget {
  kind: "host"
  raw: string
  /** Lower-cased hostname, wildcard base, or literal address. */
  host: string
  wildcard: boolean
  cidr?: ParsedCidr
  ports?: PortRange[]
}

export interface UrlTarget {
  kind: "url"
  raw: string
  scheme: "http" | "https"
  host: string
  wildcard: boolean
  port?: number
  /** Path prefix; a trailing "*" means "and everything under it". */
  path: string
  pathPrefix: boolean
}

export interface RepoTarget {
  kind: "repo"
  raw: string
  /** Canonical, separator-normalized root. Symlinks are resolved by the caller. */
  root: string
}

export type TargetSpec = HostTarget | UrlTarget | RepoTarget

const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

/**
 * Parses one scope expression. The kind is inferred from the syntax, and may be
 * stated explicitly with a `host:`, `url:`, or `repo:` prefix when the shorthand
 * would be ambiguous.
 */
export function parseTarget(expression: string): TargetSpec {
  const target = tryParseTarget(expression)
  if (typeof target === "string") throw new Error(`Invalid target expression "${expression}": ${target}`)
  return target
}

export function targetExpressionError(expression: string): string | undefined {
  const target = tryParseTarget(expression)
  return typeof target === "string" ? target : undefined
}

export function tryParseTarget(expression: string): TargetSpec | string {
  const raw = expression.trim()
  if (!raw) return "expression is empty"
  if (raw.length > 2_048) return "expression is too long"
  // Only the scheme and kind prefix are case-insensitive; the rest is parsed as written.
  const lead = raw.toLowerCase()

  if (lead.startsWith("repo:") || lead.startsWith("file://")) {
    const value = lead.startsWith("file://") ? raw.slice("file://".length) : raw.slice("repo:".length)
    return parseRepo(value, raw)
  }
  if (lead.startsWith("url:")) return parseUrl(raw.slice("url:".length), raw)
  if (lead.startsWith("host:")) return parseHost(raw.slice("host:".length), raw)
  if (lead.startsWith("http://") || lead.startsWith("https://")) return parseUrl(raw, raw)
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(lead)?.[1]
  if (scheme) return `scheme "${scheme}" is not supported; use http, https, host:, or repo:`
  if (raw.startsWith("./") || raw.startsWith("../") || raw.startsWith("/")) return parseRepo(raw, raw)
  return parseHost(raw, raw)
}

function parseUrl(value: string, raw: string): UrlTarget | string {
  // Checked before parsing: the URL constructor would resolve "/../" away, and a
  // scope entry must mean exactly what the operator wrote.
  const written = value.slice(value.indexOf("//") + 2)
  if (written.split(/[/?#]/).includes("..")) return "URL path must not contain a relative segment"
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return "not a valid URL"
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "URL scheme must be http or https"
  if (url.username || url.password) return "URL must not embed credentials"
  if (url.search || url.hash) return "URL target must not carry a query or fragment"
  const hostname = url.hostname.toLowerCase()
  const wildcard = hostname.startsWith("*.")
  const bare = wildcard ? hostname.slice(2) : hostname
  if (!isAddress(bare) && !HOSTNAME_PATTERN.test(bare)) return "URL host is not a hostname or address"
  const path = decodeURI(url.pathname) || "/"
  if (path.includes("..")) return "URL path must not contain a relative segment"
  const pathPrefix = path.endsWith("*")
  return {
    kind: "url",
    raw,
    scheme: url.protocol === "https:" ? "https" : "http",
    host: bare,
    wildcard,
    ...(url.port ? { port: Number(url.port) } : {}),
    path: pathPrefix ? path.slice(0, -1) : path,
    pathPrefix,
  }
}

function parseHost(value: string, raw: string): HostTarget | string {
  const { host, ports, error } = splitPorts(value)
  if (error) return error
  const lower = host.toLowerCase()

  const cidr = parseCidr(lower)
  if (cidr) return { kind: "host", raw, host: cidr.canonical, wildcard: false, cidr, ...(ports ? { ports } : {}) }
  if (lower.includes("/")) return "CIDR notation is invalid"

  const wildcard = lower.startsWith("*.")
  const bare = wildcard ? lower.slice(2) : lower
  const address = parseAddress(bare)
  if (address) {
    if (wildcard) return "an address cannot carry a wildcard"
    return { kind: "host", raw, host: address.canonical, wildcard: false, ...(ports ? { ports } : {}) }
  }
  if (!HOSTNAME_PATTERN.test(bare)) return "host is not a hostname, address, or CIDR"
  return { kind: "host", raw, host: bare, wildcard, ...(ports ? { ports } : {}) }
}

function parseRepo(value: string, raw: string): RepoTarget | string {
  const trimmed = value.trim()
  if (!trimmed) return "repository path is empty"
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "") || "/"
  if (normalized.split("/").includes("..")) return "repository path must not contain a relative segment"
  return { kind: "repo", raw, root: normalized }
}

/** Splits `host:ports`, tolerating bracketed IPv6 literals. */
function splitPorts(value: string): { host: string; ports?: PortRange[]; error?: string } {
  if (value.startsWith("[")) {
    const close = value.indexOf("]")
    if (close < 0) return { host: value, error: "bracketed address is not closed" }
    const host = value.slice(1, close)
    const rest = value.slice(close + 1)
    if (!rest) return { host }
    if (!rest.startsWith(":")) return { host, error: "expected a port list after the address" }
    const ports = parsePorts(rest.slice(1))
    return typeof ports === "string" ? { host, error: ports } : { host, ports }
  }
  const colons = value.split(":").length - 1
  if (colons === 0) return { host: value }
  // More than one colon and no brackets means a bare IPv6 literal, which has no port list.
  if (colons > 1) return { host: value }
  const [host, portText] = value.split(":") as [string, string]
  const ports = parsePorts(portText)
  return typeof ports === "string" ? { host, error: ports } : { host, ports }
}

function parsePorts(text: string): PortRange[] | string {
  if (!text.trim()) return "port list is empty"
  const ranges: PortRange[] = []
  for (const part of text.split(",")) {
    const item = part.trim()
    const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(item)
    if (!match) return `port "${item}" is invalid`
    const from = Number(match[1])
    const to = match[2] === undefined ? from : Number(match[2])
    if (from < 1 || to > 65_535 || from > to) return `port range "${item}" is out of bounds`
    ranges.push({ from, to })
  }
  return ranges
}

export function portInRanges(port: number, ranges: readonly PortRange[]): boolean {
  return ranges.some((range) => port >= range.from && port <= range.to)
}

/** Stable text form, used for scope hashing and operator display. */
export function canonicalTarget(target: TargetSpec): string {
  if (target.kind === "repo") return `repo:${target.root}`
  if (target.kind === "url") {
    const port = target.port ? `:${target.port}` : ""
    const host = target.wildcard ? `*.${target.host}` : target.host
    return `url:${target.scheme}://${host}${port}${target.path}${target.pathPrefix ? "*" : ""}`
  }
  const host = target.cidr ? target.cidr.canonical : target.wildcard ? `*.${target.host}` : target.host
  const ports = target.ports
    ? `:${target.ports.map((range) => (range.from === range.to ? `${range.from}` : `${range.from}-${range.to}`)).join(",")}`
    : ""
  return `host:${host}${ports}`
}
