import type { ToolExecutionRequest } from "@cyrion/contracts"
import { checkPinnedAddress, checkRedirect, evaluateScope, parseTarget } from "@cyrion/scope"
import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "./types"

const MAX_BODY_PREVIEW = 64 * 1024

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
    const pin = context.pins.get(url.hostname.toLowerCase())
    if (pin) {
      const { promises: dns } = await import("node:dns")
      const current = await dns.lookup(url.hostname, { all: true }).catch(() => [])
      for (const entry of current) {
        const pinned = checkPinnedAddress(pin, entry.address)
        if (!pinned.allowed) throw new Error(`http.probe refused: ${pinned.reason}`)
      }
    }

    const started = performance.now()
    const response = await fetch(url, {
      method,
      redirect: "manual",
      headers: { "user-agent": "cyrion-community/0.1 (+authorized assessment)", accept: "*/*" },
      signal,
    })
    const durationMs = Math.max(0, Math.round(performance.now() - started))
    const body = method === "GET" ? await readBoundedText(response) : { text: "", truncated: false }

    const headers = Object.fromEntries([...response.headers.entries()].slice(0, 64))
    const location = response.headers.get("location")
    const redirect = location
      ? checkRedirect(context.scope, url.toString(), new URL(location, url).toString())
      : undefined

    const record = {
      request: { method, url: url.toString() },
      response: {
        status: response.status,
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
        status: response.status,
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
    }
  },
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
