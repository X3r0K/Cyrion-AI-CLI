const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

export interface JsonRequest {
  url: string
  headers: Record<string, string>
  body: unknown
  timeoutMs?: number
  maxBytes?: number
  signal?: AbortSignal
  /** Credential values that must never appear in an error message. */
  secrets?: readonly string[]
}

export interface JsonResult {
  status: number
  ok: boolean
  text: string
  json?: unknown
}

/** POST JSON with a hard timeout, a response-size ceiling, and credential-safe errors. */
export async function postJson(request: JsonRequest): Promise<JsonResult> {
  return send({ ...request, method: "POST" })
}

export async function getJson(request: Omit<JsonRequest, "body">): Promise<JsonResult> {
  return send({ ...request, method: "GET", body: undefined })
}

async function send(request: JsonRequest & { method: "GET" | "POST" }): Promise<JsonResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(`Model request timed out after ${timeoutMs}ms`)), timeoutMs)
  const onAbort = (): void => controller.abort(request.signal?.reason)
  request.signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: { accept: "application/json", ...request.headers },
      ...(request.method === "POST" ? { body: JSON.stringify(request.body ?? {}) } : {}),
      signal: controller.signal,
    })
    const text = await readBounded(response, request.maxBytes ?? DEFAULT_MAX_BYTES)
    let json: unknown
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    return { status: response.status, ok: response.ok, text, ...(json === undefined ? {} : { json }) }
  } catch (error) {
    throw new Error(redact(describe(error), request.secrets ?? []))
  } finally {
    clearTimeout(timeout)
    request.signal?.removeEventListener("abort", onAbort)
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`Model response exceeded ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

/** Removes credential values and anything that looks like a bearer token. */
export function redact(text: string, secrets: readonly string[]): string {
  let output = text
  for (const secret of secrets) {
    if (secret && secret.length >= 4) output = output.split(secret).join("[redacted]")
  }
  return output
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|x-api-key|authorization)["'\s:=]+)[A-Za-z0-9._~+/-]{8,}/gi, "$1[redacted]")
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Bounded, control-character-free provider diagnostic suitable for an event payload. */
export function diagnostic(value: unknown, secrets: readonly string[] = [], maxLength = 400): string {
  const text = typeof value === "string" ? value : describe(value)
  const clean = [...redact(text, secrets)]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code === 9 || code === 10 || (code >= 32 && code !== 127 && !(code >= 128 && code <= 159))
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength)}…`
}
