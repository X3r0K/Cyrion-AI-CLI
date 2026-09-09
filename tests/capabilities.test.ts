import { afterAll, describe, expect, test } from "bun:test"
import type { ScopePolicy, ToolExecutionRequest } from "@cyrion/contracts"
import {
  CapabilityRegistry,
  capabilityAdapters,
  defaultEvidencePrefix,
  planEgress,
  unservedCapabilities,
} from "@cyrion/capabilities"
import { MemoryEvidenceStore } from "@cyrion/evidence"
import { LocalToolRunner, buildEgressRules, describeEgressRules, toolCatalog } from "@cyrion/sandbox"

const lab = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/away") {
      return new Response("", { status: 302, headers: { location: "https://out-of-scope.example/" } })
    }
    if (path === "/inside") {
      return new Response("", { status: 302, headers: { location: "/landed" } })
    }
    return new Response("<html><title>lab</title></html>", {
      headers: { "content-type": "text/html", server: "cyrion-lab/1.0" },
    })
  },
})
const origin = `http://127.0.0.1:${lab.port}`

afterAll(() => lab.stop(true))

const scope = (targets: string[] = [origin, `127.0.0.1:${lab.port}`]): ScopePolicy => ({
  targets,
  excluded: [],
  capabilities: ["dns.lookup", "http.probe", "net.portscan", "net.tls"],
})

function registryFor(policy: ScopePolicy = scope()): { registry: CapabilityRegistry; store: MemoryEvidenceStore } {
  const store = new MemoryEvidenceStore()
  const registry = new CapabilityRegistry({
    runner: new LocalToolRunner({ allowedBinaries: ["nmap", "openssl"] }),
    scope: policy,
    evidence: store,
    capabilities: policy.capabilities,
  })
  return { registry, store }
}

const request = (capability: string, target: string, input: unknown = {}): ToolExecutionRequest => ({
  engagementId: "ENG-TEST",
  taskId: "T-001",
  agentId: "web-t-001",
  capability,
  target,
  timeoutMs: 15_000,
  maxOutputBytes: 200_000,
  input,
})

