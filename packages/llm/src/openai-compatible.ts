import type { ResourceUsage } from "@cyrion/contracts"
import { diagnostic, getJson, postJson } from "./http"
import type {
  ModelClient,
  ModelEndpoint,
  ModelPricing,
  ModelRequest,
  ModelResponse,
  StructuredMode,
} from "./types"

/** Total wall clock one structured request may spend across every mode. */
const DEFAULT_LADDER_BUDGET_MS = 120_000
/** Below this, a further attempt cannot finish and only delays the failure. */
const MINIMUM_ATTEMPT_MS = 2_000
/** Ceiling for the one retry a truncated answer earns. */
const MAX_WIDENED_OUTPUT_TOKENS = 16_384

export interface OpenAiCompatibleOptions {
  endpoint: ModelEndpoint
  model: string
  apiKey?: string
  pricing?: ModelPricing
  maxOutputTokens?: number
  temperature?: number
  /** Ceiling on a single response body. Defaults to the transport limit. */
  maxResponseBytes?: number
}

/**
 * One client for every OpenAI-shaped endpoint: hosted APIs, gateways, vLLM,
 * llama.cpp, LM Studio, and Ollama's compatibility path.
 *
 * Structured output is a ladder, not an assumption. The first mode that
 * returns a parsable object is remembered for this endpoint and model, so the
 * cost of discovery is paid once per run.
 */
export class OpenAiCompatibleClient implements ModelClient {
  readonly endpoint: ModelEndpoint
  readonly model: string
  readonly #apiKey?: string
  readonly #pricing?: ModelPricing
  readonly #maxOutputTokens?: number
  readonly #temperature?: number
  readonly #maxResponseBytes?: number
  #mode?: StructuredMode
  /** Modes this endpoint answered as unsupported. A settled fact, not a retry. */
  readonly #unsupported = new Set<StructuredMode>()

  constructor(options: OpenAiCompatibleOptions) {
    this.endpoint = options.endpoint
    this.model = options.model
    if (options.apiKey) this.#apiKey = options.apiKey
    if (options.pricing) this.#pricing = options.pricing
    if (options.maxOutputTokens !== undefined) this.#maxOutputTokens = options.maxOutputTokens
    if (options.temperature !== undefined) this.#temperature = options.temperature
    if (options.maxResponseBytes !== undefined) this.#maxResponseBytes = options.maxResponseBytes
  }

  get id(): string {
    return `${this.endpoint.id}/${this.model}`
  }

  get structuredMode(): StructuredMode | undefined {
    return this.#mode
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const result = await getJson({
      url: `${trimSlash(this.endpoint.baseUrl)}/models`,
      headers: this.#headers(),
      ...(signal ? { signal } : {}),
      secrets: this.#secrets(),
      timeoutMs: 15_000,
    })
    if (!result.ok) throw new Error(`Model listing failed (${result.status}): ${diagnostic(result.text, this.#secrets())}`)
    const data = (result.json as { data?: Array<{ id?: unknown }> } | undefined)?.data
    if (!Array.isArray(data)) throw new Error("Model listing returned an unexpected shape")
    return data.map((entry) => String(entry.id ?? "")).filter(Boolean)
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (!request.schema) {
      const attempt = await this.#attempt("strict-text", request)
      if ("error" in attempt) throw new Error(attempt.error)
      return attempt.response
    }
    // One budget for the whole ladder, not one per rung: five modes each given
    // the full timeout would let a slow endpoint hold a single decision for five
    // times as long as the caller agreed to wait.
    const budgetMs = request.timeoutMs ?? DEFAULT_LADDER_BUDGET_MS
    const deadline = Date.now() + budgetMs
    const failures: string[] = []
    for (const mode of this.#ladder()) {
      const remaining = deadline - Date.now()
      if (remaining <= MINIMUM_ATTEMPT_MS) {
        failures.push(`${mode}: skipped, the ${budgetMs}ms budget for this request was spent`)
        break
      }
      let attempt = await this.#attempt(mode, { ...request, timeoutMs: remaining })
      // A truncated answer is not a mode that does not work — it is a ceiling
      // set too low. On a reasoning model the token budget covers the thinking
      // as well as the answer, so a cap sized for the answer alone starves it.
      if ("error" in attempt && attempt.truncated) {
        const widened = Math.min(MAX_WIDENED_OUTPUT_TOKENS, Math.max(4_096, (request.maxOutputTokens ?? 2_048) * 4))
        const left = deadline - Date.now()
        if (left > MINIMUM_ATTEMPT_MS) {
          attempt = await this.#attempt(mode, { ...request, timeoutMs: left, maxOutputTokens: widened })
        }
      }
      if ("error" in attempt) {
        // A 4xx naming the parameter is the endpoint saying it cannot do this,
        // not a bad moment. Asking again on every later request would spend the
        // budget rediscovering the same answer.
        if (attempt.unsupported) this.#unsupported.add(mode)
        failures.push(`${mode}: ${attempt.error}`)
        continue
      }
      this.#mode = mode
      return attempt.response
    }
    const detail = failures.join(" | ")
    throw new Error(
      `No structured output mode succeeded for ${this.id}. ${detail.length > 800 ? `${detail.slice(0, 800)}…` : detail}`,
    )
  }

