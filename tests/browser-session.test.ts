import { afterAll, describe, expect, test } from "bun:test"
import type { ScopePolicy } from "@cyrion/contracts"
import { CapabilityRegistry, consoleLine, hostsOf, requestDecision } from "@cyrion/capabilities"
import { MemoryEvidenceStore } from "@cyrion/evidence"
import { ContainerToolRunner, LocalToolRunner } from "@cyrion/sandbox"

/**
 * Whether this machine can actually drive a browser.
 *
 * The policy below is proved without one; these gate only the tests that need a
 * real page to render, which is the same bargain the container tests make.
 */
const browserReady = await (async () => {
  try {
    const { chromium } = await import("playwright")
    const browser = await chromium.launch({ headless: true })
    await browser.close()
    return true
  } catch {
    return false
  }
})()

/**
 * A page that reaches for things a scope never approved.
 *
 * The third-party script and image are what a real site is full of, and what
 * makes an unfiltered headless browser leave the engagement on the first load.
 */
const site = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/orders") return Response.json({ orders: [{ id: 1 }] })
    if (url.pathname === "/moved") return new Response(null, { status: 302, headers: { location: "/app" } })
    if (url.pathname === "/app" || url.pathname === "/") {
      return new Response(
        `<!doctype html><html><head><title>Orders</title>`
        + `<script src="https://cdn.tracker.invalid/tag.js"></script></head>`
        + `<body><h1>Orders</h1>`
        + `<img src="https://images.thirdparty.invalid/pixel.png" alt="">`
        + `<script>fetch("/api/orders").catch(() => {}); console.error("boom from the page")</script>`
        + `</body></html>`,
        { headers: { "content-type": "text/html" } },
      )
    }
    return new Response("not found", { status: 404 })
  },
})
const origin = `http://127.0.0.1:${site.port}`
afterAll(() => site.stop(true))

function scopeFor(): ScopePolicy {
  return { targets: [`${origin}/*`], excluded: [], capabilities: ["browser.session"] }
}

async function render(target: string, input: Record<string, unknown> = {}) {
  const evidence = new MemoryEvidenceStore()
  const registry = new CapabilityRegistry({
    runner: new LocalToolRunner({ allowedBinaries: [] }),
    scope: scopeFor(),
    evidence,
    capabilities: ["browser.session"],
  })
  const result = await registry.execute({
    engagementId: "ENG-BROWSER",
    taskId: "T-1",
    agentId: "web-1",
    capability: "browser.session",
    target,
    timeoutMs: 30_000,
    maxOutputBytes: 2_000_000,
    input,
  }, new AbortController().signal)
  return { result, evidence }
}

describe("what a page is allowed to fetch", () => {
  const scope: ScopePolicy = {
    targets: ["https://app.lab.test/*"],
    excluded: ["https://app.lab.test/admin"],
    capabilities: ["browser.session"],
  }

  test("allows a request inside the approved origin", () => {
    expect(requestDecision(scope, "https://app.lab.test/main.js").allowed).toBe(true)
  })

  test("refuses a third-party host, and says why", () => {
    const verdict = requestDecision(scope, "https://cdn.tracker.invalid/tag.js")
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toBeTruthy()
  })

  test("refuses a path the operator excluded, even on an approved host", () => {
    expect(requestDecision(scope, "https://app.lab.test/admin").allowed).toBe(false)
  })

  test("allows the schemes that never leave the machine", () => {
    expect(requestDecision(scope, "data:image/png;base64,AAAA").allowed).toBe(true)
    expect(requestDecision(scope, "about:blank").allowed).toBe(true)
    expect(requestDecision(scope, "blob:https://app.lab.test/x").allowed).toBe(true)
  })

  test("refuses a scheme that is neither, rather than passing it through", () => {
    expect(requestDecision(scope, "file:///etc/passwd").allowed).toBe(false)
    expect(requestDecision(scope, "ws://app.lab.test/socket").allowed).toBe(false)
  })

  test("refuses a URL it cannot parse", () => {
    expect(requestDecision(scope, "http://[not a url").allowed).toBe(false)
  })
})

describe("what the summary is built from", () => {
  test("names each host once, in the order the page reached it", () => {
    expect(hostsOf([
      { url: "https://a.test/1", method: "GET", resourceType: "document", disposition: "allowed" },
      { url: "https://b.test/2", method: "GET", resourceType: "script", disposition: "allowed" },
      { url: "https://a.test/3", method: "GET", resourceType: "xhr", disposition: "allowed" },
    ])).toEqual(["a.test", "b.test"])
  })

  test("strips terminal control out of the page's own console text", () => {
    // An escape sequence in a page's console text would otherwise reach a log.
    expect(consoleLine("error", "boom\u001b[31m\u0000")).toBe("error: boom [31m")
  })

  test("bounds a console line a page could make arbitrarily long", () => {
    expect(consoleLine("error", "x".repeat(5_000)).length).toBeLessThanOrEqual(300)
  })
})

