import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngagementSnapshot } from "@cyrion/contracts"
import { SQLiteEngagementStore } from "@cyrion/controller"
import { MemoryEvidenceStore } from "@cyrion/evidence"
import {
  CyrionMcpServer,
  FrameReader,
  MCP_CONFIG_VERSION,
  McpStdioClient,
  mcpConfigError,
  ungrantedCapabilities,
  type McpConfig,
} from "@cyrion/mcp"

const projectRoot = join(import.meta.dir, "..")
const cli = join(projectRoot, "apps/cli/src/index.ts")

const evidence = {
  id: "E-001",
  kind: "response" as const,
  uri: "artifact://ENG-MCP/E-001.json",
  sha256: "a".repeat(64),
  capturedAt: "2026-09-08T00:00:00.000Z",
  source: "web-t-001",
  contentType: "application/json",
  sizeBytes: 42,
}

function snapshotFixture(): EngagementSnapshot {
  return {
    manifest: {
      id: "ENG-MCP",
      name: "MCP fixture",
      objective: "Expose an engagement record to another agent.",
      profile: "web-api",
      mode: "autonomous",
      scope: { targets: ["https://app.lab.test/"], excluded: [], capabilities: ["http.probe"] },
      budgets: {
        maxConcurrentAgents: 2, maxAgents: 10, maxDepth: 3, maxTasks: 10,
        maxDurationMs: 60_000, maxTokens: 1_000, maxCostUsd: 1,
      },
    },
    status: "completed",
    startedAt: "2026-09-08T00:00:00.000Z",
    finishedAt: "2026-09-08T00:01:00.000Z",
    agents: [],
    tasks: [],
    findings: [{
      id: "F-001",
      title: "Missing browser protection headers",
      asset: "https://app.lab.test/",
      severity: "low",
      status: "confirmed",
      summary: "The response omits content-security-policy.",
      discoveredBy: "web-t-001",
      validatedBy: "validator-t-002",
      evidenceIds: ["E-001"],
      skillId: "web-security-headers",
      reproduction: {
        verdict: "reproduced",
        bundleId: "E-001",
        steps: 1,
        runner: "local",
        at: "2026-09-08T00:00:30.000Z",
      },
    }, {
      id: "F-002",
      title: "Object endpoint answers an unauthenticated request",
      asset: "https://app.lab.test/",
      severity: "high",
      status: "rejected",
      summary: "The endpoint refused during reproduction.",
      discoveredBy: "api-t-003",
      validatedBy: "validator-t-004",
      evidenceIds: ["E-001"],
    }],
    evidence: [evidence],
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
    events: [],
  }
}

function config(overrides: Partial<McpConfig["servers"][number]> = {}): unknown {
  return {
    version: MCP_CONFIG_VERSION,
    servers: [{
      id: "github",
      command: "mcp-github",
      args: ["--stdio"],
      passEnv: ["GITHUB_TOKEN"],
      tools: [{ tool: "search_code", capability: "repo.search", timeoutMs: 15_000 }],
      ...overrides,
    }],
  }
}

