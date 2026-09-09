import { afterAll, describe, expect, test } from "bun:test"
import type { ScopePolicy } from "@cyrion/contracts"
import { CapabilityRegistry } from "@cyrion/capabilities"
import {
  CREDENTIALS_VERSION,
  OperatorCredentials,
  credentialsContractError,
  parseCredentials,
} from "@cyrion/credentials"
import { MemoryEvidenceStore } from "@cyrion/evidence"
import { LocalToolRunner } from "@cyrion/sandbox"

const TOKEN = "s3cret-token-value-9f2a"

function store(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: CREDENTIALS_VERSION,
    credentials: [{ name: "api-token", value: TOKEN, hosts: ["127.0.0.1"], ...overrides }],
  }
}

/** What the server actually received, recorded outside the response it sends. */
const seen: { authorization: string | null } = { authorization: null }

/**
 * Reports back exactly what it was sent.
 *
 * Proving a credential arrived cannot be done from the response alone: the
 * echo is scrubbed on the way back in, so a header Cyrion never sent and one it
 * sent and then scrubbed look identical to the caller. The server records what
 * it saw, which is the only account of the wire that is not itself scrubbed.
 */
const echo = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    seen.authorization = request.headers.get("authorization")
    if (url.pathname === "/echo-body") {
      // A target that reflects the credential into its body: the one route by
      // which a value can escape the socket.
      return new Response(`you sent ${request.headers.get("authorization") ?? "nothing"}`, {
        headers: { "content-type": "text/plain" },
      })
    }
    return Response.json({ authorization: request.headers.get("authorization") ?? null })
  },
})
const origin = `http://127.0.0.1:${echo.port}`
afterAll(() => echo.stop(true))

async function request(input: Record<string, unknown>, credentials?: OperatorCredentials, path = "/api") {
  const scope: ScopePolicy = { targets: [`${origin}/*`], excluded: [], capabilities: ["http.request"] }
  const evidence = new MemoryEvidenceStore()
  const registry = new CapabilityRegistry({
    runner: new LocalToolRunner({ allowedBinaries: [] }),
    scope,
    evidence,
    capabilities: ["http.request"],
    ...(credentials ? { credentials } : {}),
  })
  const result = await registry.execute({
    engagementId: "ENG-CRED",
    taskId: "T-1",
    agentId: "api-1",
    capability: "http.request",
    target: `${origin}/*`,
    timeoutMs: 20_000,
    maxOutputBytes: 500_000,
    input: { path, ...input },
  }, new AbortController().signal)
  return { result, registry, evidence }
}

describe("the store the operator keeps", () => {
  test("reads a well-formed file", () => {
    expect(credentialsContractError(store())).toBeUndefined()
    expect(parseCredentials(store()).size).toBe(1)
  })

  test("requires every credential to say where it may be sent", () => {
    const value = { version: CREDENTIALS_VERSION, credentials: [{ name: "api-token", value: TOKEN }] }
    expect(credentialsContractError(value)).toMatch(/hosts must name 1 to 16 hosts/)
  })

  test("refuses an empty host list rather than reading it as 'anywhere'", () => {
    expect(credentialsContractError(store({ hosts: [] }))).toMatch(/hosts/)
  })

  test("refuses a duplicate name, which would make a reference ambiguous", () => {
    const value = {
      version: CREDENTIALS_VERSION,
      credentials: [
        { name: "api-token", value: TOKEN, hosts: ["a.test"] },
        { name: "api-token", value: "other", hosts: ["b.test"] },
      ],
    }
    expect(credentialsContractError(value)).toMatch(/defined twice/)
  })

  test("refuses an unknown field and a wrong version", () => {
    expect(credentialsContractError(store({ scope: "everything" }))).toMatch(/unexpected field scope/)
    expect(credentialsContractError({ version: "other", credentials: [] })).toMatch(/version must be/)
  })

  test("never puts a value in what it lists", () => {
    const listed = JSON.stringify(parseCredentials(store({ description: "read-only" })).list())
    expect(listed).toContain("api-token")
    expect(listed).not.toContain(TOKEN)
  })
})

