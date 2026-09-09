import { POC_MAX_BODY_BYTES, POC_METHODS, redactHeaders, type ToolExecutionRequest } from "@cyrion/contracts"
import { OperatorCredentials } from "@cyrion/credentials"
import { parseHttpResponse, resolveEntry } from "./poc"
import { checkPinnedAddress, checkRedirect, evaluateScope, parseTarget } from "@cyrion/scope"
import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "./types"

const MAX_BODY_PREVIEW = 64 * 1024
/** Body text a worker may read back from one request. The artifact holds it all. */
const MAX_BODY_SUMMARY = 16 * 1024
/** Header value length a summary carries. Values are target-controlled. */
const MAX_HEADER_VALUE = 512
const USER_AGENT = "cyrion-community/0.1 (+authorized assessment)"

/**
 * One HTTP exchange with an approved URL, captured in full as evidence.
 *
 * Redirects are never followed automatically: each hop is re-validated against
 * scope, and a hop that leaves it is reported rather than chased. When the host
 * was pinned by `dns.lookup`, a resolution that no longer matches the pin fails
 * the call.
 */
export const httpProbe: CapabilityAdapter = {
  capability: "http.probe",
  containerBinary: "curl",

  async execute(
    request: ToolExecutionRequest,
    context: CapabilityContext,
    signal: AbortSignal,
  ): Promise<CapabilityResult> {
    const decision = evaluateScope(context.scope, request.target)
    if (!decision.allowed) throw new Error(`http.probe refused: ${decision.reason}`)
    const target = parseTarget(request.target)
    if (target.kind !== "url") throw new Error("http.probe needs a URL target")

    const input = (request.input ?? {}) as { method?: unknown; headers?: unknown }
    const method = typeof input.method === "string" ? input.method.toUpperCase() : "GET"
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      throw new Error(`http.probe allows GET, HEAD, or OPTIONS, not ${method}`)
    }

    const url = new URL(target.raw.replace(/\*$/, ""))
    await assertPinnedHost(url, context, "http.probe")
    const exchange = await httpExchange(url, method, request, context, signal)
    const { status, headers, durationMs } = exchange
    const body = { text: exchange.body, truncated: exchange.truncated }
    const location = headers.location ?? null
    const redirect = location
      ? checkRedirect(context.scope, url.toString(), new URL(location, url).toString())
      : undefined

    const record = {
      request: { method, url: url.toString() },
      response: {
        status,
        headers,
        durationMs,
        bodyBytes: body.text.length,
        bodyTruncated: body.truncated,
      },
      ...(redirect ? { redirect: { location, followed: false, decision: redirect } } : {}),
      body: body.text,
    }
    const evidence = await context.evidence.capture({
      engagementId: request.engagementId,
      id: context.nextEvidenceId("E"),
      kind: "response",
      content: `${JSON.stringify(record, null, 2)}\n`,
      contentType: "application/json",
      source: request.agentId,
    })

    return {
      summary: {
        status,
        // Names only: enough to check which protections are set, without
        // carrying attacker-controlled values into every downstream summary.
        headerNames: Object.keys(headers).map((name) => name.toLowerCase()).sort(),
        server: headers.server ?? null,
        contentType: headers["content-type"] ?? null,
        durationMs,
        bodyBytes: body.text.length,
        ...(redirect
          ? { redirect: { location, inScope: redirect.allowed, reason: redirect.reason ?? null } }
          : {}),
      },
      evidence: [evidence],
      outcome: `${status}${headers["content-type"] ? ` ${headers["content-type"].split(";")[0]}` : ""}`
        + `${body.text.length ? ` · ${bytes(body.text.length)}` : ""}`
        + `${redirect ? ` · redirect ${redirect.allowed ? "in scope" : "refused"}` : ""}`,
    }
  },
}

/**
 * One typed request against an approved URL, answered in full.
 *
 * `http.probe` inventories what an asset is; this asks it a specific question —
 * a path under the approved target, chosen request headers, and an answer whose
 * headers and body a caller can actually read. That is what makes a
 * methodology executable from a skill file rather than from code, and it is why
 * the path is re-checked against scope: a check may ask about anything the
 * operator approved, and nothing else.
 */
