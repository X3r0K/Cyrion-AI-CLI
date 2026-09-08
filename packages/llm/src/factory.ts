import { AnthropicClient } from "./anthropic"
import { bindingForRole, endpointById } from "./config"
import { describe } from "./http"
import { OllamaClient } from "./ollama"
import { OpenAiCompatibleClient } from "./openai-compatible"
import type {
  EndpointReadiness,
  LlmReadiness,
  ModelClient,
  ModelConfig,
  ModelEndpoint,
  ModelRole,
  RoleReadiness,
  StructuredMode,
} from "./types"

type Environment = Readonly<Record<string, string | undefined>>

export function createClient(config: ModelConfig, role: ModelRole, environment: Environment): ModelClient {
  const binding = bindingForRole(config, role)
  if (!binding) {
    throw new Error(`No model is configured for the ${role} role. Add roles.${role} to your model configuration.`)
  }
  const endpoint = endpointById(config, binding.endpoint)
  if (!endpoint) throw new Error(`Endpoint ${binding.endpoint} is not defined`)
  const apiKey = credentialFor(endpoint, environment)
  const shared = {
    endpoint,
    model: binding.model,
    ...(binding.pricing ? { pricing: binding.pricing } : {}),
    ...(binding.maxOutputTokens !== undefined ? { maxOutputTokens: binding.maxOutputTokens } : {}),
    ...(binding.temperature !== undefined ? { temperature: binding.temperature } : {}),
  }

  if (endpoint.kind === "anthropic") {
    if (!apiKey) throw new Error(`Endpoint ${endpoint.id} requires ${endpoint.apiKeyEnv ?? "an API key"} in the environment`)
    return new AnthropicClient({ ...shared, apiKey })
  }
  if (endpoint.kind === "ollama") {
    return new OllamaClient({
      endpoint,
      model: binding.model,
      ...(binding.maxOutputTokens !== undefined ? { maxOutputTokens: binding.maxOutputTokens } : {}),
      ...(binding.temperature !== undefined ? { temperature: binding.temperature } : {}),
    })
  }
  return new OpenAiCompatibleClient({ ...shared, ...(apiKey ? { apiKey } : {}) })
}

export function credentialFor(endpoint: ModelEndpoint, environment: Environment): string | undefined {
  if (!endpoint.apiKeyEnv) return undefined
  const value = environment[endpoint.apiKeyEnv]?.trim()
  return value || undefined
}

export interface ProbeOptions {
  /** Sends one tiny schema-constrained request per role to learn the working mode. Costs tokens. */
  probeStructured?: boolean
  signal?: AbortSignal
}

/**
 * Reports what is reachable without pretending a run will succeed: endpoint
 * reachability and catalogs are checked for free, and the structured-output
 * mode is only discovered when the operator asks for a live probe.
 */
export async function probeReadiness(
  config: ModelConfig,
  environment: Environment,
  options: ProbeOptions = {},
): Promise<LlmReadiness> {
  const endpoints: EndpointReadiness[] = []
  const catalogs = new Map<string, string[]>()

  for (const endpoint of config.endpoints) {
    const credential: EndpointReadiness["credential"] = !endpoint.apiKeyEnv
      ? "not-required"
      : credentialFor(endpoint, environment) ? "present" : "missing"
    const probeRole = probeRoleFor(config, endpoint.id)
    const readiness: EndpointReadiness = {
      endpointId: endpoint.id,
      kind: endpoint.kind,
      baseUrl: endpoint.baseUrl,
      reachable: false,
      credential,
      models: [],
    }
    if (!probeRole) {
      // Nothing routes here, so nothing was asked of it. Reported, not judged.
      readiness.error = "no role is bound to this endpoint; not probed"
      endpoints.push(readiness)
      continue
    }
    try {
      const client = createClient(config, probeRole, environment)
      const models = await client.listModels(options.signal)
      readiness.reachable = true
      readiness.models = models
      catalogs.set(endpoint.id, models)
      await client.close()
    } catch (error) {
      readiness.error = describe(error)
    }
    endpoints.push(readiness)
  }

  const roles: RoleReadiness[] = []
  for (const [role, binding] of Object.entries(config.roles)) {
    if (!binding) continue
    const catalog = catalogs.get(binding.endpoint)
    const entry: RoleReadiness = {
      role: role as ModelRole,
      endpointId: binding.endpoint,
      model: binding.model,
      // An unreachable or catalog-less endpoint is not evidence the model is absent.
      modelAvailable: catalog ? catalog.includes(binding.model) : false,
    }
    if (options.probeStructured && catalog) {
      const probe = await probeStructuredMode(config, role as ModelRole, environment, options.signal)
      if ("error" in probe) entry.error = probe.error
      else entry.structuredMode = probe.mode
    }
    roles.push(entry)
  }

  // Readiness is decided by the endpoints roles actually bind to. An endpoint
  // left in the file for later — unreachable, or missing a credential nothing
  // asks for — says nothing about whether this configuration can run.
  const bound = new Set(Object.values(config.roles).filter((binding) => binding).map((binding) => binding!.endpoint))
  const inUse = endpoints.filter((endpoint) => bound.has(endpoint.endpointId))
  const ready = roles.length > 0
    && inUse.length > 0
    && inUse.every((endpoint) => endpoint.reachable && endpoint.credential !== "missing")
  return { ready, endpoints, roles }
}

async function probeStructuredMode(
  config: ModelConfig,
  role: ModelRole,
  environment: Environment,
  signal?: AbortSignal,
): Promise<{ mode: StructuredMode } | { error: string }> {
  const client = createClient(config, role, environment)
  try {
    const response = await client.complete({
      system: "You return only the requested JSON object.",
      input: 'Return {"ok": true}.',
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean" } },
      },
      schemaName: "cyrion_probe",
      maxOutputTokens: 64,
      timeoutMs: 60_000,
      ...(signal ? { signal } : {}),
    })
    return { mode: response.mode }
  } catch (error) {
    return { error: describe(error) }
  } finally {
    await client.close()
  }
}

function probeRoleFor(config: ModelConfig, endpointId: string): ModelRole | undefined {
  const entry = Object.entries(config.roles).find(([, binding]) => binding?.endpoint === endpointId)
  return entry?.[0] as ModelRole | undefined
}
