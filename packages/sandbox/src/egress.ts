import type { ScopePolicy } from "@cyrion/contracts"
import { evaluateAddress, type TargetPin } from "@cyrion/scope"

export interface EgressPolicy {
  /** Addresses the engagement pinned, with the ports each may use. */
  destinations: Array<{ address: string; ports?: string }>
  /**
   * Addresses excluded from the scope. Dropped ahead of every accept, so an
   * exclusion inside an approved range is enforced by the kernel too.
   */
  denied?: string[]
  /** Resolver the container may query. Everything else is dropped. */
  resolver?: string
}

/**
 * Builds an allowlist for one container's own network namespace: default DROP,
 * loopback and established traffic allowed, then exactly the pinned
 * destinations. Applied from the host, so a worker without NET_ADMIN cannot
 * remove it.
 */
export function buildEgressRules(policy: EgressPolicy): string[][] {
  const rules: string[][] = [
    ["iptables", "-P", "OUTPUT", "DROP"],
    ["iptables", "-F", "OUTPUT"],
    ["iptables", "-A", "OUTPUT", "-o", "lo", "-j", "ACCEPT"],
    ["iptables", "-A", "OUTPUT", "-m", "state", "--state", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
  ]
  // Exclusions come first: a later ACCEPT for the surrounding range cannot undo them.
  for (const address of policy.denied ?? []) {
    rules.push(["iptables", "-A", "OUTPUT", "-d", address, "-j", "DROP"])
  }
  if (policy.resolver) {
    rules.push(
      ["iptables", "-A", "OUTPUT", "-d", policy.resolver, "-p", "udp", "--dport", "53", "-j", "ACCEPT"],
      ["iptables", "-A", "OUTPUT", "-d", policy.resolver, "-p", "tcp", "--dport", "53", "-j", "ACCEPT"],
    )
  }
  for (const destination of policy.destinations) {
    if (!destination.ports) {
      rules.push(["iptables", "-A", "OUTPUT", "-d", destination.address, "-j", "ACCEPT"])
      continue
    }
    for (const range of destination.ports.split(",")) {
      const port = range.trim().replace("-", ":")
      if (!port) continue
      rules.push(
        ["iptables", "-A", "OUTPUT", "-d", destination.address, "-p", "tcp", "--dport", port, "-j", "ACCEPT"],
      )
    }
  }
  return rules
}

/** Turns the engagement's pins into the destinations the allowlist will admit. */
export function egressFromPins(policy: ScopePolicy, pins: readonly TargetPin[]): EgressPolicy {
  const destinations: EgressPolicy["destinations"] = []
  for (const pin of pins) {
    for (const address of pin.addresses) {
      const decision = evaluateAddress(policy, address)
      // A pin proves what a name resolved to, not that the scope admits it.
      if (!decision.allowed) continue
      const ports = decision.allowedPorts
      if (destinations.some((item) => item.address === address && item.ports === ports)) continue
      destinations.push({ address, ...(ports ? { ports } : {}) })
    }
  }
  return { destinations }
}

/** The exact commands an operator would run by hand, for review before applying. */
export function describeEgressRules(rules: readonly string[][]): string {
  return rules.map((rule) => rule.join(" ")).join("\n")
}