export const httpRequest: CapabilityAdapter = {
  capability: "http.request",
  containerBinary: "curl",

  async execute(
    request: ToolExecutionRequest,
    context: CapabilityContext,
    signal: AbortSignal,
  ): Promise<CapabilityResult> {
    const target = parseTarget(request.target)
    if (target.kind !== "url") throw new Error("http.request needs a URL target")

    const input = (request.input ?? {}) as {
      method?: unknown
      path?: unknown
      headers?: unknown
      body?: unknown
    }
    const method = typeof input.method === "string" ? input.method.toUpperCase() : "GET"
    if (!(POC_METHODS as readonly string[]).includes(method)) {
      throw new Error(`http.request allows ${POC_METHODS.join(", ")}, not ${method}`)
    }
    const headers = requestHeaders(input.headers)
    const body = typeof input.body === "string" ? input.body : undefined
    if (body !== undefined && Buffer.byteLength(body, "utf8") > POC_MAX_BODY_BYTES) {
      throw new Error(`http.request body exceeds ${POC_MAX_BODY_BYTES} bytes`)
    }

    const base = new URL(target.raw.replace(/\*$/, ""))
    const url = typeof input.path === "string" && input.path.length ? resolvePath(base, input.path) : base
    // The path is where a check could reach past what was approved, so the URL
    // that will actually be requested is the one the scope decides on.
    const decision = evaluateScope(context.scope, url.toString())
    if (!decision.allowed) throw new Error(`http.request refused: ${decision.reason}`)

    await assertPinnedHost(url, context, "http.request")
    const exchange = await httpExchange(url, method, request, context, signal, headers, body)
    const { status, headers: responseHeaders, durationMs } = exchange
    const location = responseHeaders.location ?? null
    const redirect = location
      ? checkRedirect(context.scope, url.toString(), new URL(location, url).toString())
      : undefined

    const record = {
      // Redacted on the way to disk. The request has to be in the artifact for
      // the finding to mean anything; the operator's session token does not,
      // and an artifact carrying one cannot safely be attached to a report.
      request: {
        method,
        url: url.toString(),
        headers: redactHeaders({ "user-agent": USER_AGENT, ...headers }),
        ...(body !== undefined ? { body } : {}),
      },
      response: {
        status,
        headers: redactHeaders(responseHeaders),
        durationMs,
        bodyBytes: exchange.body.length,
        bodyTruncated: exchange.truncated,
      },
      ...(redirect ? { redirect: { location, followed: false, decision: redirect } } : {}),
      body: exchange.body,
    }
    const evidence = await context.evidence.capture({
      engagementId: request.engagementId,
      id: context.nextEvidenceId("E"),
      kind: "response",
      content: `${JSON.stringify(record, null, 2)}\n`,
      contentType: "application/json",
      source: request.agentId,
    })

    return {
      summary: {
        url: url.toString(),
        method,
        status,
        headerNames: Object.keys(responseHeaders).map((name) => name.toLowerCase()).sort(),
        // Values are the target's words, so they are bounded here and belong in
        // a condition rather than in prose a reader will take at face value.
        headers: boundedHeaders(responseHeaders),
        contentType: responseHeaders["content-type"] ?? null,
        server: responseHeaders.server ?? null,
        durationMs,
        bodyBytes: exchange.body.length,
        bodyTruncated: exchange.truncated || exchange.body.length > MAX_BODY_SUMMARY,
        body: exchange.body.slice(0, MAX_BODY_SUMMARY),
        ...(redirect
          ? { redirect: { location, inScope: redirect.allowed, reason: redirect.reason ?? null } }
          : {}),
      },
      evidence: [evidence],
      outcome: `${method} ${url.pathname} → ${status}`
        + `${responseHeaders["content-type"] ? ` ${responseHeaders["content-type"].split(";")[0]}` : ""}`
        + `${exchange.body.length ? ` · ${bytes(exchange.body.length)}` : ""}`,
    }
  },
}