describe("capability adapters", () => {
  test("http.probe records the exchange as verifiable evidence", async () => {
    const { registry, store } = registryFor()
    const result = await registry.execute(request("http.probe", origin), AbortSignal.timeout(20_000))
    expect(result.summary.status).toBe(200)
    expect(result.summary.server).toBe("cyrion-lab/1.0")
    expect(result.evidence).toHaveLength(1)

    const reference = result.evidence[0]!
    expect(reference.source).toBe("web-t-001")
    expect(await store.verify(reference)).toBe(true)
    const stored = JSON.parse(new TextDecoder().decode(await store.read(reference)))
    expect(stored.request.method).toBe("GET")
    expect(stored.response.status).toBe(200)
  })

  test("http.probe refuses a target the scope never approved", async () => {
    const { registry } = registryFor()
    expect(registry.execute(request("http.probe", "http://out-of-scope.example/"), AbortSignal.timeout(5_000)))
      .rejects.toThrow(/refused: target is not covered/)
  })

  test("http.probe reports a redirect that leaves scope instead of following it", async () => {
    const { registry } = registryFor()
    const result = await registry.execute(request("http.probe", `${origin}/away`), AbortSignal.timeout(20_000))
    const redirect = result.summary.redirect as { inScope: boolean; reason: string; location: string }
    expect(result.summary.status).toBe(302)
    expect(redirect.inScope).toBe(false)
    expect(redirect.reason).toMatch(/leaves the approved scope/)
  })

  test("http.probe marks an in-scope redirect as followable", async () => {
    const { registry } = registryFor(scope([`${origin}/*`, `127.0.0.1:${lab.port}`]))
    const result = await registry.execute(request("http.probe", `${origin}/inside`), AbortSignal.timeout(20_000))
    expect((result.summary.redirect as { inScope: boolean }).inScope).toBe(true)
  })

  test("http.probe allows only read-shaped methods", async () => {
    const { registry } = registryFor()
    expect(registry.execute(request("http.probe", origin, { method: "DELETE" }), AbortSignal.timeout(5_000)))
      .rejects.toThrow(/GET, HEAD, or OPTIONS/)
  })

  test("dns.lookup pins what a name answered, and passes a literal through", async () => {
    const { registry } = registryFor(scope([...scope().targets, "localhost:80"]))
    const literal = await registry.execute(request("dns.lookup", `127.0.0.1:${lab.port}`), AbortSignal.timeout(10_000))
    expect(literal.summary).toEqual({ host: "127.0.0.1", literal: true, addresses: ["127.0.0.1"] })
    expect(registry.context.pins.get("127.0.0.1")?.addresses).toEqual(["127.0.0.1"])

    const named = await registry.execute(request("dns.lookup", "localhost:80"), AbortSignal.timeout(10_000))
    expect((named.summary.addresses as string[]).length).toBeGreaterThan(0)
    expect(registry.context.pins.has("localhost")).toBe(true)
    expect(named.evidence).toHaveLength(1)
  })

  test("a capability outside the manifest grant is not served at all", async () => {
    const { registry } = registryFor({ ...scope(), capabilities: ["http.probe"] })
    expect(registry.names()).toEqual(["http.probe"])
    expect(registry.execute(request("net.portscan", "127.0.0.1"), AbortSignal.timeout(5_000)))
      .rejects.toThrow(/not available/)
  })

  test("evidence identifiers stay unique across registries for one engagement", () => {
    const first = defaultEvidencePrefix()
    const second = defaultEvidencePrefix()
    expect(first).not.toBe(second)
    expect(first).toMatch(/^E-[a-z0-9]+$/)
  })

  test("builds the container allowlist from the approved scope, before anything runs", async () => {
    const plan = await planEgress({
      targets: ["10.10.0.0/24:443", "127.0.0.1:8080", "https://localhost/api/*", "*.example.test", "./repo"],
      excluded: ["10.10.0.1"],
      capabilities: [],
    })
    const addresses = plan.policy.destinations.map((item) => item.address)
    expect(addresses).toContain("10.10.0.0/24")
    expect(addresses).toContain("127.0.0.1")
    // A wildcard names hosts that do not exist yet, and a repository is not a destination.
    expect(plan.unresolved).toContain("*.example.test")
    expect(addresses).not.toContain("./repo")
    expect(plan.policy.destinations.find((item) => item.address === "10.10.0.0/24")?.ports).toBe("443")
    // localhost resolves, so it is pinned and the pin is what later connections are held to.
    expect(plan.pins.some((pin) => pin.hostname === "localhost")).toBe(true)

    // An exclusion inside an approved range must be dropped before the range is accepted.
    expect(plan.policy.denied).toEqual(["10.10.0.1"])
    const rules = describeEgressRules(buildEgressRules(plan.policy)).split("\n")
    const dropIndex = rules.findIndex((rule) => rule.includes("-d 10.10.0.1 -j DROP"))
    const acceptIndex = rules.findIndex((rule) => rule.includes("-d 10.10.0.0/24"))
    expect(dropIndex).toBeGreaterThan(-1)
    expect(dropIndex).toBeLessThan(acceptIndex)
  })

  test("exposes only granted capabilities as gateway adapters", () => {
    const { registry } = registryFor()
    const adapters = registry.toolAdapters()
    expect(Object.keys(adapters).sort()).toEqual(["dns.lookup", "http.probe", "net.portscan", "net.tls"])
    expect(registry.requiredBinaries().sort()).toEqual(["nmap", "openssl"])
  })
})

describe("capabilities this release can actually serve", () => {
  test("names a granted capability that no adapter implements", () => {
    expect(unservedCapabilities(["dns.lookup", "http.probe"])).toEqual([])
    // Listed in the catalog as the intended shape, but nothing serves it yet.
    expect(unservedCapabilities(["http.probe", "repo.inventory"])).toEqual([])
    // web.fuzz has an adapter now; dns.enum is still catalog-only.
    expect(unservedCapabilities(["http.probe", "web.fuzz", "dns.enum"])).toEqual(["dns.enum"])
    expect(unservedCapabilities(["shell.exec", "python.exec", "vuln.scan", "sqli.test"])).toEqual([])
  })

  test("the catalog marks exactly the capabilities without an adapter", () => {
    const served = new Set(capabilityAdapters.map((adapter) => adapter.capability))
    for (const tool of toolCatalog) {
      // A row that says it works must be backed by something that works.
      expect(tool.planned === true).toBe(!served.has(tool.capability))
    }
  })
})
