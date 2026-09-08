import { describe, expect, test } from "bun:test"
import {
  AnthropicClient,
  LlmRootReviewer,
  LlmWorkerReviewer,
  OllamaClient,
  OpenAiCompatibleClient,
  createClient,
  modelConfigError,
  probeReadiness,
  readEnvironmentConfig,
  redact,
  type ModelConfig,
  type ModelEndpoint,
} from "@cyrion/llm"
import { CONTRACT_VERSION, type EngagementSnapshot, type RootDecision } from "@cyrion/contracts"
import { MemoryEvidenceStore } from "@cyrion/evidence"

interface Fake {
  endpoint: ModelEndpoint
  requests: Array<{ path: string; body: any }>
  stop(): void
}

function serve(handler: (path: string, body: any) => Response): Fake {
  const requests: Fake["requests"] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined
      requests.push({ path, body })
      return handler(path, body)
    },
  })
  return {
    endpoint: { id: "local", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${server.port}` },
    requests,
    stop: () => server.stop(true),
  }
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: { verdict: { enum: ["accept", "stop"] } },
} as const

describe("model configuration", () => {
  test("refuses cleartext transport to a remote endpoint unless accepted explicitly", () => {
    const remote = (allowInsecure?: boolean): unknown => ({
      endpoints: [{ id: "remote", kind: "openai-compatible", baseUrl: "http://example.test/v1", ...(allowInsecure === undefined ? {} : { allowInsecure }) }],
      roles: { planner: { endpoint: "remote", model: "m" } },
    })
    expect(modelConfigError(remote())).toMatch(/cleartext/)
    expect(modelConfigError(remote(true))).toBeUndefined()
    expect(modelConfigError({
      endpoints: [{ id: "local", kind: "ollama", baseUrl: "http://127.0.0.1:11434" }],
      roles: { planner: { endpoint: "local", model: "qwen3" } },
    })).toBeUndefined()
  })

  test("rejects unknown endpoints, unknown roles, and embedded credentials", () => {
    expect(modelConfigError({
      endpoints: [{ id: "a", kind: "openai-compatible", baseUrl: "https://api.test/v1" }],
      roles: { planner: { endpoint: "b", model: "m" } },
    })).toMatch(/not defined/)
    expect(modelConfigError({
      endpoints: [{ id: "a", kind: "openai-compatible", baseUrl: "https://api.test/v1" }],
      roles: { hacker: { endpoint: "a", model: "m" } },
    })).toMatch(/unsupported role/)
    expect(modelConfigError({
      endpoints: [{ id: "a", kind: "openai-compatible", baseUrl: "https://user:pass@api.test/v1" }],
      roles: { planner: { endpoint: "a", model: "m" } },
    })).toMatch(/credentials/)
  })

  test("builds a single-endpoint configuration from two environment variables", () => {
    const config = readEnvironmentConfig({
      CYRION_LLM_BASE_URL: "http://127.0.0.1:11434",
      CYRION_LLM_MODEL: "qwen3:14b",
      CYRION_LLM_KIND: "ollama",
    })
    expect(config?.endpoints[0]?.kind).toBe("ollama")
    expect(config?.roles.planner?.model).toBe("qwen3:14b")
    expect(config?.roles.validator?.model).toBe("qwen3:14b")
    expect(readEnvironmentConfig({ CYRION_LLM_BASE_URL: "http://127.0.0.1:11434" })).toBeUndefined()
  })
})

describe("openai-compatible client", () => {
  test("falls down the structured-output ladder and remembers the mode that worked", async () => {
    const fake = serve((path, body) => {
      if (path !== "/chat/completions") return json({}, 404)
      if (body.response_format?.type === "json_schema") return json({ error: "response_format not supported" }, 400)
      if (body.guided_json) return json({ error: "unknown field guided_json" }, 400)
      if (body.tools) {
        return json({
          choices: [{ message: { tool_calls: [{ function: { arguments: '{"verdict":"accept"}' } }] } }],
          usage: { prompt_tokens: 30, completion_tokens: 6 },
        })
      }
      return json({ error: "no" }, 400)
    })
    try {
      const client = new OpenAiCompatibleClient({
        endpoint: fake.endpoint,
        model: "test",
        pricing: { inputPer1kUsd: 1, outputPer1kUsd: 2 },
      })
      const first = await client.complete({ system: "s", input: "i", schema })
      expect(first.structured).toEqual({ verdict: "accept" })
      expect(first.mode).toBe("tool-call")
      expect(first.usage).toEqual({ inputTokens: 30, outputTokens: 6, costUsd: 0.042 })
      expect(fake.requests).toHaveLength(3)

      const second = await client.complete({ system: "s", input: "i", schema })
      expect(second.mode).toBe("tool-call")
      expect(fake.requests).toHaveLength(4)
    } finally {
      fake.stop()
    }
  })

  test("reports zero cost when no price is configured and lists catalog models", async () => {
    const fake = serve((path) => path === "/models"
      ? json({ data: [{ id: "qwen3" }, { id: "llama3" }] })
      : json({ choices: [{ message: { content: '{"verdict":"stop"}' } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }))
    try {
      const client = new OpenAiCompatibleClient({ endpoint: fake.endpoint, model: "qwen3" })
      expect(await client.listModels()).toEqual(["qwen3", "llama3"])
      const response = await client.complete({ system: "s", input: "i", schema })
      expect(response.usage.costUsd).toBe(0)
      expect(response.structured).toEqual({ verdict: "stop" })
    } finally {
      fake.stop()
    }
  })

  test("never repeats a credential in an error, however the endpoint echoes it", async () => {
    const key = "sk-secret-value-1234567890"
    const fake = serve(() => json({ error: `invalid key ${key}` }, 401))
    try {
      const client = new OpenAiCompatibleClient({ endpoint: fake.endpoint, model: "m", apiKey: key })
      const failure = await client.complete({ system: "s", input: "i", schema }).catch((error: Error) => error.message)
      expect(failure).not.toContain(key)
      expect(failure).toContain("[redacted]")
    } finally {
      fake.stop()
    }
  })

  test("stops reading a response that exceeds the byte ceiling", async () => {
    const fake = serve(() => new Response("x".repeat(200_000), { headers: { "content-type": "application/json" } }))
    try {
      const client = new OpenAiCompatibleClient({ endpoint: fake.endpoint, model: "m", maxResponseBytes: 4_096 })
      const failure = await client
        .complete({ system: "s", input: "i", schema, timeoutMs: 5_000 })
        .catch((error: Error) => error.message)
      expect(String(failure)).toContain("exceeded")
    } finally {
      fake.stop()
    }
  })
})

describe("local and hosted adapters", () => {
  test("ollama constrains decoding with the schema and prices nothing", async () => {
    const fake = serve((path, body) => {
      if (path === "/api/tags") return json({ models: [{ name: "qwen3:14b" }] })
      expect(body.format).toEqual(schema)
      return json({ message: { content: '{"verdict":"accept"}' }, prompt_eval_count: 11, eval_count: 3 })
    })
    try {
      const endpoint: ModelEndpoint = { ...fake.endpoint, kind: "ollama" }
      const client = new OllamaClient({ endpoint, model: "qwen3:14b" })
      expect(await client.listModels()).toEqual(["qwen3:14b"])
      const response = await client.complete({ system: "s", input: "i", schema })
      expect(response.mode).toBe("native-format")
      expect(response.usage).toEqual({ inputTokens: 11, outputTokens: 3, costUsd: 0 })
    } finally {
      fake.stop()
    }
  })

  test("anthropic reads the forced tool result rather than prose", async () => {
    const fake = serve((path, body) => {
      expect(path).toBe("/v1/messages")
      expect(body.tool_choice).toEqual({ type: "tool", name: "cyrion_response" })
      return json({
        content: [{ type: "text", text: "here you go" }, { type: "tool_use", name: "cyrion_response", input: { verdict: "accept" } }],
        usage: { input_tokens: 40, output_tokens: 8 },
      })
    })
    try {
      const endpoint: ModelEndpoint = { ...fake.endpoint, kind: "anthropic" }
      const client = new AnthropicClient({ endpoint, model: "claude-test", apiKey: "sk-ant-test-key-123456" })
      const response = await client.complete({ system: "s", input: "i", schema })
      expect(response.structured).toEqual({ verdict: "accept" })
      expect(response.usage.inputTokens).toBe(40)
    } finally {
      fake.stop()
    }
  })
})

describe("readiness", () => {
  test("separates reachability, catalog membership, and a missing credential", async () => {
    const fake = serve((path) => path === "/models" ? json({ data: [{ id: "qwen3" }] }) : json({}, 404))
    try {
      const config: ModelConfig = {
        endpoints: [
          { id: "local", kind: "openai-compatible", baseUrl: fake.endpoint.baseUrl },
          { id: "hosted", kind: "anthropic", baseUrl: "https://api.test", apiKeyEnv: "MISSING_KEY" },
        ],
        roles: {
          planner: { endpoint: "local", model: "qwen3" },
          validator: { endpoint: "local", model: "absent-model" },
          worker: { endpoint: "hosted", model: "claude-test" },
        },
      }
      const readiness = await probeReadiness(config, {})
      expect(readiness.endpoints.find((item) => item.endpointId === "local")?.reachable).toBe(true)
      expect(readiness.endpoints.find((item) => item.endpointId === "hosted")?.credential).toBe("missing")
      expect(readiness.roles.find((item) => item.role === "planner")?.modelAvailable).toBe(true)
      expect(readiness.roles.find((item) => item.role === "validator")?.modelAvailable).toBe(false)
      expect(readiness.ready).toBe(false)
    } finally {
      fake.stop()
    }
  })

  test("reports the discovered structured mode rather than mistaking it for an error", async () => {
    const fake = serve((path) => path === "/models"
      ? json({ data: [{ id: "qwen3" }] })
      : json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }))
    try {
      const config: ModelConfig = {
        endpoints: [{ id: "local", kind: "openai-compatible", baseUrl: fake.endpoint.baseUrl }],
        roles: { planner: { endpoint: "local", model: "qwen3" } },
      }
      const readiness = await probeReadiness(config, {}, { probeStructured: true })
      const planner = readiness.roles.find((role) => role.role === "planner")
      expect(planner?.structuredMode).toBe("json-schema")
      expect(planner?.error).toBeUndefined()
      expect(readiness.ready).toBe(true)
    } finally {
      fake.stop()
    }
  })

  test("requires a credential before building a client that needs one", () => {
    const config: ModelConfig = {
      endpoints: [{ id: "hosted", kind: "anthropic", baseUrl: "https://api.test", apiKeyEnv: "CYRION_TEST_KEY" }],
      roles: { planner: { endpoint: "hosted", model: "claude-test" } },
    }
    expect(() => createClient(config, "planner", {})).toThrow(/CYRION_TEST_KEY/)
    expect(createClient(config, "planner", { CYRION_TEST_KEY: "sk-ant-1234" }).model).toBe("claude-test")
    expect(() => createClient({ ...config, roles: {} }, "planner", {})).toThrow(/No model is configured/)
  })

  test("redaction covers bearer headers and key-shaped values", () => {
    expect(redact("Authorization: Bearer abcdefgh12345678", [])).toContain("[redacted]")
    expect(redact("key=topsecretvalue", ["topsecretvalue"])).toBe("key=[redacted]")
  })
})

describe("guarded reviewers", () => {
  const snapshot = {
    manifest: {
      id: "ENG-TEST", name: "t", objective: "o", profile: "web-api", mode: "autonomous",
      scope: { targets: ["demo.lab.test"], excluded: [], capabilities: ["fixture.read"] },
      budgets: { maxConcurrentAgents: 1, maxAgents: 2, maxDepth: 1, maxTasks: 2, maxDurationMs: 1000, maxTokens: 10, maxCostUsd: 1 },
    },
    status: "running", agents: [], tasks: [], findings: [], evidence: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, events: [],
  } as unknown as EngagementSnapshot

  const proposal: RootDecision = {
    version: CONTRACT_VERSION,
    action: { kind: "finish", rationale: "done" },
  }

  test("passes the public projection only, and returns the provider verdict", async () => {
    const fake = serve((_, body) => {
      const sent = String(body.messages[1].content)
      expect(sent).toContain("demo.lab.test")
      expect(sent).not.toContain("systemPrompt")
      return json({
        choices: [{ message: { content: '{"verdict":"stop","rationale":"scope looks stale"}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      })
    })
    try {
      const client = new OpenAiCompatibleClient({ endpoint: fake.endpoint, model: "m" })
      const reviewer = new LlmRootReviewer(client, "root system prompt")
      const review = await reviewer.review(snapshot, proposal)
      expect(review).toEqual({ verdict: "stop", rationale: "scope looks stale" })
      expect(reviewer.takeUsage()).toEqual({ inputTokens: 100, outputTokens: 10, costUsd: 0 })
      expect(reviewer.takeUsage()).toBeUndefined()
      await reviewer.close()
    } finally {
      fake.stop()
    }
  })

  test("rejects a review verdict outside the contract", async () => {
    const fake = serve(() => json({ choices: [{ message: { content: '{"verdict":"approve","rationale":"x"}' } }] }))
    try {
      const reviewer = new LlmRootReviewer(new OpenAiCompatibleClient({ endpoint: fake.endpoint, model: "m" }), "s")
      expect(reviewer.review(snapshot, proposal)).rejects.toThrow(/verdict must be accept or stop/)
    } finally {
      fake.stop()
    }
  })

  test("rejects a worker summary carrying terminal control sequences", async () => {
    const unsafe = `ok${String.fromCharCode(27)}[31m`
    const fake = serve(() => json({
      choices: [{ message: { content: JSON.stringify({ verdict: "accept", summary: unsafe }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }))
    try {
      const reviewer = new LlmWorkerReviewer(new OpenAiCompatibleClient({ endpoint: fake.endpoint, model: "m" }))
      const context = {
        engagementId: "ENG-TEST", agentId: "web-t-001", role: "web", systemPrompt: "worker",
        scope: snapshot.manifest.scope, remainingBudget: snapshot.manifest.budgets,
        tools: { execute: async () => ({ output: null, durationMs: 0, outputBytes: 0 }) },
        evidenceStore: new MemoryEvidenceStore(),
      } as any
      const task = {
        id: "T-001", key: "k", role: "web", objective: "o", target: "demo.lab.test",
        capabilities: ["fixture.read"], dependencies: [], depth: 1, expectedOutput: "assessment",
      } as any
      const result = { summary: "s", observations: [], findings: [], evidence: [] } as any
      expect(reviewer.reviewTask(task, context, result)).rejects.toThrow(/terminal-safe/)
    } finally {
      fake.stop()
    }
  })
})

describe("configuration mistakes", () => {
  const endpoint = (overrides: Record<string, unknown>): unknown => ({
    endpoints: [{ id: "e", baseUrl: "https://api.deepseek.com/v1", ...overrides }],
    roles: { planner: { endpoint: "e", model: "m" } },
  })

  test("names the wire protocol when a vendor name is used as a kind", () => {
    expect(modelConfigError(endpoint({ kind: "deepseek" })))
      .toContain("A vendor name is not a kind")
  })

  test("catches a credential pasted where a variable name belongs, without echoing it", () => {
    const secret = "sk-abcdef0123456789abcdef0123456789"
    const error = modelConfigError(endpoint({ kind: "openai-compatible", apiKeyEnv: secret }))!
    expect(error).toContain("names the environment variable that holds the key")
    expect(error).toContain("rotate it")
    expect(error).not.toContain(secret)
    // A plain typo still gets the plain message.
    expect(modelConfigError(endpoint({ kind: "openai-compatible", apiKeyEnv: "my key" })))
      .toContain("must be an environment variable name")
  })
})

describe("structured output ladder", () => {
  /**
   * A server that ignores the schema but honours `response_format: json_object`
   * — DeepSeek's shape, and the shape of most hosted OpenAI-compatible APIs.
   * The reply is a well-formed object that does not answer the question.
   */
  function serveIgnoringSchema(conformOnStrictText: boolean): Fake {
    return serve((path, body) => {
      if (path.endsWith("/models")) return json({ data: [{ id: "m" }] })
      // vLLM's guided_json is silently ignored; a plain json_object is not.
      const constrained = body?.response_format?.type === "json_schema"
      if (constrained) return json({ error: "response_format json_schema is not supported" }, 400)
      const unconstrained = !body?.response_format && !body?.tools
      const content = conformOnStrictText && unconstrained
        ? JSON.stringify({ verdict: "accept" })
        : JSON.stringify({ thoughts: "looks fine to me" })
      return json({ choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    })
  }

  const validate = (value: unknown): string | undefined =>
    (value as { verdict?: string })?.verdict === "accept" ? undefined : "verdict must be accept or stop"

  test("keeps descending when a mode returns an object that does not satisfy the contract", async () => {
    const fake = serveIgnoringSchema(true)
    try {
      const client = new OpenAiCompatibleClient({ endpoint: fake.endpoint, model: "m" })
      const response = await client.complete({ system: "s", input: "i", schema, validate })

      // json-schema is refused by the server; guided-json and json-object come
      // back well-formed but wrong, so the ladder must not stop on them.
      expect(response.structured).toEqual({ verdict: "accept" })
      expect(response.mode).toBe("strict-text")
      expect(client.structuredMode).toBe("strict-text")
    } finally {
      fake.stop()
    }
  })

  test("fails with the reason when no mode produces a conforming answer", async () => {
    const fake = serveIgnoringSchema(false)
    try {
      const client = new OpenAiCompatibleClient({ endpoint: fake.endpoint, model: "m" })
      expect(client.complete({ system: "s", input: "i", schema, validate }))
        .rejects.toThrow(/did not satisfy the schema: verdict must be accept or stop/)
    } finally {
      fake.stop()
    }
  })

  test("without a contract, any object still satisfies the mode", async () => {
    const fake = serveIgnoringSchema(false)
    try {
      const client = new OpenAiCompatibleClient({ endpoint: fake.endpoint, model: "m" })
      const response = await client.complete({ system: "s", input: "i", schema })
      expect(response.structured).toEqual({ thoughts: "looks fine to me" })
    } finally {
      fake.stop()
    }
  })

  test("readiness is decided by the endpoints roles bind to, not by the whole file", async () => {
    const fake = serveIgnoringSchema(true)
    try {
      const config: ModelConfig = {
        endpoints: [
          fake.endpoint,
          // Kept in the file for later: unreachable, and missing its credential.
          { id: "spare", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "ABSENT_KEY" },
        ],
        roles: { planner: { endpoint: "local", model: "m" } },
      }
      const readiness = await probeReadiness(config, {})
      expect(readiness.ready).toBe(true)
      expect(readiness.endpoints.find((endpoint) => endpoint.endpointId === "spare")?.error)
        .toContain("no role is bound")

      // Bind a role to it and the same endpoint now decides readiness.
      config.roles.worker = { endpoint: "spare", model: "m" }
      expect((await probeReadiness(config, {})).ready).toBe(false)
    } finally {
      fake.stop()
    }
  })
})