/** Resolves a check's path under the approved target, without leaving the origin. */
function resolvePath(base: URL, path: string): URL {
  const resolved = new URL(path, base)
  if (resolved.origin !== base.origin) throw new Error("http.request path must stay on the approved origin")
  return resolved
}

/** Headers a request may carry: bounded, and never a credential. */
function requestHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("http.request headers must be an object")
  }
  const headers: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value as Record<string, unknown>).slice(0, 8)) {
    const lower = name.toLowerCase()
    if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name)) throw new Error(`http.request header name is invalid: ${name}`)
    // A credential may be sent — testing authorization requires authenticating.
    // Its value is redacted wherever the exchange is written to disk.
    if (typeof entry !== "string" || !entry.length || entry.length > 1_024) {
      throw new Error(`http.request header ${lower} must be a bounded string`)
    }
    if (/[\u0000-\u001F\u007F-\u009F]/.test(entry)) throw new Error(`http.request header ${lower} is invalid`)
    headers[lower] = entry
  }
  return headers
}

function boundedHeaders(headers: Record<string, string>): Record<string, string> {
  const bounded: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers).slice(0, 64)) {
    bounded[name.toLowerCase()] = value.slice(0, MAX_HEADER_VALUE)
  }
  return bounded
}

/** Bytes an operator can read at a glance. */
function bytes(count: number): string {
  return count < 1_024 ? `${count} B` : `${(count / 1_024).toFixed(1)} kB`
}

/**
 * Sends one request the way this run's sandbox requires.
 *
 * Local mode leaves from this process; container mode leaves from inside the
 * container, where the kernel egress allowlist governs it. Every HTTP
 * capability goes through here so none of them can quietly pick the other path.
 */
export async function httpExchange(
  url: URL,
  method: string,
  request: ToolExecutionRequest,
  context: CapabilityContext,
  signal: AbortSignal,
  headers: Record<string, string> = {},
  body?: string,
): Promise<HttpExchange> {
  // The last moment before bytes leave, and the first at which a credential
  // exists as its value rather than its name. Every caller above this line
  // holds `${cred:...}`, which is what reaches the evidence record, the event
  // log, and any prompt built from them. Resolving here rather than at the
  // caller is what makes that true of all of them at once.
  const sent = resolveCredentials(headers, url, context)
  const exchange = context.runner.kind === "container"
    ? await probeThroughContainer(url, method, request, context, signal, sent, body)
    : await probeInProcess(url, method, signal, sent, body)
  // A target that echoes the credential back would otherwise put it into a
  // summary, an artifact, and from there a prompt.
  return scrubExchange(exchange, context)
}

/**
 * Substitutes the operator's credentials for the references a check named.
 *
 * A reference to a credential that does not exist, or one bound to a different
 * host, fails the call. Sending the request without it would produce a 401 that
 * reads exactly like a finding, and quietly sending it to the wrong host is the
 * leak this store exists to prevent.
 */
function resolveCredentials(
  headers: Record<string, string>,
  url: URL,
  context: CapabilityContext,
): Record<string, string> {
  const referenced = Object.values(headers).some((value) => OperatorCredentials.references(value).length)
  if (!referenced) return headers
  if (!context.credentials) {
    const names = Object.values(headers).flatMap((value) => OperatorCredentials.references(value))
    throw new Error(
      `This check references the credential ${names.map((name) => `"${name}"`).join(", ")}, `
      + "but no credential store was loaded for this engagement.",
    )
  }
  return context.credentials.resolveHeaders(headers, url)
}

function scrubExchange(exchange: HttpExchange, context: CapabilityContext): HttpExchange {
  if (!context.credentials?.size) return exchange
  return {
    ...exchange,
    headers: context.credentials.scrubHeaders(exchange.headers),
    body: context.credentials.scrub(exchange.body),
  }
}

/**
 * Holds a hostname to the addresses this engagement pinned.
 *
 * A name that starts answering with a new address mid-run is how a target
 * reaches somewhere the operator never approved, so the check is repeated per
 * request rather than trusted from the first lookup.
 */
