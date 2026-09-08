import type { EndpointKind, ModelConfig, ModelEndpoint, ModelRole, RoleBinding } from "./types"
import { modelRoles } from "./types"

type Environment = Readonly<Record<string, string | undefined>>

const endpointKinds: readonly EndpointKind[] = ["openai-compatible", "anthropic", "ollama"]

/** Single-endpoint shorthand, so a local server needs two variables and no config file. */
export function readEnvironmentConfig(environment: Environment): ModelConfig | undefined {
  const baseUrl = environment.CYRION_LLM_BASE_URL?.trim()
  const model = environment.CYRION_LLM_MODEL?.trim()
  if (!baseUrl || !model) return undefined
  const kind = (environment.CYRION_LLM_KIND?.trim() || "openai-compatible") as EndpointKind
  if (!endpointKinds.includes(kind)) {
    throw new Error(`CYRION_LLM_KIND must be one of ${endpointKinds.join(", ")}`)
  }
  const endpoint: ModelEndpoint = {
    id: "default",
    kind,
    baseUrl,
    ...(environment.CYRION_LLM_API_KEY_ENV?.trim() ? { apiKeyEnv: environment.CYRION_LLM_API_KEY_ENV.trim() } : {}),
    ...(environment.CYRION_LLM_ALLOW_INSECURE === "1" ? { allowInsecure: true } : {}),
  }
  const binding: RoleBinding = { endpoint: "default", model }
  const config: ModelConfig = {
    endpoints: [endpoint],
    roles: Object.fromEntries(modelRoles.filter((role) => role !== "embedding").map((role) => [role, binding])),
  }
  const error = modelConfigError(config)
  if (error) throw new Error(`Invalid environment model configuration: ${error}`)
  return config
}

export async function loadModelConfig(path: string): Promise<ModelConfig> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`Model configuration not found: ${path}`)
  let value: unknown
  try {
    value = await file.json()
  } catch {
    throw new Error(`Model configuration is not valid JSON: ${path}`)
  }
  const error = modelConfigError(value)
  if (error) throw new Error(`Invalid model configuration ${path}: ${error}`)
  return value as ModelConfig
}

export function modelConfigError(value: unknown): string | undefined {
  if (!isRecord(value)) return "configuration must be an object"
  const extra = unexpectedKey(value, ["endpoints", "roles"])
  if (extra) return `unexpected field ${extra}`
  if (!Array.isArray(value.endpoints) || !value.endpoints.length || value.endpoints.length > 32) {
    return "endpoints must be an array of 1 to 32 entries"
  }
  const ids = new Set<string>()
  for (const [index, endpoint] of value.endpoints.entries()) {
    const error = endpointError(endpoint, `endpoints[${index}]`)
    if (error) return error
    const id = (endpoint as ModelEndpoint).id
    if (ids.has(id)) return `duplicate endpoint id ${id}`
    ids.add(id)
  }
  if (!isRecord(value.roles)) return "roles must be an object"
  const roleExtra = unexpectedKey(value.roles, modelRoles)
  if (roleExtra) return `roles contains unsupported role ${roleExtra}`
  if (!Object.keys(value.roles).length) return "at least one role binding is required"
  for (const [role, binding] of Object.entries(value.roles)) {
    const error = bindingError(binding, `roles.${role}`, ids)
    if (error) return error
  }
  return undefined
}

/** Resolves the binding for a role, falling back to planner then to any single binding. */
export function bindingForRole(config: ModelConfig, role: ModelRole): RoleBinding | undefined {
  const direct = config.roles[role]
  if (direct) return direct
  if (role === "validator" || role === "worker" || role === "reporter") return config.roles.planner
  return undefined
}

export function endpointById(config: ModelConfig, id: string): ModelEndpoint | undefined {
  return config.endpoints.find((endpoint) => endpoint.id === id)
}

