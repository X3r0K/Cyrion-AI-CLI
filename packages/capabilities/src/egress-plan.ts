import { promises as dns } from "node:dns"
import type { ScopePolicy } from "@cyrion/contracts"
import { isAddress, parseTarget, pinAddresses, type TargetPin } from "@cyrion/scope"
import type { EgressPolicy } from "@cyrion/sandbox"

export interface EgressPlan {
  policy: EgressPolicy
  pins: TargetPin[]
  /** Scope entries with no address to allow, so the operator sees the gap. */
  unresolved: string[]
}

/**
 * Turns an approved scope into the destinations a container may reach.
 *
 * Literal addresses and ranges are admitted as written. Hostnames are resolved
 * once and pinned, so the allowlist and every later connection agree on the
 * same answer — a name that changes after this point is refused rather than
 * followed.
 */
export async function planEgress(policy: ScopePolicy): Promise<EgressPlan> {
  const destinations: EgressPolicy["destinations"] = []
  const pins: TargetPin[] = []
  const unresolved: string[] = []

  const add = (address: string, ports?: string): void => {
    if (destinations.some((item) => item.address === address && item.ports === ports)) return
    destinations.push({ address, ...(ports ? { ports } : {}) })
  }

  for (const expression of policy.targets) {
    let target
    try {
      target = parseTarget(expression)
    } catch {
      unresolved.push(expression)
      continue
    }
    if (target.kind === "repo") continue

    // The entry comes from the approved scope, so it needs no re-approval; what
    // matters is the ports it names and whether it can be resolved at all.
    const ports = target.kind === "url"
      ? String(target.port ?? (target.scheme === "https" ? 443 : 80))
      : target.ports?.map((range) => (range.from === range.to ? `${range.from}` : `${range.from}-${range.to}`)).join(",")

    if (target.kind === "host" && target.cidr) {
      add(target.cidr.canonical, ports)
      continue
    }
    const host = target.host
    if (isAddress(host)) {
      add(host, ports)
      continue
    }
    if (target.wildcard) {
      // A wildcard names hosts that do not exist yet; nothing can be pinned.
      unresolved.push(expression)
      continue
    }
    const answers = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)])
    const addresses = answers.flatMap((entry) => (entry.status === "fulfilled" ? entry.value : []))
    if (!addresses.length) {
      unresolved.push(expression)
      continue
    }
    const pin = pinAddresses(host, addresses)
    pins.push(pin)
    for (const address of pin.addresses) add(address, ports)
  }

  const denied: string[] = []
  for (const expression of policy.excluded) {
    try {
      const excluded = parseTarget(expression)
      if (excluded.kind === "host") {
        denied.push(excluded.cidr ? excluded.cidr.canonical : excluded.host)
      } else if (excluded.kind === "url" && isAddress(excluded.host)) {
        denied.push(excluded.host)
      }
    } catch {
      unresolved.push(expression)
    }
  }

  return {
    policy: { destinations, ...(denied.length ? { denied: [...new Set(denied)] } : {}) },
    pins,
    unresolved,
  }
}