describe("MCP configuration", () => {
  test("accepts an explicit allowlist and maps each tool to a capability", () => {
    expect(mcpConfigError(config())).toBeUndefined()
  })

  test("refuses a credential in the file and points at passEnv instead", () => {
    const error = mcpConfigError(config({ env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz" } }))!
    expect(error).toContain("looks like a credential")
    expect(error).toContain("passEnv")
  })

  test("refuses two tools claiming the same capability", () => {
    const value = config() as { servers: Array<{ tools: unknown[] }> }
    value.servers[0]!.tools.push({ tool: "other_tool", capability: "repo.search" })
    expect(mcpConfigError(value)).toContain("claimed by more than one MCP tool")
  })

  test("names capabilities the manifest never granted", () => {
    const parsed = config() as McpConfig
    expect(ungrantedCapabilities(parsed, ["http.probe"])).toEqual(["repo.search"])
    expect(ungrantedCapabilities(parsed, ["repo.search"])).toEqual([])
  })
})

describe("JSON-RPC framing", () => {
  test("splits on newlines and refuses a frame that would not fit in memory", () => {
    const reader = new FrameReader(64)
    expect(reader.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
    expect(reader.push('{"partial":')).toEqual([])
    expect(() => reader.push("x".repeat(128))).toThrow(/exceeded 64 bytes/)
  })
})

describe("Cyrion as an MCP server", () => {
  function server(options: { start?: boolean } = {}): CyrionMcpServer {
    const store = new MemoryEvidenceStore()
    return new CyrionMcpServer({
      snapshot: () => snapshotFixture(),
      evidence: store,
      ...(options.start
        ? { startEngagement: async () => ({ engagementId: "ENG-MCP", status: "running" }) }
        : {}),
    })
  }

  const call = async (instance: CyrionMcpServer, name: string, args: unknown = {}) => {
    const response = await instance.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
    const payload = response?.result as { content?: Array<{ text: string }>; isError?: boolean }
    return { text: payload?.content?.[0]?.text ?? "", isError: payload?.isError === true }
  }

  test("does not advertise starting an engagement unless the operator enabled it", async () => {
    const readOnly = await server().handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    const names = ((readOnly?.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name)
    expect(names).toEqual(["engagement_status", "list_findings", "get_evidence", "render_report"])

    expect(names).not.toContain("start_engagement")
    // Not merely hidden: an unadvertised tool is refused at the protocol level,
    // so a caller cannot invoke it by knowing its name.
    const refused = await server().handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "start_engagement", arguments: { attestation: "ticket SEC-1042" } },
    })
    expect(refused?.error?.code).toBe(-32601)
    expect(refused?.error?.message).toContain("Unknown or unavailable tool")
    expect(((await server({ start: true }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }))
      ?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toContain("start_engagement")
  })

  test("requires an attestation before starting an engagement", async () => {
    const enabled = server({ start: true })
    expect((await call(enabled, "start_engagement", { attestation: "short" })).isError).toBe(true)
    const started = await call(enabled, "start_engagement", { attestation: "Authorized by ticket SEC-1042" })
    expect(started.isError).toBe(false)
    expect(JSON.parse(started.text)).toEqual({ engagementId: "ENG-MCP", status: "running" })
  })

  test("reports status, scope hash, and reproducibility apart from severity", async () => {
    const status = JSON.parse((await call(server(), "engagement_status")).text)
    expect(status.engagementId).toBe("ENG-MCP")
    expect(status.scopeHash).toMatch(/^[a-f0-9]{64}$/)
    expect(status.summary.confirmed).toBe(1)
    expect(status.summary.reproduced).toBe(1)
    expect(status.severities.high).toBe(0)

    const all = JSON.parse((await call(server(), "list_findings")).text)
    expect(all.count).toBe(2)
    const confirmed = JSON.parse((await call(server(), "list_findings", { status: "confirmed" })).text)
    expect(confirmed.findings.map((finding: { id: string }) => finding.id)).toEqual(["F-001"])
    expect(confirmed.findings[0].reproduction.verdict).toBe("reproduced")
  })

  test("withholds artifact text that no longer matches its digest", async () => {
    const instance = server()
    const metadata = JSON.parse((await call(instance, "get_evidence", { evidenceId: "E-001" })).text)
    expect(metadata.sha256).toBe(evidence.sha256)
    // The memory store holds no such artifact, so verification fails and the
    // body is refused rather than returned unverified.
    expect(metadata.verified).toBe(false)
    const body = JSON.parse((await call(instance, "get_evidence", { evidenceId: "E-001", includeBody: true })).text)
    expect(body.text).toBeUndefined()
    expect(body.note).toContain("no longer matches its digest")

    expect((await call(instance, "get_evidence", { evidenceId: "E-404" })).isError).toBe(true)
  })

  test("renders every report format and refuses an unknown one", async () => {
    const markdown = await call(server(), "render_report", { format: "markdown" })
    expect(markdown.text).toContain("assessment report")
    expect((await call(server(), "render_report", { format: "sarif" })).text).toContain("2.1.0")
    expect((await call(server(), "render_report", { format: "nonsense" })).isError).toBe(true)
  })

  test("answers a malformed frame instead of failing", async () => {
    expect((await server().handle({ jsonrpc: "1.0", method: "x" }))?.error?.message).toContain("jsonrpc")
    expect((await server().handle({ jsonrpc: "2.0", id: 1, method: "does/not/exist" }))?.error?.code).toBe(-32601)
  })
})

describe("a second agent driving Cyrion over stdio", () => {
  test("initializes, lists the read-only tools, and reads the engagement record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyrion-mcp-"))
    try {
      const databasePath = join(directory, "state.sqlite")
      const store = new SQLiteEngagementStore(databasePath, "ENG-MCP")
      store.saveSnapshot(snapshotFixture())
      store.close()

      // The client is Cyrion's own MCP client, so this exercises both directions.
      const client = new McpStdioClient({
        id: "cyrion",
        command: "bun",
        args: ["run", cli, "mcp", "serve", "--state", databasePath, "--engagement", "ENG-MCP",
          "--artifacts", join(directory, "artifacts")],
        cwd: projectRoot,
        startTimeoutMs: 60_000,
        tools: [
          { tool: "engagement_status", capability: "cyrion.status" },
          { tool: "list_findings", capability: "cyrion.findings" },
          { tool: "render_report", capability: "cyrion.report" },
        ],
      })
      try {
        const tools = await client.listTools()
        expect(client.serverInfo?.name).toBe("cyrion-community")
        expect(tools.map((tool) => tool.name)).toContain("engagement_status")
        // get_evidence exists on the server but this client was not allowed it.
        expect(tools.find((tool) => tool.name === "get_evidence")?.allowed).toBe(false)
        expect(client.call("get_evidence", { evidenceId: "E-001" }))
          .rejects.toThrow(/not allowed for MCP server/)

        const status = await client.call("engagement_status", {})
        expect(status.isError).toBe(false)
        expect(JSON.parse(status.text).engagementId).toBe("ENG-MCP")

        const findings = JSON.parse((await client.call("list_findings", { status: "confirmed" })).text)
        expect(findings.findings[0].id).toBe("F-001")

        const report = await client.call("render_report", { format: "markdown" })
        expect(report.text).toContain("MCP fixture")
        expect(report.text).toContain("Scope hash")
      } finally {
        await client.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)
})
