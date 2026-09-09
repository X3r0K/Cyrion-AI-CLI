import { bindingForRole, endpointById } from "./config"
import { credentialFor } from "./factory"
import { diagnostic, postJson } from "./http"
import { trimSlash } from "./openai-compatible"
import type { ModelConfig, ModelEndpoint } from "./types"

type Environment = Readonly<Record<string, string | undefined>>

/**
 * Turns text into vectors for local retrieval.
 *
 * Separate from `ModelClient` on purpose: an embedding endpoint answers a
 * different request, returns no text, and makes no decision. Nothing it
 * produces can reach a plan, a finding, or a verdict — it only orders snippets
 * the operator already ingested.
 */
export interface EmbeddingClient {
  readonly id: string
  readonly model: string
  readonly dimensions?: number
  embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>
}

export interface EmbeddingOptions {
  /** Wall clock for one batch. Local servers are slow on first load. */
  timeoutMs?: number
  /** Texts per request. Kept small so one oversized batch cannot stall a sync. */
  batchSize?: number
}

const MAX_INPUT_CHARS = 8_000

export function createEmbeddingClient(
  config: ModelConfig,
  environment: Environment,
  options: EmbeddingOptions = {},
): EmbeddingClient {
  const binding = config.roles.embedding ?? bindingForRole(config, "embedding")
  if (!binding) {
    throw new Error(
      "No embedding model is configured. Add roles.embedding to your model configuration, "
      + "or run knowledge search without embeddings.",
    )
  }
  const endpoint = endpointById(config, binding.endpoint)
  if (!endpoint) throw new Error(`Endpoint ${binding.endpoint} is not defined`)
  if (endpoint.kind === "anthropic") {
    throw new Error(`Endpoint ${endpoint.id} has no embeddings API; bind roles.embedding to a local or OpenAI-compatible endpoint`)
  }
  const apiKey = credentialFor(endpoint, environment)
  return new HttpEmbeddingClient({
    endpoint,
    model: binding.model,
    ...(apiKey ? { apiKey } : {}),
    ...options,
  })
}

interface HttpEmbeddingOptions extends EmbeddingOptions {
  endpoint: ModelEndpoint
  model: string
  apiKey?: string
}

class HttpEmbeddingClient implements EmbeddingClient {
  readonly model: string
  readonly #endpoint: ModelEndpoint
  readonly #apiKey?: string
  readonly #timeoutMs: number
  readonly #batchSize: number
  readonly #secrets: readonly string[]

  constructor(options: HttpEmbeddingOptions) {
    this.#endpoint = options.endpoint
    this.model = options.model
    if (options.apiKey) this.#apiKey = options.apiKey
    this.#timeoutMs = options.timeoutMs ?? 60_000
    this.#batchSize = Math.max(1, Math.min(options.batchSize ?? 16, 128))
    this.#secrets = options.apiKey ? [options.apiKey] : []
  }

  get id(): string {
    return `${this.#endpoint.id}/${this.model}`
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const vectors: Float32Array[] = []
    for (let index = 0; index < texts.length; index += this.#batchSize) {
      const batch = texts.slice(index, index + this.#batchSize).map((text) => text.slice(0, MAX_INPUT_CHARS))
      vectors.push(...(this.#endpoint.kind === "ollama"
        ? await this.#ollama(batch, signal)
        : await this.#openai(batch, signal)))
    }
    return vectors
  }

  async #openai(batch: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const result = await postJson({
      url: `${trimSlash(this.#endpoint.baseUrl)}/embeddings`,
      headers: {
        "content-type": "application/json",
        ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
      },
      body: { model: this.model, input: batch },
      timeoutMs: this.#timeoutMs,
      ...(signal ? { signal } : {}),
      ...(this.#apiKey ? { secrets: [this.#apiKey] } : {}),
    })
    if (!result.ok) throw new Error(`Embedding request failed (${result.status}): ${diagnostic(result.text, this.#secrets)}`)
    const data = (result.json as { data?: Array<{ embedding?: unknown; index?: unknown }> } | undefined)?.data
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new Error(`Embedding endpoint returned ${Array.isArray(data) ? data.length : 0} vectors for ${batch.length} inputs`)
    }
    // The API is allowed to answer out of order, and an entry carries the index
    // it belongs to. Trusting array position instead would attach a vector to
    // the wrong chunk, which is a silently wrong search result forever after.
    const ordered = new Array<Float32Array | undefined>(batch.length)
    for (const [position, entry] of data.entries()) {
      const index = typeof entry.index === "number" ? entry.index : position
      if (!Number.isInteger(index) || index < 0 || index >= batch.length) {
        throw new Error("Embedding endpoint returned an out-of-range vector index")
      }
      if (ordered[index]) throw new Error("Embedding endpoint returned a duplicate vector index")
      ordered[index] = toVector(entry.embedding)
    }
    return ordered.map((vector, index) => {
      if (!vector) throw new Error(`Embedding endpoint returned no vector for input ${index}`)
      return vector
    })
  }

  async #ollama(batch: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const result = await postJson({
      url: `${trimSlash(this.#endpoint.baseUrl)}/api/embed`,
      headers: { "content-type": "application/json" },
      body: { model: this.model, input: batch },
      timeoutMs: this.#timeoutMs,
      ...(signal ? { signal } : {}),
    })
    if (!result.ok) throw new Error(`Embedding request failed (${result.status}): ${diagnostic(result.text)}`)
    const embeddings = (result.json as { embeddings?: unknown } | undefined)?.embeddings
    if (!Array.isArray(embeddings) || embeddings.length !== batch.length) {
      throw new Error(`Embedding endpoint returned ${Array.isArray(embeddings) ? embeddings.length : 0} vectors for ${batch.length} inputs`)
    }
    return embeddings.map((entry) => toVector(entry))
  }
}

function toVector(value: unknown): Float32Array {
  if (!Array.isArray(value) || !value.length) throw new Error("Embedding endpoint returned an empty vector")
  const vector = new Float32Array(value.length)
  for (const [index, entry] of value.entries()) {
    const number = typeof entry === "number" ? entry : Number.NaN
    if (!Number.isFinite(number)) throw new Error("Embedding endpoint returned a non-finite component")
    vector[index] = number
  }
  return vector
}
