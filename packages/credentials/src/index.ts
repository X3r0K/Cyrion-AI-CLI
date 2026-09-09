/**
 * Credentials an engagement may send, kept where the model cannot read them.
 *
 * Testing authorization requires authenticating, so Cyrion has to be able to
 * send a token. The question is where that token lives. Written into a skill
 * file it becomes three things at once: a secret in a git repository, a string
 * in every prompt built from that skill, and a value in whatever artifact the
 * exchange produced. None of those are recoverable by redacting output later.
 *
 * So a skill names a credential and never holds one. The file says
 * `${cred:api-token}`, the operator's store holds the value, and the two meet
 * for the first time inside the function that writes bytes to a socket. What
 * gets recorded is the reference, which is more useful than a redaction anyway:
 * a reader of the artifact learns which credential to substitute rather than
 * that something was removed.
 */

export const CREDENTIALS_VERSION = "cyrion.community/credentials-v1" as const

/** `${cred:name}` anywhere in a string. */
const REFERENCE = /\$\{cred:([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\}/g
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const HOST = /^(\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/

export interface CredentialEntry {
  name: string
  value: string
  /**
   * Hosts this credential may be sent to. Required, and the reason this store
   * is worth having: a token bound to one host cannot be carried to another by
   * a redirect, a crawled link, or a check whose target was edited. A leaked
   * credential is a worse outcome than a missed finding.
   */
  hosts: string[]
  /**
   * Whether the value may appear in text a model reads. False by default, so a
   * target that echoes the token back gets it scrubbed out of the summary
   * before any prompt is built from it.
   */
  exposeToModel?: boolean
  /** What this credential is, for `cyrion credentials`. Never the value. */
  description?: string
}

export interface CredentialsFile {
  version: typeof CREDENTIALS_VERSION
  credentials: CredentialEntry[]
}

export interface CredentialSummary {
  name: string
  hosts: string[]
  exposeToModel: boolean
  description?: string
}

/**
 * Reads a credential store, and never prints one.
 *
 * Every method that could return a secret takes the destination with it, so
 * there is no way to ask this object for a value without saying where it is
 * about to go.
 */
export class OperatorCredentials {
  readonly #entries = new Map<string, CredentialEntry>()

  constructor(entries: readonly CredentialEntry[] = []) {
    for (const entry of entries) this.#entries.set(entry.name, { ...entry, hosts: [...entry.hosts] })
  }

  get size(): number {
    return this.#entries.size
  }

  /** What the operator has, with the values left out. */
  list(): CredentialSummary[] {
    return [...this.#entries.values()]
      .map((entry) => ({
        name: entry.name,
        hosts: [...entry.hosts],
        exposeToModel: entry.exposeToModel === true,
        ...(entry.description ? { description: entry.description } : {}),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  has(name: string): boolean {
    return this.#entries.has(name)
  }

  /**
   * Substitutes every reference in these headers for one destination.
   *
   * Throws rather than substituting nothing. A credential that silently
   * resolved to an empty string would send an unauthenticated request that
   * comes back 401 and reads exactly like a finding, which is the most
   * expensive way for this to fail.
   */
  resolveHeaders(headers: Readonly<Record<string, string>>, destination: URL | string): Record<string, string> {
    const host = hostnameOf(destination)
    const resolved: Record<string, string> = {}
    for (const [name, value] of Object.entries(headers)) resolved[name] = this.resolve(value, host, name)
    return resolved
  }

  /** Substitutes references in one string, checking each against the destination. */
  resolve(value: string, destination: URL | string, where = "value"): string {
    const host = hostnameOf(destination)
    return value.replace(REFERENCE, (_match, name: string) => {
      const entry = this.#entries.get(name)
      if (!entry) {
        throw new Error(
          `No credential named "${name}" (referenced by ${where}). `
          + `Add it to the credential store, or run \`cyrion credentials\` to see what is defined.`,
        )
      }
      if (!allowsHost(entry, host)) {
        throw new Error(
          `Credential "${name}" is not allowed to be sent to ${host}. `
          + `It is bound to ${entry.hosts.join(", ")}.`,
        )
      }
      return entry.value
    })
  }

  /** Whether any reference appears in this string. */
  static references(value: string): string[] {
    return [...value.matchAll(REFERENCE)].map((match) => match[1] as string)
  }

  /**
   * Removes credential values from text that is about to be stored or read by
   * a model.
   *
   * The one path by which a value can escape the socket is a target that echoes
   * it back, so what a response said is scrubbed before it becomes a summary,
   * an artifact, or a prompt. A credential the operator marked `exposeToModel`
   * is left alone, which is what that flag is for.
   */
  scrub(text: string): string {
    let output = text
    for (const entry of this.#entries.values()) {
      if (entry.exposeToModel === true) continue
      // Short values are skipped: replacing a two-character secret would blank
      // out unrelated text and make the artifact useless as evidence.
      if (entry.value.length < 6) continue
      output = output.split(entry.value).join(`\${cred:${entry.name}}`)
    }
    return output
  }

  /** Scrubs every string in a header map. */
  scrubHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
    const safe: Record<string, string> = {}
    for (const [name, value] of Object.entries(headers)) safe[name] = this.scrub(value)
    return safe
  }
}

/** An empty store: the normal state, since most engagements authenticate nothing. */
export const NO_CREDENTIALS = new OperatorCredentials()

export function credentialsContractError(value: unknown): string | undefined {
  if (!isRecord(value)) return "credentials file must be an object"
  const extra = unexpectedKey(value, ["version", "credentials"])
  if (extra) return `unexpected field ${extra}`
  if (value.version !== CREDENTIALS_VERSION) return `version must be ${CREDENTIALS_VERSION}`
  if (!Array.isArray(value.credentials)) return "credentials must be an array"
  if (value.credentials.length > 64) return "credentials may hold at most 64 entries"
  const seen = new Set<string>()
  for (const [index, entry] of value.credentials.entries()) {
    const path = `credentials[${index}]`
    if (!isRecord(entry)) return `${path} must be an object`
    const entryExtra = unexpectedKey(entry, ["name", "value", "hosts", "exposeToModel", "description"])
    if (entryExtra) return `${path} contains unexpected field ${entryExtra}`
    if (typeof entry.name !== "string" || !NAME.test(entry.name)) {
      return `${path}.name must be lower-case letters, digits, and dashes`
    }
    if (seen.has(entry.name)) return `${path}.name is defined twice: ${entry.name}`
    seen.add(entry.name)
    if (typeof entry.value !== "string" || !entry.value.length || entry.value.length > 4_096) {
      return `${path}.value must be a non-empty string of at most 4096 characters`
    }
    if (/[\u0000-\u001F\u007F-\u009F]/.test(entry.value)) return `${path}.value contains control characters`
    if (!Array.isArray(entry.hosts) || !entry.hosts.length || entry.hosts.length > 16) {
      return `${path}.hosts must name 1 to 16 hosts this credential may be sent to`
    }
    for (const host of entry.hosts) {
      if (typeof host !== "string" || !HOST.test(host.toLowerCase())) {
        return `${path}.hosts contains an invalid host: ${String(host)}`
      }
    }
    if ("exposeToModel" in entry && typeof entry.exposeToModel !== "boolean") {
      return `${path}.exposeToModel must be true or false`
    }
    if ("description" in entry && (typeof entry.description !== "string" || entry.description.length > 256)) {
      return `${path}.description must be a string of at most 256 characters`
    }
  }
  return undefined
}

export function parseCredentials(value: unknown): OperatorCredentials {
  const error = credentialsContractError(value)
  if (error) throw new Error(`Invalid credential store: ${error}`)
  return new OperatorCredentials((value as CredentialsFile).credentials)
}

/**
 * Reads the operator's store from disk.
 *
 * A missing file is not an error — an engagement that authenticates nothing
 * needs no store — but a file that exists and cannot be parsed is, because
 * continuing would silently run unauthenticated and report the 401s as results.
 */
export async function loadCredentials(path: string): Promise<OperatorCredentials> {
  const file = Bun.file(path)
  if (!(await file.exists())) return NO_CREDENTIALS
  let parsed: unknown
  try {
    parsed = await file.json()
  } catch (error) {
    throw new Error(`Credential store ${path} is not valid JSON: ${error instanceof Error ? error.message : error}`)
  }
  return parseCredentials(parsed)
}

function allowsHost(entry: CredentialEntry, host: string): boolean {
  return entry.hosts.some((allowed) => {
    const pattern = allowed.toLowerCase()
    if (pattern.startsWith("*.")) {
      const base = pattern.slice(2)
      // A wildcard covers what is under it, never the bare name beside it.
      return host.endsWith(`.${base}`)
    }
    return host === pattern
  })
}

function hostnameOf(destination: URL | string): string {
  if (destination instanceof URL) return destination.hostname.toLowerCase()
  try {
    return new URL(destination).hostname.toLowerCase()
  } catch {
    return destination.trim().toLowerCase()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function unexpectedKey(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key))
}
