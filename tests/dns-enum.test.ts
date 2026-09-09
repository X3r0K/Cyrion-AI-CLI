import { describe, expect, test } from "bun:test"
import type { ScopePolicy } from "@cyrion/contracts"
import {
  CapabilityRegistry,
  classifyDelegations,
  collectRecords,
  sanitizeRecordValue,
  type DnsRecordSet,
  type DnsResolver,
} from "@cyrion/capabilities"
import { MemoryEvidenceStore } from "@cyrion/evidence"
import { LocalToolRunner } from "@cyrion/sandbox"
import { pinAddresses } from "@cyrion/scope"

const scope: ScopePolicy = {
  targets: ["app.lab.test", "mail.lab.test"],
  excluded: [],
  capabilities: ["dns.enum"],
}

/** A zone that answers some types, publishes nothing for others, and fails one. */
function resolver(overrides: Partial<DnsResolver> = {}): DnsResolver {
  const absent = (): Promise<never> => Promise.reject(Object.assign(new Error("queryX ENODATA"), { code: "ENODATA" }))
  return {
    resolve4: async () => ["203.0.113.10"],
    resolve6: async () => ["2001:db8::1"],
    resolveCname: absent,
    resolveMx: async () => [{ priority: 10, exchange: "mail.lab.test" }, { priority: 20, exchange: "backup.mailhost.invalid" }],
    resolveNs: async () => ["ns1.registrar.invalid", "ns2.registrar.invalid"],
    resolveTxt: async () => [["v=spf1 -all"]],
    resolveSoa: async () => ({ nsname: "ns1.registrar.invalid", hostmaster: "admin.lab.test", serial: 7 }),
    resolveCaa: async () => [{ critical: 0, issue: "letsencrypt.org" }],
    ...overrides,
  }
}

async function enumerate(target: string, custom: DnsResolver = resolver(), policy: ScopePolicy = scope) {
  const evidence = new MemoryEvidenceStore()
  const registry = new CapabilityRegistry({
    runner: new LocalToolRunner({ allowedBinaries: [] }),
    scope: policy,
    evidence,
    capabilities: ["dns.enum"],
    dnsResolver: custom,
  })
  const result = await registry.execute({
    engagementId: "ENG-DNS",
    taskId: "T-1",
    agentId: "recon-1",
    capability: "dns.enum",
    target,
    timeoutMs: 20_000,
    maxOutputBytes: 500_000,
    input: {},
  }, new AbortController().signal)
  return { result, evidence, registry }
}

describe("a record value as it is safe to keep", () => {
  test("strips terminal control out of text the target chose", () => {
    // A zone can publish anything in a TXT record, escape sequences included.
    expect(sanitizeRecordValue("v=spf1\u001b[31m\u0000 -all")).toBe("v=spf1 [31m  -all")
  })

  test("bounds a record a zone could publish at any length", () => {
    expect(sanitizeRecordValue("x".repeat(4_000)).length).toBe(512)
  })
})

describe("what a zone hands off to", () => {
  const records: DnsRecordSet[] = [
    { type: "NS", values: ["ns1.registrar.invalid", "ns1.registrar.invalid."] },
    { type: "MX", values: ["10 mail.lab.test", "20 backup.mailhost.invalid"] },
    { type: "CNAME", values: ["edge.cdn.invalid"] },
    { type: "TXT", values: ["v=spf1 include:spf.invalid -all"] },
    { type: "A", values: ["203.0.113.10"] },
  ]

  test("takes the name out of an MX record, not its priority", () => {
    const mx = classifyDelegations(scope, records).filter((entry) => entry.via === "MX")
    expect(mx.map((entry) => entry.name)).toEqual(["mail.lab.test", "backup.mailhost.invalid"])
  })

  test("says which delegations the engagement covers and which it does not", () => {
    const found = classifyDelegations(scope, records)
    expect(found.find((entry) => entry.name === "mail.lab.test")?.inScope).toBe(true)
    expect(found.find((entry) => entry.name === "backup.mailhost.invalid")?.inScope).toBe(false)
    expect(found.find((entry) => entry.name === "edge.cdn.invalid")?.inScope).toBe(false)
  })

  test("treats a trailing dot as the same name, not a second one", () => {
    const ns = classifyDelegations(scope, records).filter((entry) => entry.via === "NS")
    expect(ns).toHaveLength(1)
  })

  test("reads delegation out of NS, MX and CNAME only — a TXT or an address is not one", () => {
    const vias = new Set(classifyDelegations(scope, records).map((entry) => entry.via))
    expect([...vias].sort()).toEqual(["CNAME", "MX", "NS"])
  })
})

