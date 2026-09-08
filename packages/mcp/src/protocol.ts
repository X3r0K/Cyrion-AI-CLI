/**
 * Minimal JSON-RPC 2.0 over newline-delimited JSON, the transport MCP uses on
 * stdio.
 *
 * Written rather than depended on, for the same reason the contracts are: this
 * is a boundary where untrusted messages arrive, and a boundary Cyrion cannot
 * read is a boundary Cyrion cannot defend. Every frame is bounded before it is
 * parsed, and a malformed one is answered rather than thrown.
 */

export const JSONRPC_VERSION = "2.0" as const
export const MCP_PROTOCOL_VERSION = "2025-06-18" as const

/** A single frame ceiling. A peer that exceeds it is disconnected, not buffered. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024

export type JsonRpcId = string | number

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION
  id?: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: typeof JSONRPC_VERSION
  id: JsonRpcId | null
  result?: unknown
  error?: JsonRpcError
}

export const errorCodes = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const

export function jsonRpcRequestError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "message must be an object"
  const message = value as Record<string, unknown>
  if (message.jsonrpc !== JSONRPC_VERSION) return "jsonrpc must be \"2.0\""
  if (typeof message.method !== "string" || !message.method.length || message.method.length > 128) {
    return "method must be a bounded string"
  }
  if ("id" in message && typeof message.id !== "string" && typeof message.id !== "number" && message.id !== null) {
    return "id must be a string, a number, or null"
  }
  if ("params" in message && (typeof message.params !== "object" || message.params === null)) {
    return "params must be an object or an array"
  }
  return undefined
}

export function result(id: JsonRpcId | null, value: unknown): JsonRpcResponse {
  return { jsonrpc: JSONRPC_VERSION, id, result: value }
}

export function failure(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

/** One frame per line, so a partial write can never be read as a whole message. */
export function encodeFrame(message: JsonRpcResponse | JsonRpcRequest): string {
  return `${JSON.stringify(message)}\n`
}

/**
 * Splits a byte stream into frames.
 *
 * Holds at most one frame in memory: a line that grows past the ceiling ends
 * the stream instead of consuming the process's memory.
 */
export class FrameReader {
  #buffer = ""
  readonly #maxBytes: number

  constructor(maxBytes = MAX_FRAME_BYTES) {
    this.#maxBytes = maxBytes
  }

  /** Returns the complete frames in this chunk, or throws when one is oversized. */
  push(chunk: string): string[] {
    this.#buffer += chunk
    const frames: string[] = []
    let index = this.#buffer.indexOf("\n")
    while (index >= 0) {
      const frame = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (frame) frames.push(frame)
      index = this.#buffer.indexOf("\n")
    }
    if (this.#buffer.length > this.#maxBytes) {
      throw new Error(`A single JSON-RPC frame exceeded ${this.#maxBytes} bytes`)
    }
    return frames
  }
}

/** MCP content blocks. Everything Cyrion returns is text a caller must not trust. */
export function textContent(value: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: value }] }
}

export function jsonContent(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return textContent(JSON.stringify(value, null, 2))
}
