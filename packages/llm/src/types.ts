import type { ResourceUsage } from "@cyrion/contracts"

/** Model duties the controller distinguishes. Each may bind to a different endpoint. */
export type ModelRole = "planner" | "worker" | "validator" | "reporter" | "embedding"

export const modelRoles: readonly ModelRole[] = ["planner", "worker", "validator", "reporter", "embedding"]

/** Endpoint families. One HTTP shape each; most providers speak the first. */
export type EndpointKind = "openai-compatible" | "anthropic" | "ollama"

export interface ModelEndpoint {
  id: string
  kind: EndpointKind
  baseUrl: string
  /** Environment variable holding the credential. The value is never stored or logged. */
  apiKeyEnv?: string
  /** Allows plaintext HTTP to a non-loopback host. Off by default: engagement data is sensitive. */
  allowInsecure?: boolean
}

export interface ModelPricing {
  inputPer1kUsd: number
  outputPer1kUsd: number
}

export interface RoleBinding {
  endpoint: string
  model: string
  maxOutputTokens?: number
  temperature?: number
  /** Absent means the run reports zero cost rather than an invented one. */
  pricing?: ModelPricing
}

export interface ModelConfig {
  endpoints: ModelEndpoint[]
  roles: Partial<Record<ModelRole, RoleBinding>>
}

/** How a structured response was actually obtained. Discovered once per endpoint and cached. */
export type StructuredMode =
  | "json-schema"
  | "guided-json"
  | "tool-call"
  | "json-object"
  | "native-format"
  | "strict-text"

export interface ModelRequest {
  system: string
  input: string
  /** When present, the response must satisfy this JSON Schema. */
  schema?: Record<string, unknown>
  schemaName?: string
  /**
   * The caller's own contract check, returning a reason when the object is not
   * acceptable. A JSON Schema is a request; many servers ignore or only
   * partially honour it, so a mode counts as working when what came back
   * satisfies this — not merely when it parsed as an object.
   */
  validate?: (value: unknown) => string | undefined
  maxOutputTokens?: number
  temperature?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export interface ModelResponse {
  text: string
  structured?: unknown
  usage: ResourceUsage
  mode: StructuredMode
}

export interface ModelClient {
  readonly id: string
  readonly endpoint: ModelEndpoint
  readonly model: string
  complete(request: ModelRequest): Promise<ModelResponse>
  /** Model identifiers the endpoint reports, for readiness output and pickers. */
  listModels(signal?: AbortSignal): Promise<string[]>
  close(): Promise<void>
}

export interface EndpointReadiness {
  endpointId: string
  kind: EndpointKind
  baseUrl: string
  reachable: boolean
  credential: "present" | "missing" | "not-required"
  models: string[]
  error?: string
}

export interface RoleReadiness {
  role: ModelRole
  endpointId: string
  model: string
  modelAvailable: boolean
  structuredMode?: StructuredMode
  error?: string
}

export interface LlmReadiness {
  ready: boolean
  endpoints: EndpointReadiness[]
  roles: RoleReadiness[]
}
