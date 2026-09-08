import type { ResourceUsage } from "@cyrion/contracts"
import { diagnostic, postJson } from "./http"
import { cost, parseObject, safeCount, trimSlash } from "./openai-compatible"
import type { ModelClient, ModelEndpoint, ModelPricing, ModelRequest, ModelResponse, StructuredMode } from "./types"

const ANTHROPIC_VERSION = "2023-06-01"

export interface AnthropicOptions {
  endpoint: ModelEndpoint
  model: string
  apiKey: string
  pricing?: ModelPricing
  maxOutputTokens?: number
  temperature?: number
}

/**
 * Anthropic Messages API. Structured output uses a single forced tool, which is
 * the provider's schema-constrained path; plain text is used when no schema is
 * requested.
 */
export class AnthropicClient implements ModelClient {
  readonly endpoint: ModelEndpoint
  readonly model: string
  readonly #apiKey: string
  readonly #pricing?: ModelPricing
  readonly #maxOutputTokens: number
  readonly #temperature?: number
  #mode?: StructuredMode

  constructor(options: AnthropicOptions) {
    this.endpoint = options.endpoint
    this.model = options.model
    this.#apiKey = options.apiKey
    if (options.pricing) this.#pricing = options.pricing
    this.#maxOutputTokens = options.maxOutputTokens ?? 8_192
    if (options.temperature !== undefined) this.#temperature = options.temperature
  }

  get id(): string {
    return `${this.endpoint.id}/${this.model}`
  }

  get structuredMode(): StructuredMode | undefined {
    return this.#mode
  }

  /** The Messages API has no catalog endpoint; the configured model is the answer. */
  async listModels(): Promise<string[]> {
    return [this.model]
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const name = request.schemaName ?? "cyrion_response"
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxOutputTokens ?? this.#maxOutputTokens,
      system: request.system,
      messages: [{ role: "user", content: request.input }],
    }
    const temperature = request.temperature ?? this.#temperature
    if (temperature !== undefined) body.temperature = temperature
    if (request.schema) {
      body.tools = [{ name, description: "Return the required object.", input_schema: request.schema }]
      body.tool_choice = { type: "tool", name }
    }

    let result
    try {
      result = await postJson({
        url: `${trimSlash(this.endpoint.baseUrl)}/v1/messages`,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body,
        ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        secrets: [this.#apiKey],
      })
    } catch (error) {
      throw new Error(diagnostic(error, [this.#apiKey]))
    }
    if (!result.ok) {
      throw new Error(`Anthropic request failed (${result.status}): ${diagnostic(result.text, [this.#apiKey])}`)
    }

    const payload = result.json as AnthropicMessage | undefined
    const usage: ResourceUsage = {
      inputTokens: safeCount(payload?.usage?.input_tokens),
      outputTokens: safeCount(payload?.usage?.output_tokens),
      costUsd: 0,
    }
    if (this.#pricing) usage.costUsd = cost(usage.inputTokens, usage.outputTokens, this.#pricing)

    const blocks = payload?.content ?? []
    const text = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("")
    if (!request.schema) return { text, usage, mode: "strict-text" }

    const toolInput = blocks.find((block) => block.type === "tool_use" && block.name === name)?.input
    const structured = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)
      ? toolInput
      : parseObject(text)
    if (structured === undefined) throw new Error(`Anthropic response contained no structured object for ${this.id}`)
    const rejection = request.validate?.(structured)
    if (rejection) throw new Error(`Anthropic response did not satisfy the schema for ${this.id}: ${rejection}`)
    this.#mode = "tool-call"
    return { text, structured, usage, mode: "tool-call" }
  }

  async close(): Promise<void> {}
}

interface AnthropicMessage {
  content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>
  usage?: { input_tokens?: number; output_tokens?: number }
}
