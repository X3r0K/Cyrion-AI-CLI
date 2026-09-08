import { describe, expect, test } from "bun:test"
import type { ScopePolicy } from "@cyrion/contracts"
import {
  canonicalScope,
  canonicalTarget,
  checkPinnedAddress,
  checkRedirect,
  createScopeLock,
  evaluateAddress,
  evaluateScope,
  parseTarget,
  pinAddresses,
  scopeHash,
  scopePolicyError,
  targetExpressionError,
  verifyScopeLock,
} from "@cyrion/scope"

const policy = (targets: string[], excluded: string[] = []): ScopePolicy => ({
  targets,
  excluded,
  capabilities: ["http.request"],
})

const allowed = (scope: ScopePolicy, candidate: string): boolean => evaluateScope(scope, candidate).allowed
const denial = (scope: ScopePolicy, candidate: string): string =>
  String(evaluateScope(scope, candidate).reason ?? "")

describe("target expressions", () => {
  test("infers the kind from the syntax and canonicalizes it", () => {
    expect(canonicalTarget(parseTarget("demo.lab.test"))).toBe("host:demo.lab.test")
    expect(canonicalTarget(parseTarget("10.10.0.0/24:22,80,8000-8100")))
      .toBe("host:10.10.0.0/24:22,80,8000-8100")
    expect(canonicalTarget(parseTarget("HTTPS://App.Example.Test/api/*")))
      .toBe("url:https://app.example.test/api/*")
    expect(canonicalTarget(parseTarget("./services/api/"))).toBe("repo:./services/api")
    expect(canonicalTarget(parseTarget("[2001:db8::1]:443"))).toBe("host:2001:db8::1:443")
  })

  test("refuses expressions that would quietly widen a scope", () => {
    expect(targetExpressionError("https://user:pass@app.test")).toMatch(/credentials/)
    expect(targetExpressionError("https://app.test/api?x=1")).toMatch(/query/)
    expect(targetExpressionError("https://app.test/../admin")).toMatch(/relative/)
    expect(targetExpressionError("repo:../../etc")).toMatch(/relative/)
    expect(targetExpressionError("*.10.0.0.1")).toMatch(/cannot carry a wildcard/)
    expect(targetExpressionError("10.0.0.0/33")).toMatch(/CIDR notation is invalid/)
    expect(targetExpressionError("host.test:0")).toMatch(/out of bounds/)
    expect(targetExpressionError("host.test:70000")).toMatch(/out of bounds/)
    expect(targetExpressionError("ftp://host.test")).toMatch(/scheme "ftp" is not supported/)
    expect(scopePolicyError(policy(["ok.test", "10.0.0.0/33"]))).toMatch(/scope.targets/)
    expect(scopePolicyError(policy(["ok.test"], ["nope::/x"]))).toMatch(/scope.excluded/)
  })
})

