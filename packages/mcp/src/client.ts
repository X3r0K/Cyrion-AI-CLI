import type { McpServerConfig, McpToolBinding } from "./config"
import {
  FrameReader,
  JSONRPC_VERSION,
  MCP_PROTOCOL_VERSION,
  encodeFrame,
  type JsonRpcResponse,
} from "./protocol"

export interface McpCallResult {
  /** Bounded text the server returned. Untrusted data, never instructions. */
  text: string
  truncated: boolean
  /** The server reported the call itself as failed. */
  isError: boolean
  durationMs: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 200_000

/**
 * Talks to one operator-approved MCP server over stdio.
 *
 * The server is a subprocess with a scrubbed environment: it inherits nothing
 * the operator did not name, gets no shell, and is killed with its process
 * group. A tool outside the declared allowlist is refused here rather than
 * asked for, so a server that grows new tools does not silently grow Cyrion's
 * reach — and everything it returns is bounded text the caller must treat as
 * untrusted.
 */
export class McpStdioClient {
  readonly #config: McpServerConfig
  readonly #reader = new FrameReader()
  readonly #pending = new Map<number, (response: JsonRpcResponse) => void>()
  #process: ReturnType<typeof Bun.spawn> | undefined
  #nextId = 1
  #closed = false
  #serverInfo: { name?: string; version?: string } | undefined

  constructor(config: McpServerConfig) {
    this.#config = config
  }

  get id(): string {
    return this.#config.id
  }

  get serverInfo(): { name?: string; version?: string } | undefined {
    return this.#serverInfo
  }

  /** Tool names this configuration allows, whatever the server advertises. */
  get allowedTools(): string[] {
    return this.#config.tools.map((tool) => tool.tool)
  }

  binding(capability: string): McpToolBinding | undefined {
    return this.#config.tools.find((tool) => tool.capability === capability)
  }

  async start(): Promise<void> {
    if (this.#process) return
    const environment: Record<string, string> = {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C",
      NO_COLOR: "1",
    }
    // Named variables only: an MCP server that needs a secret is handed exactly
    // the one the operator listed, and nothing else from their shell.
    for (const name of this.#config.passEnv ?? []) {
      const value = Bun.env[name]
      if (value) environment[name] = value
    }
    Object.assign(environment, this.#config.env ?? {})

    // Resolve on the operator's PATH, then run with the scrubbed one: an MCP
    // server installed under a version manager still starts, and still starts
    // without inheriting the rest of their shell.
    const executable = this.#config.command.includes("/")
      ? this.#config.command
      : Bun.which(this.#config.command)
    if (!executable) {
      throw new Error(`MCP server ${this.id} command is not on PATH: ${this.#config.command}`)
    }

    this.#process = Bun.spawn({
      cmd: [executable, ...(this.#config.args ?? [])],
      ...(this.#config.cwd ? { cwd: this.#config.cwd } : {}),
      env: environment,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    void this.#pump()

    const initialize = await this.#request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "cyrion-community", version: "0.1.0-alpha.2" },
    }, this.#config.startTimeoutMs ?? DEFAULT_TIMEOUT_MS)
    if (initialize.error) throw new Error(`MCP server ${this.id} refused initialize: ${initialize.error.message}`)
    const info = (initialize.result as { serverInfo?: { name?: string; version?: string } } | undefined)?.serverInfo
    this.#serverInfo = info ? { ...info } : {}
    this.#notify("notifications/initialized", {})
  }

  /** Tools the server advertises, intersected with what the operator allowed. */
  async listTools(): Promise<Array<{ name: string; description?: string; allowed: boolean }>> {
    await this.start()
    const response = await this.#request("tools/list", {}, DEFAULT_TIMEOUT_MS)
    if (response.error) throw new Error(`MCP server ${this.id} refused tools/list: ${response.error.message}`)
    const tools = (response.result as { tools?: Array<{ name?: unknown; description?: unknown }> } | undefined)?.tools ?? []
    const allowed = new Set(this.allowedTools)
    return tools
      .filter((tool) => typeof tool.name === "string")
      .map((tool) => ({
        name: String(tool.name),
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        allowed: allowed.has(String(tool.name)),
      }))
  }

  async call(toolName: string, input: unknown): Promise<McpCallResult> {
    const binding = this.#config.tools.find((tool) => tool.tool === toolName)
    if (!binding) {
      throw new Error(`Tool ${toolName} is not allowed for MCP server ${this.id}. Add it to mcp.json to enable it.`)
    }
    await this.start()
    const started = performance.now()
    const response = await this.#request(
      "tools/call",
      { name: toolName, arguments: input ?? {} },
      binding.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    const durationMs = Math.max(0, Math.round(performance.now() - started))
    if (response.error) throw new Error(`MCP tool ${toolName} failed: ${response.error.message}`)

    const payload = response.result as { content?: Array<{ type?: string; text?: unknown }>; isError?: boolean } | undefined
    const text = (payload?.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => String(block.text))
      .join("\n")
    const limit = binding.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const truncated = text.length > limit
    return {
      text: truncated ? text.slice(0, limit) : text,
      truncated,
      isError: payload?.isError === true,
      durationMs,
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    for (const resolve of this.#pending.values()) {
      resolve({ jsonrpc: JSONRPC_VERSION, id: null, error: { code: -32000, message: "client closed" } })
    }
    this.#pending.clear()
    const child = this.#process
    this.#process = undefined
    if (!child) return
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      child.kill("SIGKILL")
    }
    await child.exited.catch(() => undefined)
  }

  async #pump(): Promise<void> {
    const stdout = this.#process?.stdout
    if (!stdout || typeof stdout === "number") return
    const decoder = new TextDecoder()
    try {
      for await (const chunk of stdout as ReadableStream<Uint8Array>) {
        for (const frame of this.#reader.push(decoder.decode(chunk, { stream: true }))) {
          let message: JsonRpcResponse
          try {
            message = JSON.parse(frame) as JsonRpcResponse
          } catch {
            continue
          }
          const id = typeof message.id === "number" ? message.id : undefined
          if (id === undefined) continue
          this.#pending.get(id)?.(message)
          this.#pending.delete(id)
        }
      }
    } catch {
      // A closed or oversized stream ends the conversation; pending calls time out.
    }
  }

  async #request(method: string, params: unknown, timeoutMs: number): Promise<JsonRpcResponse> {
    const id = this.#nextId++
    const stdin = this.#process?.stdin
    if (!stdin || typeof stdin === "number") throw new Error(`MCP server ${this.id} is not running`)

    const answered = new Promise<JsonRpcResponse>((resolve) => {
      this.#pending.set(id, resolve)
    })
    stdin.write(encodeFrame({ jsonrpc: JSONRPC_VERSION, id, method, params }))
    stdin.flush?.()

    const timeout = new Promise<JsonRpcResponse>((resolve) => {
      setTimeout(() => resolve({
        jsonrpc: JSONRPC_VERSION,
        id,
        error: { code: -32001, message: `${method} timed out after ${timeoutMs}ms` },
      }), timeoutMs)
    })
    const response = await Promise.race([answered, timeout])
    this.#pending.delete(id)
    return response
  }

  #notify(method: string, params: unknown): void {
    const stdin = this.#process?.stdin
    if (!stdin || typeof stdin === "number") return
    stdin.write(encodeFrame({ jsonrpc: JSONRPC_VERSION, method, params }))
    stdin.flush?.()
  }
}
