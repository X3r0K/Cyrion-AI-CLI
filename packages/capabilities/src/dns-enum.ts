import { promises as nodeDns } from "node:dns"
import type { ScopePolicy, ToolExecutionRequest } from "@cyrion/contracts"
import { evaluateScope, isAddress, parseTarget } from "@cyrion/scope"
import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "./types"

/** Records kept per type. A name with a thousand TXT entries is still bounded. */
const MAX_PER_TYPE = 32
/** Characters of any single record value. TXT is free text the target chose. */
const MAX_VALUE_LENGTH = 512

export type DnsRecordType = "A" | "AAAA" | "CNAME" | "MX" | "NS" | "TXT" | "SOA" | "CAA"

export const DNS_RECORD_TYPES: readonly DnsRecordType[] = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "CAA"]

export interface DnsRecordSet {
  type: DnsRecordType
  values: string[]
  /** Why a type produced nothing: absent records and a failed query differ. */
  error?: string
}

export interface DnsDelegation {
  /** The name this record points at. */
  name: string
  /** Which record type named it. */
  via: DnsRecordType
  inScope: boolean
}

/**
 * The queries this capability makes.
 *
 * An interface rather than a direct call so the behaviour can be tested
 * exhaustively without a network: what matters here is how answers are bounded,
 * labelled, and refused, and none of that should need a live zone to prove.
 */
export interface DnsResolver {
  resolve4(name: string): Promise<string[]>
  resolve6(name: string): Promise<string[]>
  resolveCname(name: string): Promise<string[]>
  resolveMx(name: string): Promise<Array<{ priority: number; exchange: string }>>
  resolveNs(name: string): Promise<string[]>
  resolveTxt(name: string): Promise<string[][]>
  resolveSoa(name: string): Promise<{ nsname: string; hostmaster: string; serial: number }>
  resolveCaa(name: string): Promise<Array<Record<string, string | number>>>
}

export const systemResolver: DnsResolver = nodeDns as unknown as DnsResolver

/**
 * A record value as it is safe to store and to show.
 *
 * TXT records in particular are free text the target's operator wrote, which
 * makes them the same class of input as a response body: bounded, and stripped
 * of anything that could drive a terminal or corrupt a log line.
 */
export function sanitizeRecordValue(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim().slice(0, MAX_VALUE_LENGTH)
}

/**
 * Names this zone hands off to, and whether the engagement covers them.
 *
 * A nameserver, a mail exchanger, and a CNAME target are all *other* hosts, and
 * they are very often somebody else's — a mail provider, a CDN, a registrar.
 * Reporting them is the point of enumerating; reaching them is not, so each is
 * labelled against the manifest and none of them is ever queried.
 */
export function classifyDelegations(
  scope: ScopePolicy,
  records: readonly DnsRecordSet[],
): DnsDelegation[] {
  const delegations: DnsDelegation[] = []
  const seen = new Set<string>()
  for (const set of records) {
    if (set.type !== "CNAME" && set.type !== "MX" && set.type !== "NS") continue
    for (const value of set.values) {
      // MX values carry their priority; the name is what a scope decision is about.
      const name = (set.type === "MX" ? value.split(/\s+/).pop() ?? "" : value)
        .replace(/\.$/, "")
        .toLowerCase()
      if (!name || seen.has(`${set.type}:${name}`)) continue
      seen.add(`${set.type}:${name}`)
      delegations.push({ name, via: set.type, inScope: evaluateScope(scope, name).allowed })
    }
  }
  return delegations
}

/**
 * Asks one approved name for every record type it might publish.
 *
 * Passive, and passive in a specific sense: it asks about the name the operator
 * approved and nothing else. There is no wordlist and no subdomain guessing,
 * which would be both noisy and pointless — a subdomain Cyrion invented is not
 * in the manifest, so finding it would produce an address the engagement may
 * not touch.
 *
 * A type with no records is an answer, not a failure. `example.com` publishes
 * no CNAME, and saying "no CNAME" is different from saying the query broke.
 */
export async function collectRecords(
  hostname: string,
  resolver: DnsResolver = systemResolver,
): Promise<DnsRecordSet[]> {
  const queries: Array<[DnsRecordType, () => Promise<string[]>]> = [
    ["A", async () => resolver.resolve4(hostname)],
    ["AAAA", async () => resolver.resolve6(hostname)],
    ["CNAME", async () => resolver.resolveCname(hostname)],
    ["MX", async () => (await resolver.resolveMx(hostname))
      .filter((entry) => entry.exchange)
      .map((entry) => `${entry.priority} ${entry.exchange}`)],
    ["NS", async () => resolver.resolveNs(hostname)],
    ["TXT", async () => (await resolver.resolveTxt(hostname)).map((chunks) => chunks.join(""))],
    ["SOA", async () => {
      const soa = await resolver.resolveSoa(hostname)
      return [`${soa.nsname} ${soa.hostmaster} ${soa.serial}`]
    }],
    ["CAA", async () => (await resolver.resolveCaa(hostname))
      .map((entry) => Object.entries(entry).map(([key, value]) => `${key}=${value}`).join(" "))],
  ]

  const settled = await Promise.all(queries.map(async ([type, run]): Promise<DnsRecordSet> => {
    try {
      const values = (await run())
        .map((value) => sanitizeRecordValue(String(value)))
        .filter((value) => value.length)
        .slice(0, MAX_PER_TYPE)
      return { type, values }
    } catch (error) {
      // A resolver says "this name publishes no CNAME" by failing the query, so
      // the two answers arrive down the same path and have to be told apart
      // here. Anything else kept its error, because "no MX" and "the MX query
      // broke" are different facts about a zone and a reader needs both.
      const reason = resolverError(error)
      return reason === NO_RECORDS ? { type, values: [] } : { type, values: [], error: reason }
    }
  }))
  return settled
}