describe("asking one name for everything it publishes", () => {
  test("reports a type with no records as an answer rather than a failure", async () => {
    const records = await collectRecords("app.lab.test", resolver())
    const cname = records.find((set) => set.type === "CNAME")
    // A resolver reports "publishes no CNAME" by failing the query. That is an
    // answer about the zone, so it carries no error and lands under `absent`.
    expect(cname?.values).toEqual([])
    expect(cname?.error).toBeUndefined()
  })

  test("keeps a query that genuinely broke apart from one with nothing to say", async () => {
    const records = await collectRecords("app.lab.test", resolver({
      resolveNs: () => Promise.reject(Object.assign(new Error("boom"), { code: "ESERVFAIL" })),
    }))
    expect(records.find((set) => set.type === "NS")?.error).toBe("ESERVFAIL")
  })

  test("one failed type does not lose the answers of the others", async () => {
    const records = await collectRecords("app.lab.test", resolver({
      resolveTxt: () => Promise.reject(new Error("nope")),
    }))
    expect(records.find((set) => set.type === "A")?.values).toEqual(["203.0.113.10"])
  })

  test("bounds a type a zone published thousands of", async () => {
    const records = await collectRecords("app.lab.test", resolver({
      resolveTxt: async () => Array.from({ length: 500 }, (_, index) => [`entry-${index}`]),
    }))
    expect(records.find((set) => set.type === "TXT")?.values).toHaveLength(32)
  })

  test("drops an MX with no exchange rather than reporting an empty name", async () => {
    const records = await collectRecords("app.lab.test", resolver({
      resolveMx: async () => [{ priority: 0, exchange: "" }],
    }))
    expect(records.find((set) => set.type === "MX")?.values).toEqual([])
  })
})

describe("the capability", () => {
  test("reports the records, and names the infrastructure outside the engagement", async () => {
    const { result } = await enumerate("app.lab.test")
    const summary = result.summary as {
      host: string
      addresses: string[]
      records: Record<string, string[]>
      absent: string[]
      externalDelegations: string[]
    }
    expect(summary.host).toBe("app.lab.test")
    expect(summary.addresses).toEqual(["203.0.113.10", "2001:db8::1"])
    expect(summary.records.TXT).toEqual(["v=spf1 -all"])
    expect(summary.externalDelegations).toContain("ns1.registrar.invalid")
    expect(summary.externalDelegations).toContain("backup.mailhost.invalid")
    // Approved, so it is a delegation but not an external one.
    expect(summary.externalDelegations).not.toContain("mail.lab.test")
  })

  test("separates a type that answered with nothing from one that failed", async () => {
    const { result } = await enumerate("app.lab.test", resolver({
      resolveNs: () => Promise.reject(Object.assign(new Error("boom"), { code: "ESERVFAIL" })),
    }))
    const summary = result.summary as { absent: string[]; failed: Array<{ type: string; error: string }> }
    // CNAME had nothing to say; NS broke. They must not share a bucket.
    expect(summary.absent).toContain("CNAME")
    expect(summary.failed.map((entry) => entry.type)).toEqual(["NS"])
    expect(summary.failed.find((entry) => entry.type === "NS")?.error).toBe("ESERVFAIL")
  })

  test("stores the whole answer as evidence", async () => {
    const { result, evidence } = await enumerate("app.lab.test")
    expect(result.evidence).toHaveLength(1)
    const content = new TextDecoder().decode(await evidence.read(result.evidence[0]!))
    expect(content).toContain("ns1.registrar.invalid")
    expect(await evidence.verify(result.evidence[0]!)).toBe(true)
  })

  test("refuses a name the manifest never approved", async () => {
    await expect(enumerate("elsewhere.invalid")).rejects.toThrow(/dns\.enum refused/)
  })

  test("refuses a literal address, which publishes no records", async () => {
    const policy: ScopePolicy = { targets: ["203.0.113.10"], excluded: [], capabilities: ["dns.enum"] }
    await expect(enumerate("203.0.113.10", resolver(), policy)).rejects.toThrow(/needs a name, not a literal address/)
  })

  test("refuses a wildcard rather than guessing subdomains", async () => {
    // The scope engine turns a pattern away before the adapter sees it, so what
    // is asserted here is that a wildcard target is refused — not which layer
    // did it. The adapter keeps its own check for the day that rule loosens.
    const policy: ScopePolicy = { targets: ["*.lab.test"], excluded: [], capabilities: ["dns.enum"] }
    await expect(enumerate("*.lab.test", resolver(), policy)).rejects.toThrow(/refused|guessing subdomains/)
  })

  test("says when the answer disagrees with the address the engagement pinned", async () => {
    const { registry } = await enumerate("app.lab.test")
    // Pin a different address, then ask again through the same registry.
    registry.context.pins.set("app.lab.test", pinAddresses("app.lab.test", ["198.51.100.7"]))
    const result = await registry.execute({
      engagementId: "ENG-DNS",
      taskId: "T-2",
      agentId: "recon-1",
      capability: "dns.enum",
      target: "app.lab.test",
      timeoutMs: 20_000,
      maxOutputBytes: 500_000,
      input: {},
    }, new AbortController().signal)
    expect((result.summary as { matchesPin?: boolean }).matchesPin).toBe(false)
  })

  test("leaves the pin set alone: dns.lookup owns it", async () => {
    const { registry } = await enumerate("app.lab.test")
    expect(registry.context.pins.size).toBe(0)
  })
})