  async close(): Promise<void> {}

  /**
   * Remembered mode first, then most precise to most permissive, minus the ones
   * this endpoint has already refused.
   */
  #ladder(): StructuredMode[] {
    const order: StructuredMode[] = ["json-schema", "guided-json", "tool-call", "json-object", "strict-text"]
    const viable = order.filter((mode) => !this.#unsupported.has(mode))
    // strict-text asks for nothing the server has to support, so it always stays.
    const candidates = viable.length ? viable : (["strict-text"] as StructuredMode[])
    return this.#mode && candidates.includes(this.#mode)
      ? [this.#mode, ...candidates.filter((mode) => mode !== this.#mode)]
      : candidates
  }

  /** Modes this endpoint has said it cannot serve, for diagnostics. */
  get unsupportedModes(): StructuredMode[] {
    return [...this.#unsupported]
  }

  async #attempt(
    mode: StructuredMode,
    request: ModelRequest,
  ): Promise<{ response: ModelResponse } | { error: string; unsupported?: boolean; truncated?: boolean }> {
    const schema = request.schema
    const name = request.schemaName ?? "cyrion_response"
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: mode === "json-schema" || mode === "guided-json" || mode === "tool-call"
          ? request.input
          : schema ? strictJsonInstruction(request.input, schema) : request.input },
      ],
      stream: false,
    }
    const maxTokens = tighterCeiling(request.maxOutputTokens, this.#maxOutputTokens)
    if (maxTokens !== undefined) body.max_tokens = maxTokens
    const temperature = request.temperature ?? this.#temperature
    if (temperature !== undefined) body.temperature = temperature

    if (schema) {
      if (mode === "json-schema") {
        body.response_format = { type: "json_schema", json_schema: { name, strict: true, schema } }
      } else if (mode === "guided-json") {
        body.guided_json = schema
        body.response_format = { type: "json_object" }
      } else if (mode === "tool-call") {
        body.tools = [{ type: "function", function: { name, description: "Return the required object.", parameters: schema } }]
        body.tool_choice = { type: "function", function: { name } }
      } else if (mode === "json-object") {
        body.response_format = { type: "json_object" }
      }
    }

    let result
    try {
      result = await postJson({
        url: `${trimSlash(this.endpoint.baseUrl)}/chat/completions`,
        headers: { "content-type": "application/json", ...this.#headers() },
        body,
        ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(this.#maxResponseBytes ? { maxBytes: this.#maxResponseBytes } : {}),
        secrets: this.#secrets(),
      })
    } catch (error) {
      return { error: diagnostic(error, this.#secrets()) }
    }
    if (!result.ok) {
      const detail = diagnostic(result.text, this.#secrets())
      return {
        error: `HTTP ${result.status}: ${detail}`,
        ...(unsupportedRequest(result.status, detail) ? { unsupported: true } : {}),
      }
    }

    const payload = result.json as ChatCompletion | undefined
    const choice = payload?.choices?.[0]
    if (!choice) return { error: `response contained no choice: ${diagnostic(result.text, this.#secrets())}` }
    const toolArguments = choice.message?.tool_calls?.[0]?.function?.arguments
    const text = mode === "tool-call" ? toolArguments ?? "" : choice.message?.content ?? ""
    const usage = this.#usage(payload?.usage)

    if (!schema) return { response: { text, usage, mode } }
    const structured = parseObject(text)
    if (structured === undefined) {
      const truncated = choice.finish_reason === "length"
      return {
        error: truncated
          ? "the answer was cut off at the output ceiling before it was valid JSON"
          : `response was not a JSON object (finish_reason ${choice.finish_reason ?? "unknown"})`,
        ...(truncated ? { truncated: true } : {}),
      }
    }
    const rejection = request.validate?.(structured)
    if (rejection) return { error: `response did not satisfy the schema: ${rejection}` }
    return { response: { text, structured, usage, mode } }
  }

  #headers(): Record<string, string> {
    return this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}
  }

  #secrets(): string[] {
    return this.#apiKey ? [this.#apiKey] : []
  }

  #usage(usage: ChatCompletion["usage"]): ResourceUsage {
    const inputTokens = safeCount(usage?.prompt_tokens)
    const outputTokens = safeCount(usage?.completion_tokens)
    return {
      inputTokens,
      outputTokens,
      costUsd: this.#pricing ? cost(inputTokens, outputTokens, this.#pricing) : 0,
    }
  }
}

