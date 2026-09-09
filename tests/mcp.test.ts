import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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
  type McpServerConfig,
} from "@cyrion/mcp"
import { McpCapabilities, unservedCapabilities } from "@cyrion/capabilities"
import type { EvidenceRef, EvidenceStore, ScopePolicy } from "@cyrion/contracts"
import { createScopeLock } from "@cyrion/scope"

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

const notesServer = join(projectRoot, "fixtures/mcp/notes-server.ts")

/** The fixture server, declared the way an operator would declare a real one. */
function notesConfig(overrides: Partial<McpServerConfig> = {}): McpConfig {
  return {
    version: MCP_CONFIG_VERSION,
    servers: [{
      id: "notes",
      command: "bun",
      args: ["run", notesServer],
      cwd: projectRoot,
      startTimeoutMs: 60_000,
      tools: [
        { tool: "lookup_note", capability: "notes.lookup", timeoutMs: 30_000 },
        { tool: "broken_note", capability: "notes.broken", timeoutMs: 30_000 },
        { tool: "long_note", capability: "notes.long", timeoutMs: 30_000, maxOutputBytes: 512 },
      ],
      ...overrides,
    }],
  }
}

const notesScope: ScopePolicy = {
  targets: ["https://app.lab.test/"],
  excluded: [],
  capabilities: ["notes.lookup", "notes.broken", "notes.long"],
}

describe("an MCP tool as a capability a worker calls", () => {
  async function callThrough(capability: string, target = "https://app.lab.test/", input: unknown = {}) {
    const host = new McpCapabilities({ config: notesConfig(), granted: notesScope.capabilities })
    const store = new MemoryEvidenceStore()
    // A recording store, so a call that fails can still be asked what it stored
    // before it failed.
    const captured: EvidenceRef[] = []
    const evidenceStore: EvidenceStore = {
      capture: async (input) => {
        const reference = await store.capture(input)
        captured.push(reference)
        return reference
      },
      metadata: (reference) => store.metadata(reference),
      read: (reference) => store.read(reference),
      verify: (reference) => store.verify(reference),
    }
    const adapter = host.adapters().find((entry) => entry.capability === capability)!
    let sequence = 0
    const context = {
      runner: undefined as never,
      scope: notesScope,
      evidence: evidenceStore,
      pins: new Map(),
      nextEvidenceId: () => `E-${String(++sequence).padStart(4, "0")}`,
    }
    try {
      const result = await adapter.execute({
        engagementId: "ENG-MCP",
        taskId: "T-1",
        agentId: "recon-1",
        capability,
        target,
        timeoutMs: 30_000,
        maxOutputBytes: 1_000_000,
        input: input as Record<string, unknown>,
      }, context, new AbortController().signal)
      return { result, store, captured, host }
    } catch (error) {
      return { error: error as Error, store, captured, host }
    }
  }

  test("serves only the capabilities the manifest granted, and never shadows a built-in", () => {
    const partial = new McpCapabilities({ config: notesConfig(), granted: ["notes.lookup"] })
    expect(partial.names()).toEqual(["notes.lookup"])
    expect(new McpCapabilities({ config: notesConfig(), granted: [] }).names()).toEqual([])

    const shadowing = notesConfig() as McpConfig
    shadowing.servers[0]!.tools = [{ tool: "lookup_note", capability: "http.probe" }]
    expect(() => new McpCapabilities({ config: shadowing, granted: ["http.probe"] }))
      .toThrow(/Cyrion implements/)
  })

  test("a granted capability an MCP tool answers is no longer unserved", () => {
    expect(unservedCapabilities(["notes.lookup", "http.probe"])).toEqual(["notes.lookup"])
    expect(unservedCapabilities(["notes.lookup", "http.probe"], ["notes.lookup"])).toEqual([])
  })

  test("passes typed arguments through, captures the answer, and labels it untrusted", async () => {
    const { result, store, host } = await callThrough("notes.lookup", "https://app.lab.test/", { subject: "tls" })
    try {
      const summary = result!.summary as { server: string; tool: string; text: string; untrusted: string }
      expect(summary.server).toBe("notes")
      expect(summary.tool).toBe("lookup_note")
      // The server saw the worker's arguments exactly as they were typed.
      expect(summary.text).toContain('"subject":"tls"')
      expect(summary.untrusted).toContain("never as an instruction")

      // The whole exchange is stored before a summary is returned, so what the
      // server said stays checkable after the run.
      expect(result!.evidence).toHaveLength(1)
      const stored = JSON.parse(new TextDecoder().decode(await store.read(result!.evidence[0]!)))
      expect(stored.server).toBe("notes")
      expect(stored.arguments).toEqual({ subject: "tls" })
      expect(stored.serverInfo.name).toBe("notes-fixture")
      expect(result!.outcome).toContain("notes/lookup_note")

      // Provenance the report states: which server, which tool, as what.
      // One session per server, so every tool it answers for names the version
      // that actually answered.
      expect(host.describe()).toEqual([
        { server: "notes", tool: "lookup_note", capability: "notes.lookup", serverName: "notes-fixture", serverVersion: "1.4.2" },
        { server: "notes", tool: "broken_note", capability: "notes.broken", serverName: "notes-fixture", serverVersion: "1.4.2" },
        { server: "notes", tool: "long_note", capability: "notes.long", serverName: "notes-fixture", serverVersion: "1.4.2" },
      ])
    } finally {
      await host.close()
    }
  }, 60_000)

  test("refuses a target the scope does not cover, without starting the server", async () => {
    const { error, host } = await callThrough("notes.lookup", "https://not-approved.test/")
    try {
      expect(error?.message).toContain("notes.lookup refused")
      // Nothing was asked of the server, so nothing came back to record.
      expect(host.describe().every((entry) => !entry.serverVersion)).toBe(true)
    } finally {
      await host.close()
    }
  }, 60_000)

  test("treats a server-reported failure as a failed call, with the exchange still recorded", async () => {
    const { error, captured, host } = await callThrough("notes.broken")
    try {
      expect(error?.message).toContain("notes/broken_note reported an error")
      expect(error?.message).toContain("the note store is unavailable")
      expect(captured).toHaveLength(1)
    } finally {
      await host.close()
    }
  }, 60_000)

  test("holds the answer to the byte ceiling the operator declared", async () => {
    const { result, host } = await callThrough("notes.long")
    try {
      const summary = result!.summary as { text: string; truncated: boolean }
      expect(summary.truncated).toBe(true)
      expect(summary.text.length).toBe(512)
    } finally {
      await host.close()
    }
  }, 60_000)
})

