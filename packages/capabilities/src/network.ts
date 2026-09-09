import type { ToolExecutionRequest, ToolProgress } from "@cyrion/contracts"
import { evaluateScope, parseTarget } from "@cyrion/scope"
import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "./types"

/**
 * Port and service discovery inside an approved range.
 *
 * argv is assembled here from the validated target and the entry's own port
 * list — never from model output — and timing is capped so a swarm cannot turn
 * into a stress test of the target.
 */
export const netPortscan: CapabilityAdapter = {
  capability: "net.portscan",
  binary: "nmap",

  async execute(
    request: ToolExecutionRequest,
    context: CapabilityContext,
    signal: AbortSignal,
    progress?: ToolProgress,
  ): Promise<CapabilityResult> {
    const decision = evaluateScope(context.scope, request.target)
    if (!decision.allowed) throw new Error(`net.portscan refused: ${decision.reason}`)
    const target = parseTarget(request.target)
    if (target.kind !== "host") throw new Error("net.portscan needs a host target")

    const ports = decision.allowedPorts
      ?? (target.ports?.map((range) => (range.from === range.to ? `${range.from}` : `${range.from}-${range.to}`)).join(",")
        || "1-1024")
    const host = target.cidr ? target.cidr.canonical : target.host

    const result = await context.runner.run({
      argv: [
        "nmap",
        "-Pn",              // the operator approved the range; do not skip hosts that ignore pings
        "-sT",              // connect scan: no raw sockets, so no elevated capability is needed
        "-T3",              // bounded timing, never aggressive against a live target
        "--max-retries", "1",
        "--host-timeout", "60s",
        "-p", ports,
        "-oG", "-",
        host,
      ],
      timeoutMs: Math.min(request.timeoutMs, 300_000),
      maxOutputBytes: Math.min(request.maxOutputBytes, 1_000_000),
      ...(progress ? { onOutput: (chunk: string) => reportScanProgress(chunk, progress) } : {}),
    }, signal)

    if (result.timedOut) throw new Error(`net.portscan timed out after ${request.timeoutMs}ms`)
    if (result.exitCode !== 0) {
      throw new Error(`nmap exited ${result.exitCode}: ${result.stderr.trim().slice(0, 300) || "no diagnostic"}`)
    }

    const openPorts = parseGrepable(result.stdout)
    const evidence = await context.evidence.capture({
      engagementId: request.engagementId,
      id: context.nextEvidenceId("E"),
      kind: "log",
      content: `${result.argv.join(" ")}\n\n${result.stdout}`,
      contentType: "text/plain",
      source: request.agentId,
    })

    return {
      summary: {
        target: host,
        scannedPorts: ports,
        hosts: openPorts.length,
        open: openPorts.slice(0, 200),
        truncated: result.truncated,
        durationMs: result.durationMs,
        runner: result.runner,
      },
      evidence: [evidence],
      outcome: `${openPorts.reduce((total, host) => total + host.ports.length, 0)} open `
        + `across ${openPorts.length} host(s) in ${ports}`,
    }
  },
}

/**
 * Turns a chunk of grepable nmap output into one line an operator can read.
 *
 * A scan of a range is the longest thing Cyrion does, so what it has found so
 * far is worth more than the raw text it found it in.
 */
export function reportScanProgress(chunk: string, progress: ToolProgress): void {
  const hosts = parseGrepable(chunk)
  if (hosts.length) {
    const open = hosts.reduce((total, host) => total + host.ports.length, 0)
    progress(`${hosts[0]!.host}: ${open} open port(s) so far`)
    return
  }
  const line = chunk.split("\n").map((entry) => entry.trim()).findLast((entry) => entry.length > 0)
  if (line) progress(line)
}

interface GrepableHost {
  host: string
  ports: Array<{ port: number; state: string; service: string }>
}

/** Parses nmap's grepable output, which is line-oriented and stable across versions. */
export function parseGrepable(output: string): GrepableHost[] {
  const hosts: GrepableHost[] = []
  for (const line of output.split("\n")) {
    if (!line.startsWith("Host:") || !line.includes("Ports:")) continue
    const host = /^Host:\s+(\S+)/.exec(line)?.[1]
    const portSection = line.slice(line.indexOf("Ports:") + "Ports:".length)
    if (!host) continue
    const ports: GrepableHost["ports"] = []
    for (const entry of portSection.split(",")) {
      const [port, state, , , service] = entry.trim().split("/")
      const number = Number(port)
      if (!Number.isSafeInteger(number) || !state) continue
      if (state !== "open") continue
      ports.push({ port: number, state, service: service || "unknown" })
    }
    if (ports.length) hosts.push({ host, ports })
  }
  return hosts
}

/**
 * Certificate and protocol inventory for an approved endpoint. Read-only: it
 * connects, records what the endpoint presented, and disconnects.
 */
export const netTls: CapabilityAdapter = {
  capability: "net.tls",
  binary: "openssl",

  async execute(
    request: ToolExecutionRequest,
    context: CapabilityContext,
    signal: AbortSignal,
  ): Promise<CapabilityResult> {
    const decision = evaluateScope(context.scope, request.target)
    if (!decision.allowed) throw new Error(`net.tls refused: ${decision.reason}`)
    const target = parseTarget(request.target)
    const host = target.kind === "url" ? target.host : target.kind === "host" ? target.host : ""
    if (!host) throw new Error("net.tls needs a host or URL target")
    const port = target.kind === "url"
      ? target.port ?? (target.scheme === "https" ? 443 : 80)
      : target.kind === "host" ? target.ports?.[0]?.from ?? 443 : 443

    const result = await context.runner.run({
      argv: [
        "openssl", "s_client",
        "-connect", `${host}:${port}`,
        "-servername", host,
        "-brief",
      ],
      timeoutMs: Math.min(request.timeoutMs, 60_000),
      maxOutputBytes: Math.min(request.maxOutputBytes, 256_000),
    }, signal)

    const transcript = `${result.stdout}\n${result.stderr}`.trim()
    if (result.timedOut) throw new Error(`net.tls timed out after ${request.timeoutMs}ms`)
    if (!transcript) throw new Error(`openssl produced no output (exit ${result.exitCode})`)

    const field = (label: string): string | null =>
      new RegExp(`^${label}:\\s*(.+)$`, "mi").exec(transcript)?.[1]?.trim() ?? null
    const evidence = await context.evidence.capture({
      engagementId: request.engagementId,
      id: context.nextEvidenceId("E"),
      kind: "log",
      content: `${result.argv.join(" ")}\n\n${transcript}\n`,
      contentType: "text/plain",
      source: request.agentId,
    })

    return {
      summary: {
        endpoint: `${host}:${port}`,
        protocol: field("Protocol version"),
        ciphersuite: field("Ciphersuite"),
        peerCertificate: field("Verification") ?? field("Verify return code"),
        durationMs: result.durationMs,
        runner: result.runner,
      },
      evidence: [evidence],
      outcome: `${field("Protocol version") ?? "no protocol"} · ${field("Ciphersuite") ?? "no ciphersuite"}`,
    }
  },
}