/**
 * Enumerates the DNS records an approved name publishes.
 *
 * Implemented in Cyrion rather than through dnsx, for the reason `http.crawl`
 * is: `--sandbox local` has to keep working on a machine with nothing
 * installed, and a record lookup needs no binary to make.
 */
export const dnsEnum: CapabilityAdapter = {
  capability: "dns.enum",

  async execute(
    request: ToolExecutionRequest,
    context: CapabilityContext,
    signal: AbortSignal,
  ): Promise<CapabilityResult> {
    const decision = evaluateScope(context.scope, request.target)
    if (!decision.allowed) throw new Error(`dns.enum refused: ${decision.reason}`)
    const target = parseTarget(request.target)
    if (target.kind === "repo") throw new Error("dns.enum needs a host or URL target")
    const hostname = target.host
    if (!hostname) throw new Error("dns.enum needs a host or URL target")
    if (isAddress(hostname)) {
      throw new Error("dns.enum needs a name, not a literal address: an address publishes no records")
    }
    if (target.wildcard) {
      // A wildcard says which names are approved, not which ones exist, and
      // enumerating one would mean inventing labels to try — the guessing this
      // capability is defined not to do. The scope engine refuses a pattern as
      // a target already, so this is the second line rather than the first; it
      // is here because the failure it prevents is silent. `*.lab.test` parses
      // with its host as `lab.test`, so without it a loosened scope rule would
      // quietly enumerate a name nobody approved.
      throw new Error(
        `dns.enum needs a concrete name, not the pattern ${request.target}: `
        + "enumerating a wildcard would mean guessing subdomains, which this capability does not do.",
      )
    }

    const records = await collectRecords(hostname, context.dnsResolver ?? systemResolver)
    if (signal.aborted) throw signal.reason

    const delegations = classifyDelegations(context.scope, records)
    const addresses = [
      ...records.find((set) => set.type === "A")?.values ?? [],
      ...records.find((set) => set.type === "AAAA")?.values ?? [],
    ]
    // The pin belongs to dns.lookup, which is what later connections are held
    // to. Writing it from here as well would give the pin set two authors; what
    // is useful instead is saying when this answer disagrees with it, because a
    // name that started answering differently mid-engagement is the rebinding
    // case the scope engine already refuses.
    const pin = context.pins.get(hostname)
    const matchesPin = pin
      ? addresses.every((address) => pin.addresses.includes(address))
      : undefined

    const record = { host: hostname, queriedAt: new Date().toISOString(), records, delegations }
    const evidence = await context.evidence.capture({
      engagementId: request.engagementId,
      id: context.nextEvidenceId("E"),
      kind: "log",
      content: `${JSON.stringify(record, null, 2)}\n`,
      contentType: "application/json",
      source: request.agentId,
    })

    const present = records.filter((set) => set.values.length)
    return {
      summary: {
        host: hostname,
        addresses,
        records: Object.fromEntries(present.map((set) => [set.type, set.values])),
        // Types that answered with nothing, so a reader can tell "no MX" from
        // "the MX query failed".
        absent: records.filter((set) => !set.values.length && !set.error).map((set) => set.type),
        failed: records.filter((set) => set.error).map((set) => ({ type: set.type, error: set.error })),
        delegations,
        // Somebody else's infrastructure this zone depends on. Reported, never
        // queried, and never a permission to reach.
        externalDelegations: delegations.filter((entry) => !entry.inScope).map((entry) => entry.name),
        ...(matchesPin === undefined ? {} : { matchesPin }),
      },
      evidence: [evidence],
      outcome: `${present.length} record type${present.length === 1 ? "" : "s"} for ${hostname}`
        + `${delegations.length ? ` · ${delegations.length} delegation${delegations.length === 1 ? "" : "s"}` : ""}`,
    }
  },
}

/** What a resolver says when a name simply publishes nothing of that type. */
const NO_RECORDS = "no records"

/** A resolver failure, reduced to the code a reader can act on. */
function resolverError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code)
    if (code === "ENODATA" || code === "ENOTFOUND") return NO_RECORDS
    return code
  }
  return error instanceof Error ? sanitizeRecordValue(error.message) : "query failed"
}
