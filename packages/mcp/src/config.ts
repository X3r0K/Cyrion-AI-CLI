export const MCP_CONFIG_VERSION = "cyrion.community/mcp-v1" as const

/**
 * One operator-approved MCP server.
 *
 * A server is a source of capabilities, so it is declared the way scope is:
 * explicitly, with an allowlist rather than a wildcard. A tool the operator did
 * not name cannot be called, whatever the server advertises, and every tool
 * must map to a capability the engagement manifest already grants.
 */
export interface McpToolBinding {
  /** Tool name as the server advertises it. */
  tool: string
  /** Cyrion capability this tool answers as. Must appear in the manifest. */
  capability: string
  /** Wall clock for one call. */
  timeoutMs?: number
  /** Bytes of result text admitted from one call. */
  maxOutputBytes?: number
}

export interface McpServerConfig {
  id: string
  /** Executable and argv. No shell: the operator's own string is never parsed. */
  command: string
  args?: string[]
  /**
   * Variables passed through from the operator's environment, by name. A server
   * that needs a secret is given it here deliberately, or it is not enabled.
   */
  passEnv?: string[]
  /** Extra environment entries. Never a place for a credential. */
  env?: Record<string, string>
  cwd?: string
  startTimeoutMs?: number
  tools: McpToolBinding[]
}

export interface McpConfig {
  version: typeof MCP_CONFIG_VERSION
  servers: McpServerConfig[]
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const environmentName = /^[A-Z][A-Z0-9_]{0,63}$/

export function mcpConfigError(value: unknown): string | undefined {
  if (!isRecord(value)) return "configuration must be an object"
  const extra = unexpectedKey(value, ["version", "servers"])
  if (extra) return `unexpected field ${extra}`
  if (value.version !== MCP_CONFIG_VERSION) return "unsupported MCP configuration version"
  if (!Array.isArray(value.servers) || !value.servers.length || value.servers.length > 32) {
    return "servers must be an array of 1 to 32 entries"
  }
  const ids = new Set<string>()
  const capabilities = new Set<string>()
  for (const [index, server] of value.servers.entries()) {
    const error = serverError(server, `servers[${index}]`, capabilities)
    if (error) return error
    const id = (server as McpServerConfig).id
    if (ids.has(id)) return `duplicate server id ${id}`
    ids.add(id)
  }
  return undefined
}

export function assertMcpConfig(value: unknown): asserts value is McpConfig {
  const error = mcpConfigError(value)
  if (error) throw new Error(`Invalid MCP configuration: ${error}`)
}

function serverError(value: unknown, path: string, capabilities: Set<string>): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`
  const extra = unexpectedKey(value, ["id", "command", "args", "passEnv", "env", "cwd", "startTimeoutMs", "tools"])
  if (extra) return `${path} contains unexpected field ${extra}`
  if (!identifier.test(String(value.id))) return `${path}.id must be a safe identifier`
  if (typeof value.command !== "string" || !value.command.trim() || value.command.length > 512) {
    return `${path}.command must be a bounded string`
  }
  if ("args" in value) {
    if (!Array.isArray(value.args) || value.args.length > 64) return `${path}.args must be an array of at most 64 entries`
    if (value.args.some((arg) => typeof arg !== "string" || arg.length > 1_024)) {
      return `${path}.args contains an invalid entry`
    }
  }
  if ("passEnv" in value) {
    if (!Array.isArray(value.passEnv) || value.passEnv.length > 32) return `${path}.passEnv must be an array of at most 32 names`
    if (value.passEnv.some((name) => typeof name !== "string" || !environmentName.test(name))) {
      return `${path}.passEnv must name environment variables, such as GITHUB_TOKEN`
    }
  }
  if ("env" in value) {
    if (!isRecord(value.env)) return `${path}.env must be an object`
    for (const [name, entry] of Object.entries(value.env)) {
      if (!environmentName.test(name)) return `${path}.env contains an invalid variable name: ${name}`
      if (typeof entry !== "string" || entry.length > 1_024) return `${path}.env.${name} must be a bounded string`
      if (looksLikeCredential(entry)) {
        return `${path}.env.${name} looks like a credential. Name the variable in passEnv instead, so the secret `
          + "stays in your environment rather than in this file"
      }
    }
  }
  if ("cwd" in value && (typeof value.cwd !== "string" || !value.cwd.length || value.cwd.length > 1_024)) {
    return `${path}.cwd must be a bounded string`
  }
  if ("startTimeoutMs" in value && !boundedInteger(value.startTimeoutMs, 100, 120_000)) {
    return `${path}.startTimeoutMs must be between 100 and 120000`
  }
  if (!Array.isArray(value.tools) || !value.tools.length || value.tools.length > 64) {
    return `${path}.tools must be an array of 1 to 64 entries`
  }
  const seen = new Set<string>()
  for (const [index, tool] of value.tools.entries()) {
    const error = toolError(tool, `${path}.tools[${index}]`)
    if (error) return error
    const binding = tool as McpToolBinding
    if (seen.has(binding.tool)) return `${path}.tools lists ${binding.tool} more than once`
    seen.add(binding.tool)
    // Two servers answering as the same capability would make a result's origin
    // ambiguous, and evidence has to say where it came from.
    if (capabilities.has(binding.capability)) {
      return `capability ${binding.capability} is claimed by more than one MCP tool`
    }
    capabilities.add(binding.capability)
  }
  return undefined
}

function toolError(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`
  const extra = unexpectedKey(value, ["tool", "capability", "timeoutMs", "maxOutputBytes"])
  if (extra) return `${path} contains unexpected field ${extra}`
  if (typeof value.tool !== "string" || !value.tool.length || value.tool.length > 128) {
    return `${path}.tool must be a bounded string`
  }
  if (!identifier.test(String(value.capability))) return `${path}.capability must be a safe capability name`
  if ("timeoutMs" in value && !boundedInteger(value.timeoutMs, 1, 60_000)) {
    return `${path}.timeoutMs must be between 1 and 60000`
  }
  if ("maxOutputBytes" in value && !boundedInteger(value.maxOutputBytes, 1, 1_000_000)) {
    return `${path}.maxOutputBytes must be between 1 and 1000000`
  }
  return undefined
}

/** Capabilities the configuration would expose, for checking against a manifest. */
export function declaredCapabilities(config: McpConfig): string[] {
  return config.servers.flatMap((server) => server.tools.map((tool) => tool.capability))
}

/**
 * Capabilities declared here that the manifest never granted.
 *
 * A configured server is not an authorization: the manifest still decides what
 * a worker may call, and an unbacked capability is a configuration mistake
 * worth naming before a run rather than a silent no-op during one.
 */
export function ungrantedCapabilities(config: McpConfig, granted: readonly string[]): string[] {
  return [...new Set(declaredCapabilities(config).filter((capability) => !granted.includes(capability)))]
}

function looksLikeCredential(value: string): boolean {
  return /^(sk-|pk-|sk_|rk_|ghp_|gho_|xoxb-|AIza|hf_|r8_)/.test(value)
}

function boundedInteger(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function unexpectedKey(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key))
}