export async function assertPinnedHost(
  url: URL,
  context: CapabilityContext,
  capability: string,
): Promise<void> {
  const pin = context.pins.get(url.hostname.toLowerCase())
  if (!pin) return
  const { promises: dns } = await import("node:dns")
  const current = await dns.lookup(url.hostname, { all: true }).catch(() => [])
  for (const entry of current) {
    const pinned = checkPinnedAddress(pin, entry.address)
    if (!pinned.allowed) throw new Error(`${capability} refused: ${pinned.reason}`)
  }
}

export interface HttpExchange {
  status: number
  headers: Record<string, string>
  body: string
  truncated: boolean
  durationMs: number
}

/** Local mode: the request leaves from this process, which is what local means. */
async function probeInProcess(
  url: URL,
  method: string,
  signal: AbortSignal,
  headers: Record<string, string> = {},
  requestBody?: string,
): Promise<HttpExchange> {
  const started = performance.now()
  const response = await fetch(url, {
    method,
    redirect: "manual",
    headers: { "user-agent": USER_AGENT, accept: "*/*", ...headers },
    ...(requestBody !== undefined ? { body: requestBody } : {}),
    signal,
  })
  const durationMs = Math.max(0, Math.round(performance.now() - started))
  // A write returns an answer worth reading too: whether the object changed is
  // usually the whole point of the step.
  const body = method === "HEAD" ? { text: "", truncated: false } : await readBoundedText(response)
  return {
    status: response.status,
    headers: Object.fromEntries([...response.headers.entries()].slice(0, 64)),
    body: body.text,
    truncated: body.truncated,
    durationMs,
  }
}

/**
 * Container mode: curl inside the sandbox, so the exchange is subject to the
 * same allowlist, resource limits, and dropped capabilities as every other tool.
 */
async function probeThroughContainer(
  url: URL,
  method: string,
  request: ToolExecutionRequest,
  context: CapabilityContext,
  signal: AbortSignal,
  headers: Record<string, string> = {},
  body?: string,
): Promise<HttpExchange> {
  const port = url.port || (url.protocol === "https:" ? "443" : "80")
  const hostname = url.hostname.toLowerCase()
  const pin = context.pins.get(hostname)
  const argv = [
    "curl",
    "--silent", "--show-error", "--globoff", "--http1.1",
    "--proto", "=http,https",
    // A redirect is re-checked against scope by the caller, never followed here.
    "--max-redirs", "0",
    "--connect-timeout", "5",
    "--max-time", String(Math.max(1, Math.ceil(Math.min(request.timeoutMs, 60_000) / 1_000))),
    "--user-agent", USER_AGENT,
    ...(method === "HEAD" ? ["--head"] : ["--include", "--request", method]),
    ...Object.entries(headers).flatMap(([name, value]) => ["--header", `${name}: ${value}`]),
    ...(body !== undefined ? ["--data-binary", body] : []),
    // The addresses the engagement pinned are the addresses curl may use.
    ...(pin ? ["--resolve", resolveEntry(hostname, port, pin.addresses)] : []),
    url.toString(),
  ]
  const result = await context.runner.run({
    argv,
    timeoutMs: Math.min(request.timeoutMs, 60_000),
    maxOutputBytes: Math.min(request.maxOutputBytes, MAX_BODY_PREVIEW),
  }, signal)
  if (result.timedOut) throw new Error(`http.probe timed out after ${request.timeoutMs}ms`)
  const parsed = parseHttpResponse(result.stdout)
  if (!parsed) {
    throw new Error(
      `http.probe got no response from ${url.host} (curl exited ${result.exitCode})`
      + `${result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 200)}` : ""}`,
    )
  }
  return {
    status: parsed.status,
    headers: parsed.headers,
    body: parsed.body,
    truncated: result.truncated,
    durationMs: result.durationMs,
  }
}

async function readBoundedText(response: Response): Promise<{ text: string; truncated: boolean }> {
  const buffer = await response.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const truncated = bytes.byteLength > MAX_BODY_PREVIEW
  return {
    text: new TextDecoder().decode(truncated ? bytes.slice(0, MAX_BODY_PREVIEW) : bytes),
    truncated,
  }
}
