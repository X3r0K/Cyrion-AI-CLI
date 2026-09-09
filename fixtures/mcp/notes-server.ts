#!/usr/bin/env bun
/**
 * A tiny MCP server, so the client side can be tested against something that is
 * not Cyrion.
 *
 * It speaks the same newline-delimited JSON-RPC the real thing does and holds
 * no state. `lookup_note` echoes the arguments it was given, which is how a
 * test checks that a worker's typed input reaches the server unchanged;
 * `broken_note` reports its own failure the way a real server does; and
 * `long_note` answers with more text than a binding will admit.
 */
const encoder = new TextEncoder()

function write(message: unknown): void {
  process.stdout.write(encoder.encode(`${JSON.stringify(message)}\n`))
}

function text(value: string, isError = false): object {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) }
}

const tools = [
  {
    name: "lookup_note",
    description: "Return the note named in the arguments.",
    inputSchema: { type: "object", properties: { subject: { type: "string" } } },
  },
  { name: "broken_note", description: "Always reports an error.", inputSchema: { type: "object", properties: {} } },
  { name: "long_note", description: "Answers with more text than fits.", inputSchema: { type: "object", properties: {} } },
  { name: "unlisted_note", description: "Advertised, never allowed.", inputSchema: { type: "object", properties: {} } },
]

function handle(message: { id?: unknown; method?: unknown; params?: Record<string, unknown> }): object | undefined {
  const id = (message.id ?? null) as string | number | null
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "notes-fixture", version: "1.4.2" },
      },
    }
  }
  if (typeof message.method === "string" && message.method.startsWith("notifications/")) return undefined
  if (message.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools } }
  if (message.method === "tools/call") {
    const name = message.params?.name
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>
    if (name === "lookup_note") {
      return { jsonrpc: "2.0", id, result: text(`note for ${JSON.stringify(args)}`) }
    }
    if (name === "broken_note") {
      return { jsonrpc: "2.0", id, result: text("the note store is unavailable", true) }
    }
    if (name === "long_note") return { jsonrpc: "2.0", id, result: text("n".repeat(4_096)) }
    if (name === "unlisted_note") return { jsonrpc: "2.0", id, result: text("this should never be reachable") }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool ${String(name)}` } }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported method ${String(message.method)}` } }
}

let buffered = ""
const decoder = new TextDecoder()
for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk as Uint8Array, { stream: true })
  let newline = buffered.indexOf("\n")
  while (newline >= 0) {
    const frame = buffered.slice(0, newline)
    buffered = buffered.slice(newline + 1)
    if (frame.trim()) {
      try {
        const response = handle(JSON.parse(frame))
        if (response) write(response)
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })
      }
    }
    newline = buffered.indexOf("\n")
  }
}