interface ChatCompletion {
  choices?: Array<{
    finish_reason?: string
    message?: {
      content?: string
      tool_calls?: Array<{ function?: { arguments?: string } }>
    }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/**
 * Whether a rejection means "this endpoint cannot do that", rather than "not
 * right now". Only a client error qualifies, and only when the endpoint says
 * the request itself was the problem — a rate limit or an outage must stay
 * retryable.
 */
export function unsupportedRequest(status: number, detail: string): boolean {
  if (status !== 400 && status !== 404 && status !== 422 && status !== 501) return false
  // Capability language only. `invalid_request_error` is the error *type* on
  // every 400 these APIs return, so matching it would retire a working mode
  // after one oversized prompt or one malformed argument.
  return /unavailable|not supported|unsupported|does not support|doesn't support|not available|unrecognized|unknown (?:field|parameter|argument)/i
    .test(detail)
}

export function strictJsonInstruction(input: string, schema: Record<string, unknown>): string {
  return [
    input,
    "Return only one bare JSON object.",
    "Do not use Markdown fences, commentary, or additional keys.",
    `The JSON must conform exactly to this schema:\n${JSON.stringify(schema)}`,
  ].join("\n")
}

/** Accepts a bare object, or one wrapped in a fenced block, and nothing else. */
export function parseObject(text: string): unknown | undefined {
  const trimmed = text.trim()
  const fenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "").trim()
    : trimmed
  if (!fenced.startsWith("{") || !fenced.endsWith("}")) return undefined
  try {
    const value: unknown = JSON.parse(fenced)
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * The tighter of two ceilings.
 *
 * A role binding and a request each say how much output they will accept, and
 * neither is a request for more: taking the smaller keeps an operator's cap
 * from being widened by a caller, and a caller's cap from being ignored.
 */
export function tighterCeiling(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined) return second
  if (second === undefined) return first
  return Math.min(first, second)
}

export function trimSlash(value: string): string {
  return value.replace(/\/+$/, "")
}

/** Rounded to sub-microdollar precision so budget records stay readable. */
export function cost(inputTokens: number, outputTokens: number, pricing: ModelPricing): number {
  const amount = (inputTokens / 1000) * pricing.inputPer1kUsd + (outputTokens / 1000) * pricing.outputPer1kUsd
  return Math.round(amount * 1e6) / 1e6
}

export function safeCount(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
}