describe("where a credential may go", () => {
  const credentials = parseCredentials(store({ hosts: ["app.lab.test", "*.api.lab.test"] }))

  test("substitutes for a host it is bound to", () => {
    expect(credentials.resolve("Bearer ${cred:api-token}", "https://app.lab.test/x")).toBe(`Bearer ${TOKEN}`)
  })

  test("refuses a host it is not bound to, and says which it is", () => {
    expect(() => credentials.resolve("Bearer ${cred:api-token}", "https://elsewhere.test/x"))
      .toThrow(/not allowed to be sent to elsewhere\.test/)
  })

  test("a wildcard covers what is under it, not the name beside it", () => {
    expect(credentials.resolve("${cred:api-token}", "https://v2.api.lab.test/")).toBe(TOKEN)
    expect(() => credentials.resolve("${cred:api-token}", "https://api.lab.test/")).toThrow(/not allowed/)
  })

  test("fails on a name nobody defined rather than sending an empty header", () => {
    expect(() => credentials.resolve("Bearer ${cred:missing}", "https://app.lab.test/"))
      .toThrow(/No credential named "missing"/)
  })

  test("finds every reference in a string", () => {
    expect(OperatorCredentials.references("Basic ${cred:a} ${cred:b}")).toEqual(["a", "b"])
    expect(OperatorCredentials.references("Bearer literal")).toEqual([])
  })
})

describe("scrubbing what a target sends back", () => {
  test("replaces an echoed value with the name it was sent under", () => {
    const credentials = parseCredentials(store())
    expect(credentials.scrub(`the token is ${TOKEN} ok`)).toBe("the token is ${cred:api-token} ok")
  })

  test("leaves a credential the operator explicitly exposed", () => {
    const credentials = parseCredentials(store({ exposeToModel: true }))
    expect(credentials.scrub(`the token is ${TOKEN}`)).toContain(TOKEN)
  })

  test("does not blank unrelated text for a very short secret", () => {
    const credentials = parseCredentials(store({ value: "ab" }))
    expect(credentials.scrub("a cab and a cabinet")).toBe("a cab and a cabinet")
  })
})

describe("a credential on a real request", () => {
  test("reaches the target, and the artifact records the name instead", async () => {
    const credentials = parseCredentials(store())
    const { result, evidence } = await request(
      { headers: { authorization: "Bearer ${cred:api-token}" } },
      credentials,
    )
    const summary = result.summary as { status: number; body: string }
    // The target received the real credential. Asserted from what the server
    // recorded rather than from what it echoed back, because the echo is
    // scrubbed on the way in and would prove nothing either way.
    expect(summary.status).toBe(200)
    expect(seen.authorization).toBe(`Bearer ${TOKEN}`)

    // And the stored exchange holds the reference rather than a copy of it.
    expect(result.evidence.length).toBeGreaterThan(0)
    for (const reference of result.evidence) {
      const content = new TextDecoder().decode(await evidence.read(reference))
      expect(content).not.toContain(TOKEN)
      expect(content).toContain("${cred:api-token}")
    }
  })

  test("scrubs a credential the target echoed into its body", async () => {
    const credentials = parseCredentials(store())
    const { result } = await request(
      { headers: { authorization: "Bearer ${cred:api-token}" } },
      credentials,
      "/echo-body",
    )
    const summary = result.summary as { body: string }
    expect(summary.body).not.toContain(TOKEN)
    expect(summary.body).toContain("${cred:api-token}")
  })

  test("refuses to carry a credential to a host it is not bound to", async () => {
    const credentials = parseCredentials(store({ hosts: ["somewhere.else.test"] }))
    await expect(request({ headers: { authorization: "Bearer ${cred:api-token}" } }, credentials))
      .rejects.toThrow(/not allowed to be sent to 127\.0\.0\.1/)
  })

  test("fails naming the credential when no store was loaded", async () => {
    await expect(request({ headers: { authorization: "Bearer ${cred:api-token}" } }))
      .rejects.toThrow(/references the credential "api-token"/)
  })

  test("leaves a request that names no credential exactly as it was", async () => {
    await request({ headers: { authorization: "Bearer literal-value" } })
    expect(seen.authorization).toBe("Bearer literal-value")
  })
})