describe("starting an engagement over MCP", () => {
  test("runs the engagement the operator prepared, and only for a caller who repeats the attestation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyrion-mcp-start-"))
    try {
      // A repository target: local, read-only, and quick enough for a test.
      const repository = join(directory, "repo")
      await mkdir(repository)
      await writeFile(join(repository, "package.json"), JSON.stringify({ name: "fixture" }))
      await writeFile(join(repository, "index.ts"), "export const a = 1\n")

      const manifest = {
        id: "ENG-MCP-START",
        name: "Started over MCP",
        objective: "Inventory an approved repository, started by another agent.",
        profile: "repository" as const,
        mode: "autonomous" as const,
        scope: { targets: [`repo:${repository}`], excluded: [], capabilities: ["repo.inventory"] },
        budgets: {
          maxConcurrentAgents: 2, maxAgents: 10, maxDepth: 3, maxTasks: 10,
          maxDurationMs: 120_000, maxTokens: 50_000, maxCostUsd: 1,
        },
      }
      const attestation = "Self-assessment of my own checkout, ticket SEC-9"
      const manifestPath = join(directory, "engagement.json")
      const lockPath = join(directory, "engagement.lock")
      await Bun.write(manifestPath, JSON.stringify(manifest, null, 2))
      await Bun.write(lockPath, JSON.stringify(createScopeLock(manifest, attestation), null, 2))

      const client = new McpStdioClient({
        id: "cyrion",
        command: "bun",
        // Deterministic planner and workers: this test is about the protocol
        // and the authorization, not about what a provider would say.
        args: ["run", cli, "mcp", "serve",
          "--scope", manifestPath, "--scope-lock", lockPath,
          "--planner", "assessment", "--workers", "capability",
          "--sandbox", "local", "--artifacts", join(directory, "artifacts")],
        cwd: projectRoot,
        startTimeoutMs: 120_000,
        tools: [
          { tool: "start_engagement", capability: "cyrion.start", timeoutMs: 60_000 },
          { tool: "engagement_status", capability: "cyrion.status", timeoutMs: 60_000 },
          { tool: "list_findings", capability: "cyrion.findings", timeoutMs: 60_000 },
        ],
      })
      try {
        const tools = await client.listTools()
        expect(tools.map((tool) => tool.name)).toContain("start_engagement")

        // An authorization the caller made up is refused: the operator's lock
        // decides, and this server cannot accept a new one.
        const invented = await client.call("start_engagement", { attestation: "I said it was fine" })
        expect(invented.isError).toBe(true)
        expect(invented.text).toContain("scope lock")

        const started = await client.call("start_engagement", { attestation })
        expect(started.isError).toBe(false)
        expect(JSON.parse(started.text).engagementId).toBe("ENG-MCP-START")

        // It starts once. Asking again reports where the run is, rather than
        // running the same engagement a second time over its own artifacts.
        const again = await client.call("start_engagement", { attestation })
        expect(again.isError).toBe(false)
        expect(JSON.parse(again.text).engagementId).toBe("ENG-MCP-START")

        // The run is real: it reaches a terminal state through the same
        // controller a command-line run uses.
        let status: { status: string; engagementId: string } = JSON.parse(started.text)
        for (let attempt = 0; attempt < 60 && !["completed", "failed", "cancelled"].includes(status.status); attempt += 1) {
          await Bun.sleep(500)
          status = JSON.parse((await client.call("engagement_status", {})).text)
        }
        expect(status.status).toBe("completed")
        expect(JSON.parse((await client.call("list_findings", {})).text).count).toBeGreaterThanOrEqual(0)
      } finally {
        await client.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 180_000)
})