describe("the sandbox the browser is not in", () => {
  test("refuses a container run rather than quietly leaving the allowlist", async () => {
    const registry = new CapabilityRegistry({
      runner: new ContainerToolRunner({
        engine: "docker",
        image: "cyrion/worker:test",
        engagementId: "ENG-BROWSER",
        allowedBinaries: [],
      }),
      scope: scopeFor(),
      evidence: new MemoryEvidenceStore(),
      capabilities: ["browser.session"],
    })
    await expect(registry.execute({
      engagementId: "ENG-BROWSER",
      taskId: "T-1",
      agentId: "web-1",
      capability: "browser.session",
      target: `${origin}/*`,
      timeoutMs: 30_000,
      maxOutputBytes: 2_000_000,
      input: {},
    }, new AbortController().signal)).rejects.toThrow(/--allow-host-browser|--sandbox local/)
  })
})

describe("refusals that do not need a browser", () => {
  test("refuses a target outside the approved scope", async () => {
    await expect(render("http://elsewhere.invalid/")).rejects.toThrow(/browser\.session refused/)
  })

  test("refuses a host target: rendering needs a URL", async () => {
    const registry = new CapabilityRegistry({
      runner: new LocalToolRunner({ allowedBinaries: [] }),
      scope: { targets: ["127.0.0.1", `${origin}/*`], excluded: [], capabilities: ["browser.session"] },
      evidence: new MemoryEvidenceStore(),
      capabilities: ["browser.session"],
    })
    await expect(registry.execute({
      engagementId: "ENG-BROWSER",
      taskId: "T-1",
      agentId: "web-1",
      capability: "browser.session",
      target: "127.0.0.1",
      timeoutMs: 30_000,
      maxOutputBytes: 2_000_000,
      input: {},
    }, new AbortController().signal)).rejects.toThrow(/needs a URL target/)
  })
})

describe.skipIf(!browserReady)("rendering an approved page", () => {
  test("reports the page, and blocks what it reached for outside the scope", async () => {
    const { result } = await render(`${origin}/app`)
    const summary = result.summary as {
      status: number
      title: string
      blocked: number
      blockedHosts: string[]
      hosts: string[]
      endpoints: string[]
      console: string[]
      dom: string
    }
    expect(summary.status).toBe(200)
    expect(summary.title).toBe("Orders")
    expect(summary.dom).toContain("Orders")

    // The third-party script and image were refused before they were sent.
    expect(summary.blocked).toBeGreaterThanOrEqual(2)
    expect(summary.blockedHosts).toContain("cdn.tracker.invalid")
    expect(summary.blockedHosts).toContain("images.thirdparty.invalid")
    expect(summary.hosts).toEqual(["127.0.0.1"])

    // The endpoint the page called after loading — the thing a crawl of the
    // published links would never have found.
    expect(summary.endpoints.some((url) => url.endsWith("/api/orders"))).toBe(true)

    // The page's own error, bounded and labelled.
    expect(summary.console.some((line) => line.includes("boom from the page"))).toBe(true)
  }, 60_000)

  test("captures a screenshot as bytes a viewer could open", async () => {
    const { result, evidence } = await render(`${origin}/app`)
    const shot = result.evidence.find((reference) => reference.contentType === "image/png")
    expect(shot).toBeDefined()
    expect(shot!.uri.endsWith(".png")).toBe(true)
    const bytes = await evidence.read(shot!)
    // A real PNG, not a wall of base64 that merely claims to be one.
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(await evidence.verify(shot!)).toBe(true)
  }, 60_000)

  test("records the redirect it followed and that it stayed in scope", async () => {
    const { result } = await render(`${origin}/moved`)
    const summary = result.summary as { redirected: boolean; finalUrl: string; finalUrlInScope: boolean }
    expect(summary.redirected).toBe(true)
    expect(summary.finalUrl).toBe(`${origin}/app`)
    expect(summary.finalUrlInScope).toBe(true)
  }, 60_000)

  test("skips the screenshot when the task did not ask for one", async () => {
    const { result } = await render(`${origin}/app`, { screenshot: false })
    expect(result.evidence.some((reference) => reference.contentType === "image/png")).toBe(false)
    // The session record and the rendered DOM are still captured.
    expect(result.evidence).toHaveLength(2)
  }, 60_000)

  test("refuses a waitUntil the contract does not define", async () => {
    await expect(render(`${origin}/app`, { waitUntil: "whenever" })).rejects.toThrow(/waitUntil must be/)
  })
})