function endpointError(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`
  const extra = unexpectedKey(value, ["id", "kind", "baseUrl", "apiKeyEnv", "allowInsecure"])
  if (extra) return `${path} contains unexpected field ${extra}`
  if (!identifier(value.id)) return `${path}.id must be a safe identifier`
  if (!endpointKinds.includes(value.kind as EndpointKind)) {
    // A vendor name is the common mistake here, and almost always resolves to
    // openai-compatible: the kind describes the wire protocol, not the company.
    return `${path}.kind must be one of ${endpointKinds.join(", ")}. A vendor name is not a kind — DeepSeek, `
      + "OpenAI, OpenRouter, Groq, Together, xAI, vLLM, llama.cpp and LM Studio all speak openai-compatible"
  }
  const urlError = baseUrlError(value.baseUrl, value.allowInsecure === true, path)
  if (urlError) return urlError
  if ("apiKeyEnv" in value && !environmentName(value.apiKeyEnv)) {
    // Catch a pasted credential by name rather than letting it sit in a file
    // that is far easier to commit than an environment.
    return looksLikeCredential(value.apiKeyEnv)
      ? `${path}.apiKeyEnv names the environment variable that holds the key, such as DEEPSEEK_API_KEY — not the `
        + "key itself. The value here looks like a live credential: move it into your environment and rotate it, "
        + "because it has already been written to this file"
      : `${path}.apiKeyEnv must be an environment variable name, such as DEEPSEEK_API_KEY`
  }
  if ("allowInsecure" in value && typeof value.allowInsecure !== "boolean") return `${path}.allowInsecure must be a boolean`
  return undefined
}

function baseUrlError(value: unknown, allowInsecure: boolean, path: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return `${path}.baseUrl is required`
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return `${path}.baseUrl is not a valid URL`
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return `${path}.baseUrl must use http or https`
  if (url.protocol === "http:" && !isLoopback(url.hostname) && !allowInsecure) {
    return `${path}.baseUrl sends engagement data in cleartext to a remote host; set allowInsecure to accept that`
  }
  if (url.username || url.password) return `${path}.baseUrl must not embed credentials`
  return undefined
}

function bindingError(value: unknown, path: string, endpointIds: ReadonlySet<string>): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`
  const extra = unexpectedKey(value, ["endpoint", "model", "maxOutputTokens", "temperature", "pricing"])
  if (extra) return `${path} contains unexpected field ${extra}`
  if (!identifier(value.endpoint)) return `${path}.endpoint must be an endpoint id`
  if (!endpointIds.has(value.endpoint)) return `${path}.endpoint ${value.endpoint} is not defined`
  if (typeof value.model !== "string" || !value.model.trim() || value.model.length > 256) {
    return `${path}.model must be a non-empty string of at most 256 characters`
  }
  if ("maxOutputTokens" in value && (!Number.isSafeInteger(value.maxOutputTokens) || Number(value.maxOutputTokens) < 1)) {
    return `${path}.maxOutputTokens must be a positive integer`
  }
  if ("temperature" in value) {
    const temperature = value.temperature
    if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      return `${path}.temperature must be between 0 and 2`
    }
  }
  if ("pricing" in value) {
    if (!isRecord(value.pricing)) return `${path}.pricing must be an object`
    const pricingExtra = unexpectedKey(value.pricing, ["inputPer1kUsd", "outputPer1kUsd"])
    if (pricingExtra) return `${path}.pricing contains unexpected field ${pricingExtra}`
    for (const key of ["inputPer1kUsd", "outputPer1kUsd"]) {
      const amount = value.pricing[key]
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
        return `${path}.pricing.${key} must be a non-negative number`
      }
    }
  }
  return undefined
}

export function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function unexpectedKey(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key))
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
}

/** Recognizes the common credential prefixes, without ever echoing the value. */
function looksLikeCredential(value: unknown): boolean {
  return typeof value === "string" && /^(sk-|pk-|sk_|rk_|ghp_|gho_|xoxb-|AIza|hf_|r8_)/.test(value)
}

function environmentName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
}