describe("host and CIDR scope", () => {
  test("admits addresses inside an approved range and nothing outside it", () => {
    const scope = policy(["10.10.0.0/24"])
    expect(allowed(scope, "10.10.0.7")).toBe(true)
    expect(allowed(scope, "10.10.0.255")).toBe(true)
    expect(allowed(scope, "10.10.1.1")).toBe(false)
    expect(allowed(scope, "10.9.255.255")).toBe(false)
    expect(denial(scope, "10.10.1.1")).toMatch(/not covered/)
  })

  test("lets an exclusion carve a host out of an approved range", () => {
    const scope = policy(["10.10.0.0/24"], ["10.10.0.1"])
    expect(allowed(scope, "10.10.0.2")).toBe(true)
    expect(allowed(scope, "10.10.0.1")).toBe(false)
    expect(denial(scope, "10.10.0.1")).toMatch(/excluded/)
  })

  test("admits a sub-range but never a wider one", () => {
    const scope = policy(["10.10.0.0/16"])
    expect(allowed(scope, "10.10.4.0/24")).toBe(true)
    expect(allowed(scope, "10.0.0.0/8")).toBe(false)
  })

  test("treats a wildcard as subdomains only, never the apex or a sibling", () => {
    const scope = policy(["*.example.test"])
    expect(allowed(scope, "api.example.test")).toBe(true)
    expect(allowed(scope, "deep.api.example.test")).toBe(true)
    expect(allowed(scope, "example.test")).toBe(false)
    expect(allowed(scope, "notexample.test")).toBe(false)
    expect(allowed(scope, "example.test.evil.test")).toBe(false)
  })

  test("enforces declared ports and reports what the entry permits", () => {
    const scope = policy(["10.10.0.5:22,8000-8100"])
    expect(allowed(scope, "10.10.0.5:22")).toBe(true)
    expect(allowed(scope, "10.10.0.5:8050")).toBe(true)
    expect(allowed(scope, "10.10.0.5:80")).toBe(false)
    expect(allowed(scope, "10.10.0.5:8000-8200")).toBe(false)
    expect(evaluateScope(scope, "10.10.0.5:22").allowedPorts).toBe("22,8000-8100")
    expect(evaluateScope(scope, "10.10.0.5").allowed).toBe(true)
    expect(evaluateScope(scope, "10.10.0.5", { requirePort: true }).allowed).toBe(false)
  })

  test("keeps host, url, and repo kinds apart", () => {
    expect(allowed(policy(["https://app.test"]), "app.test")).toBe(false)
    expect(allowed(policy(["app.test"]), "https://app.test/")).toBe(false)
    expect(allowed(policy(["./repo"]), "repo")).toBe(false)
  })

  test("supports IPv6 ranges", () => {
    const scope = policy(["2001:db8::/32"])
    expect(allowed(scope, "2001:db8:1234::5")).toBe(true)
    expect(allowed(scope, "2001:db9::1")).toBe(false)
  })
})

describe("url scope", () => {
  test("a bare origin covers the origin, and a path prefix covers only its subtree", () => {
    expect(allowed(policy(["https://app.test"]), "https://app.test/anything/here")).toBe(true)
    const scoped = policy(["https://app.test/api/*"])
    expect(allowed(scoped, "https://app.test/api/users")).toBe(true)
    expect(allowed(scoped, "https://app.test/admin")).toBe(false)
    expect(allowed(policy(["https://app.test/health"]), "https://app.test/health/deep")).toBe(false)
  })

  test("separates scheme and port rather than assuming either", () => {
    expect(allowed(policy(["https://app.test"]), "http://app.test/")).toBe(false)
    expect(allowed(policy(["https://app.test"]), "https://app.test:8443/")).toBe(false)
    expect(allowed(policy(["https://app.test:8443"]), "https://app.test:8443/x")).toBe(true)
    expect(allowed(policy(["https://app.test"]), "https://app.test:443/x")).toBe(true)
  })
})

describe("repository scope", () => {
  test("admits the root and its subtree only", () => {
    const scope = policy(["./services/api"])
    expect(allowed(scope, "./services/api")).toBe(true)
    expect(allowed(scope, "./services/api/src/main.ts")).toBe(true)
    expect(allowed(scope, "./services/apikeys")).toBe(false)
    expect(allowed(scope, "./services")).toBe(false)
  })
})

describe("redirects", () => {
  const scope = policy(["https://app.test/*"], ["https://app.test/logout"])

  test("follows an in-scope redirect and refuses one that leaves", () => {
    expect(checkRedirect(scope, "https://app.test/a", "https://app.test/b").allowed).toBe(true)
    const escape = checkRedirect(scope, "https://app.test/a", "https://evil.test/b")
    expect(escape.allowed).toBe(false)
    expect(escape.reason).toMatch(/leaves the approved scope/)
  })

  test("refuses a transport downgrade unless it is accepted explicitly", () => {
    const downgrade = checkRedirect(policy(["https://app.test/*", "http://app.test/*"]), "https://app.test/a", "http://app.test/a")
    expect(downgrade.allowed).toBe(false)
    expect(downgrade.reason).toMatch(/downgrades https to http/)
    expect(
      checkRedirect(policy(["https://app.test/*", "http://app.test/*"]), "https://app.test/a", "http://app.test/a", { allowDowngrade: true }).allowed,
    ).toBe(true)
  })

  test("honours an exclusion on the redirect destination", () => {
    expect(checkRedirect(scope, "https://app.test/a", "https://app.test/logout").allowed).toBe(false)
  })
})