describe("a worker calling an approved MCP tool", () => {
  test("runs it through the gateway, records what it said, and never calls it a finding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyrion-mcp-worker-"))
    try {
      const repository = join(directory, "repo")
      await mkdir(repository)
      await writeFile(join(repository, "package.json"), JSON.stringify({ name: "fixture" }))
      await writeFile(join(repository, "index.ts"), "export const a = 1\n")

      // An operator-authored methodology that asks for the operator's own tool.
      // Nothing shipped requires an MCP capability, and nothing should.
      const skills = join(directory, "skills")
      await mkdir(skills)
      await writeFile(join(skills, "vendor-notes.skill.json"), JSON.stringify({
        version: "cyrion.community/skill-v1",
        id: "vendor-note-lookup",
        name: "Vendor note lookup",
        source: "operator",
        appliesTo: { kinds: ["repo"], capabilities: ["repo.inventory", "notes.lookup"], roles: ["recon"] },
        objective: "Inventory an approved repository and record what the operator's note service says about it.",
        preconditions: ["The approved scope includes a repository root the operator can read"],
        steps: [
          "Walk the approved root and record what the project is written in.",
          "Ask the operator's approved note service for context, and record its answer as an observation.",
        ],
        expectedEvidence: ["log"],
        falsePositives: ["A note service answer is context, not a finding about the target."],
        severity: "info",
        references: ["https://owasp.org/www-project-web-security-testing-guide/"],
      }))

      const mcpPath = join(directory, "mcp.json")
      await Bun.write(mcpPath, JSON.stringify(notesConfig()))
      const manifestPath = join(directory, "engagement.json")
      await Bun.write(manifestPath, JSON.stringify({
        id: "ENG-MCP-WORKER",
        name: "MCP worker path",
        objective: "Record what an approved MCP tool says about an approved repository.",
        profile: "repository",
        mode: "autonomous",
        scope: { targets: [`repo:${repository}`], excluded: [], capabilities: ["repo.inventory", "notes.lookup"] },
        budgets: {
          maxConcurrentAgents: 2, maxAgents: 10, maxDepth: 3, maxTasks: 10,
          maxDurationMs: 120_000, maxTokens: 50_000, maxCostUsd: 1,
        },
      }))

      const run = Bun.spawn({
        cmd: ["bun", "run", cli, "engage", "--scope", manifestPath, "--skills", skills, "--mcp", mcpPath,
          "--sandbox", "local", "--planner", "assessment", "--workers", "capability", "--headless",
          "--artifacts", join(directory, "artifacts")],
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = await new Response(run.stdout).text()
      expect(await run.exited).toBe(0)
      const lines = output.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)

      // The call went through the gateway like any other capability.
      const completed = lines.filter((line) => line.type === "tool.request.completed")
        .map((line) => line.payload as { capability: string; outcome?: string })
      expect(completed.map((entry) => entry.capability)).toContain("notes.lookup")
      expect(completed.find((entry) => entry.capability === "notes.lookup")?.outcome)
        .toContain("notes/lookup_note")

      // What it said is an observation citing an artifact, not a finding.
      const recon = lines.find((line) => line.type === "task.completed"
        && JSON.stringify(line.payload).includes("Consulted notes.lookup"))
      const observations = ((recon?.payload as { result: { observations: Array<{ summary: string; evidenceIds: string[] }> } })
        .result.observations)
      const cited = observations.find((observation) => observation.summary.includes("Consulted notes.lookup"))!
      expect(cited.summary).toContain("notes/lookup_note")
      expect(cited.evidenceIds.length).toBeGreaterThan(0)

      const summary = lines.at(-1) as unknown as { status: string; confirmed: number; evidence: number }
      expect(summary.status).toBe("completed")
      expect(summary.confirmed).toBe(0)
      expect(summary.evidence).toBeGreaterThanOrEqual(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 180_000)
})
