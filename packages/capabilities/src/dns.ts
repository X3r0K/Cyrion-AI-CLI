import { promises as dns } from "node:dns"
import type { ToolExecutionRequest } from "@cyrion/contracts"
import { evaluateScope, isAddress, parseTarget, pinAddresses } from "@cyrion/scope"
import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "./types"

/**
 * Resolves an approved host and pins what it answered.
 *
 * This is the capability every network capability depends on: the pin recorded
 * here is what later connections are held to, and what the container's egress
 * allowlist is built from.
 */
export const dnsLookup: CapabilityAdapter = {
  capability: "dns.lookup",

  async execute(
    request: ToolExecutionRequest,
    context: CapabilityContext,
    signal: AbortSignal,
  ): Promise<CapabilityResult> {
    const decision = evaluateScope(context.scope, request.target)
    if (!decision.allowed) throw new Error(`dns.lookup refused: ${decision.reason}`)
    const target = parseTarget(request.target)
    const hostname = target.kind === "url" ? target.host : target.kind === "host" ? target.host : ""
    if (!hostname) throw new Error("dns.lookup needs a host or URL target")

    if (isAddress(hostname)) {
      const pin = pinAddresses(hostname, [hostname])
      context.pins.set(hostname, pin)
      return {
        summary: { host: hostname, literal: true, addresses: pin.addresses },
        evidence: [],
        outcome: `literal address ${hostname}`,
      }
    }

    const resolved = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname),
    ])
    if (signal.aborted) throw signal.reason
    const addresses = resolved
      .flatMap((entry) => (entry.status === "fulfilled" ? entry.value : []))
      .slice(0, 32)
    if (!addresses.length) throw new Error(`${hostname} did not resolve to any address`)

    const pin = pinAddresses(hostname, addresses)
    context.pins.set(hostname, pin)
    const record = {
      host: hostname,
      addresses: pin.addresses,
      pinnedAt: pin.pinnedAt,
      private: pin.private,
    }
    const evidence = await context.evidence.capture({
      engagementId: request.engagementId,
      id: context.nextEvidenceId("E"),
      kind: "log",
      content: `${JSON.stringify(record, null, 2)}\n`,
      contentType: "application/json",
      source: request.agentId,
    })
    return {
      summary: record,
      evidence: [evidence],
      outcome: `${pin.addresses.length} address${pin.addresses.length === 1 ? "" : "es"} · ${pin.addresses[0]}`
        + `${pin.private ? " · private" : ""}`,
    }
  },
}
