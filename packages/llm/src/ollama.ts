import type { ResourceUsage } from "@cyrion/contracts"
import { diagnostic, getJson, postJson } from "./http"
import { parseObject, safeCount, strictJsonInstruction, tighterCeiling, trimSlash } from "./openai-compatible"
import type { ModelClient, ModelEndpoint, ModelRequest, ModelResponse, StructuredMode } from "./types"

export interface OllamaOptions {
  endpoint: ModelEndpoint
  model: string
  maxOutputTokens?: number
  temperature?: number
}

/**
 * Ollama's native API. Preferred over its OpenAI path because `format` takes a
 * JSON Schema directly, which constrains decoding rather than asking politely.
 * Local inference has no price, so cost is always zero.
 */
export class OllamaClient implements ModelClient {
  readonly endpoint: ModelEndpoint
  readonly model: string
  readonly #maxOutputTokens?: number
  readonly #temperature?: number
  #mode?: StructuredMode

  constructor(options: OllamaOptions) {
    this.endpoint = options.endpoint
    this.model = options.model
    if (options.maxOutputTokens !== undefined) this.#maxOutputTokens = options.maxOutputTokens
    if (options.temperature !== undefined) this.#temperature = options.temperature
  }

  get id(): string {
    return `${this.endpoint.id}/${this.model}`
  }

  get structuredMode(): StructuredMode | undefined {
    return this.#mode
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const result = await getJson({
      url: `${trimSlash(this.endpoint.baseUrl)}/api/tags`,
      headers: {},
      ...(signal ? { signal } : {}),
      timeoutMs: 15_000,
    })
    if (!result.ok) throw new Error(`Model listing failed (${result.status}): ${diagnostic(result.text)}`)
    const models = (result.json as { models?: Array<{ name?: unknown }> } | undefined)?.models
    if (!Array.isArray(models)) throw new Error("Model listing returned an unexpected shape")
    return models.map((entry) => String(entry.name ?? "")).filter(Boolean)
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const modes: StructuredMode[] = request.schema ? ["native-format", "strict-text"] : ["strict-text"]
    const ordered = this.#mode && modes.includes(this.#mode)
      ? [this.#mode, ...modes.filter((mode) => mode !== this.#mode)]
      : modes
    // One budget across every mode, as with the OpenAI-compatible ladder.
    const deadline = Date.now() + (request.timeoutMs ?? 120_000)
    const failures: string[] = []
    for (const mode of ordered) {
      const remaining = deadline - Date.now()
      if (remaining <= 2_000) {
        failures.push(`${mode}: skipped, the budget for this request was spent`)
        break
      }
      const attempt = await this.#attempt(mode, { ...request, timeoutMs: remaining })
      if ("error" in attempt) {
        failures.push(`${mode}: ${attempt.error}`)
        continue
      }
      if (request.schema) this.#mode = mode
      return attempt.response
    }
    throw new Error(`Ollama request failed for ${this.id}. ${failures.join(" | ")}`)
  }

  async close(): Promise<void> {}

  async #attempt(
    mode: StructuredMode,
    request: ModelRequest,
  ): Promise<{ response: ModelResponse } | { error: string }> {
    const schema = request.schema
    const options: Record<string, unknown> = {}
    const maxTokens = tighterCeiling(request.maxOutputTokens, this.#maxOutputTokens)
    if (maxTokens !== undefined) options.num_predict = maxTokens
    const temperature = request.temperature ?? this.#temperature
    if (temperature !== undefined) options.temperature = temperature

    const body: Record<string, unknown> = {
      model: this.model,
      stream: false,
      messages: [
        { role: "system", content: request.system },
        {
          role: "user",
          content: mode === "native-format" || !schema ? request.input : strictJsonInstruction(request.input, schema),
        },
      ],
      ...(Object.keys(options).length ? { options } : {}),
      ...(mode === "native-format" && schema ? { format: schema } : {}),
    }

    let result
    try {
      result = await postJson({
        url: `${trimSlash(this.endpoint.baseUrl)}/api/chat`,
        headers: { "content-type": "application/json" },
        body,
        ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      })
    } catch (error) {
      return { error: diagnostic(error) }
    }
    if (!result.ok) return { error: `HTTP ${result.status}: ${diagnostic(result.text)}` }

    const payload = result.json as OllamaChat | undefined
    const text = payload?.message?.content ?? ""
    const usage: ResourceUsage = {
      inputTokens: safeCount(payload?.prompt_eval_count),
      outputTokens: safeCount(payload?.eval_count),
      costUsd: 0,
    }
    if (!schema) return { response: { text, usage, mode } }
    const structured = parseObject(text)
    if (structured === undefined) return { error: "response was not a JSON object" }
    const rejection = request.validate?.(structured)
    if (rejection) return { error: `response did not satisfy the schema: ${rejection}` }
    return { response: { text, structured, usage, mode } }
  }
}

interface OllamaChat {
  message?: { content?: string }
  prompt_eval_count?: number
  eval_count?: number
}
