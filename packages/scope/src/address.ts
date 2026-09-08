/** IP parsing kept small and explicit: scope decisions must be auditable. */

export interface ParsedAddress {
  version: 4 | 6
  /** Numeric value, so containment is a mask comparison rather than string work. */
  value: bigint
  canonical: string
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function parseAddress(value: string): ParsedAddress | undefined {
  const text = value.trim().replace(/^\[|\]$/g, "")
  const ipv4 = parseIpv4(text)
  if (ipv4 !== undefined) return { version: 4, value: ipv4, canonical: canonicalIpv4(ipv4) }
  const ipv6 = parseIpv6(text)
  if (ipv6 !== undefined) return { version: 6, value: ipv6, canonical: canonicalIpv6(ipv6) }
  return undefined
}

export function isAddress(value: string): boolean {
  return parseAddress(value) !== undefined
}

export interface ParsedCidr {
  version: 4 | 6
  network: bigint
  prefix: number
  canonical: string
}

export function parseCidr(value: string): ParsedCidr | undefined {
  const slash = value.lastIndexOf("/")
  if (slash < 0) return undefined
  const address = parseAddress(value.slice(0, slash))
  const prefixText = value.slice(slash + 1)
  if (!address || !/^\d{1,3}$/.test(prefixText)) return undefined
  const prefix = Number(prefixText)
  const width = address.version === 4 ? 32 : 128
  if (prefix > width) return undefined
  const network = address.value & maskFor(prefix, width)
  return {
    version: address.version,
    network,
    prefix,
    canonical: `${address.version === 4 ? canonicalIpv4(network) : canonicalIpv6(network)}/${prefix}`,
  }
}

export function cidrContains(cidr: ParsedCidr, address: ParsedAddress): boolean {
  if (cidr.version !== address.version) return false
  const width = cidr.version === 4 ? 32 : 128
  return (address.value & maskFor(cidr.prefix, width)) === cidr.network
}

/**
 * Loopback, private, link-local, and unique-local ranges. Used to notice when a
 * public hostname suddenly resolves inward, which is the shape of a rebinding
 * or SSRF attempt rather than a legitimate scope change.
 */
export function isPrivateAddress(address: ParsedAddress): boolean {
  if (address.version === 4) {
    return ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16", "0.0.0.0/8"]
      .some((range) => containsRange(range, address))
  }
  return ["::1/128", "fc00::/7", "fe80::/10", "::/128"].some((range) => containsRange(range, address))
}

function containsRange(range: string, address: ParsedAddress): boolean {
  const cidr = parseCidr(range)
  return cidr ? cidrContains(cidr, address) : false
}

function maskFor(prefix: number, width: number): bigint {
  if (prefix === 0) return 0n
  const ones = (1n << BigInt(prefix)) - 1n
  return ones << BigInt(width - prefix)
}

function parseIpv4(value: string): bigint | undefined {
  const match = IPV4_PATTERN.exec(value)
  if (!match) return undefined
  let result = 0n
  for (let index = 1; index <= 4; index += 1) {
    const part = match[index]!
    if (part.length > 1 && part.startsWith("0")) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    result = (result << 8n) | BigInt(octet)
  }
  return result
}

function parseIpv6(value: string): bigint | undefined {
  if (!value.includes(":")) return undefined
  const [head, tail, ...extra] = value.split("::")
  if (extra.length) return undefined
  const parseGroups = (text: string): bigint[] | undefined => {
    if (!text) return []
    const groups: bigint[] = []
    for (const group of text.split(":")) {
      if (group.includes(".")) {
        const embedded = parseIpv4(group)
        if (embedded === undefined) return undefined
        groups.push(embedded >> 16n, embedded & 0xffffn)
        continue
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined
      groups.push(BigInt(Number.parseInt(group, 16)))
    }
    return groups
  }
  const left = parseGroups(head ?? "")
  const right = tail === undefined ? [] : parseGroups(tail)
  if (!left || !right) return undefined
  const missing = 8 - left.length - right.length
  if (tail === undefined ? left.length !== 8 : missing < 0) return undefined
  const groups = tail === undefined ? left : [...left, ...Array<bigint>(missing).fill(0n), ...right]
  if (groups.length !== 8) return undefined
  return groups.reduce((total, group) => (total << 16n) | group, 0n)
}

function canonicalIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join(".")
}

function canonicalIpv6(value: bigint): string {
  const groups: string[] = []
  for (let index = 7; index >= 0; index -= 1) {
    groups.push(((value >> BigInt(index * 16)) & 0xffffn).toString(16))
  }
  // Longest run of zero groups collapses once, per the usual text form.
  let bestStart = -1
  let bestLength = 0
  let start = -1
  let length = 0
  for (let index = 0; index < groups.length; index += 1) {
    if (groups[index] === "0") {
      if (start === -1) start = index
      length += 1
      if (length > bestLength) {
        bestStart = start
        bestLength = length
      }
    } else {
      start = -1
      length = 0
    }
  }
  if (bestLength < 2) return groups.join(":")
  return `${groups.slice(0, bestStart).join(":")}::${groups.slice(bestStart + bestLength).join(":")}`
}