describe("DNS pinning", () => {
  test("admits a pinned address and refuses one that appeared later", () => {
    const pin = pinAddresses("app.test", ["93.184.216.34", "93.184.216.35"])
    expect(pin.addresses).toEqual(["93.184.216.34", "93.184.216.35"])
    expect(checkPinnedAddress(pin, "93.184.216.34").allowed).toBe(true)
    const late = checkPinnedAddress(pin, "203.0.113.9")
    expect(late.allowed).toBe(false)
    expect(late.reason).toMatch(/was not pinned/)
  })

  test("names rebinding when a public host suddenly points inward", () => {
    const pin = pinAddresses("app.test", ["93.184.216.34"])
    const rebind = checkPinnedAddress(pin, "127.0.0.1")
    expect(rebind.allowed).toBe(false)
    expect(rebind.reason).toMatch(/DNS rebinding/)

    const localPin = pinAddresses("lab.internal", ["10.0.0.5"])
    expect(String(checkPinnedAddress(localPin, "10.0.0.6").reason)).toMatch(/was not pinned/)
  })

  test("refuses to pin nothing", () => {
    expect(() => pinAddresses("app.test", [])).toThrow(/no addresses/)
    expect(() => pinAddresses("app.test", ["not-an-address"])).toThrow(/not an IP address/)
  })
})

describe("egress addresses", () => {
  test("checks a connection address against host entries only", () => {
    const scope = policy(["10.10.0.0/24", "https://app.test"], ["10.10.0.1"])
    expect(evaluateAddress(scope, "10.10.0.9").allowed).toBe(true)
    expect(evaluateAddress(scope, "10.10.0.1").allowed).toBe(false)
    expect(evaluateAddress(scope, "8.8.8.8").allowed).toBe(false)
    expect(evaluateAddress(scope, "app.test").allowed).toBe(false)
  })
})

describe("scope lock", () => {
  const manifest = {
    id: "ENG-0042",
    name: "n",
    objective: "o",
    profile: "web-api" as const,
    mode: "autonomous" as const,
    scope: policy(["10.10.0.0/24", "https://app.test/api/*"], ["10.10.0.1"]),
    budgets: {
      maxConcurrentAgents: 1, maxAgents: 2, maxDepth: 1, maxTasks: 2,
      maxDurationMs: 1000, maxTokens: 10, maxCostUsd: 1,
    },
  }

  test("is stable under reordering and sensitive to any real change", () => {
    const reordered = { ...manifest, scope: policy(["https://app.test/api/*", "10.10.0.0/24"], ["10.10.0.1"]) }
    expect(scopeHash(reordered.scope)).toBe(scopeHash(manifest.scope))
    expect(canonicalScope(manifest.scope)).toContain("host:10.10.0.0/24")

    const widened = { ...manifest, scope: policy(["10.10.0.0/16", "https://app.test/api/*"], ["10.10.0.1"]) }
    expect(scopeHash(widened.scope)).not.toBe(scopeHash(manifest.scope))
  })

  test("holds for the scope it was written for and fails for any other", () => {
    const lock = createScopeLock(manifest, "Authorized by the platform team, ticket SEC-1042")
    expect(verifyScopeLock(lock, manifest)).toBeUndefined()

    const widened = { ...manifest, scope: policy(["10.10.0.0/16"], []) }
    expect(verifyScopeLock(lock, widened)).toMatch(/does not match the current scope/)
    expect(verifyScopeLock(lock, { ...manifest, id: "ENG-OTHER" })).toMatch(/written for engagement/)
    expect(verifyScopeLock({ ...lock, attestation: "x" }, manifest)).toMatch(/attestation is invalid/)
    expect(verifyScopeLock({ ...lock, version: "other" }, manifest)).toMatch(/unsupported lock version/)
    expect(() => createScopeLock(manifest, "  ")).toThrow(/who authorized/)
  })
})
