import type { KnowledgeSource } from "./types"

const API_TOP10 = "https://raw.githubusercontent.com/OWASP/API-Security/master/editions/2023/en"
const WSTG = "https://raw.githubusercontent.com/OWASP/wstg/master"

/**
 * Public corpora an operator may ingest, and nothing else.
 *
 * Pointers rather than bytes. The repository ships no corpus: it ships the URL,
 * the licence, and the command, and the operator decides whether to fetch it.
 * That keeps the licence question where it belongs and keeps a clone small.
 *
 * Every URL is pinned to one file. A crawler over a documentation site would
 * ingest whatever happened to be linked that day, and a corpus whose contents
 * depend on the day cannot support a citation.
 */
export const builtInSources: readonly KnowledgeSource[] = [
  {
    id: "cyrion-skills",
    name: "Cyrion skill pack",
    license: "MIT",
    origin: "local",
    path: "skills",
    extensions: [".skill.json"],
    reference: "The methodology this build ships with",
  },
  {
    id: "owasp-wstg",
    name: "OWASP Web Security Testing Guide",
    license: "CC BY-SA 4.0",
    origin: "remote",
    reference: "https://owasp.org/www-project-web-security-testing-guide/",
    urls: [
      `${WSTG}/checklists/checklist.md`,
      `${WSTG}/document/4-Web_Application_Security_Testing/README.md`,
      `${WSTG}/document/4-Web_Application_Security_Testing/12-API_Testing/README.md`,
    ],
  },
  {
    id: "owasp-api-top10",
    name: "OWASP API Security Top 10 (2023)",
    license: "CC BY-SA 4.0",
    origin: "remote",
    reference: "https://owasp.org/API-Security/editions/2023/en/0x11-t10/",
    urls: [
      `${API_TOP10}/0x10-api-security-risks.md`,
      `${API_TOP10}/0x11-t10.md`,
      `${API_TOP10}/0xa1-broken-object-level-authorization.md`,
      `${API_TOP10}/0xa2-broken-authentication.md`,
      `${API_TOP10}/0xa3-broken-object-property-level-authorization.md`,
      `${API_TOP10}/0xa4-unrestricted-resource-consumption.md`,
      `${API_TOP10}/0xa5-broken-function-level-authorization.md`,
      `${API_TOP10}/0xa6-unrestricted-access-to-sensitive-business-flows.md`,
      `${API_TOP10}/0xa7-server-side-request-forgery.md`,
      `${API_TOP10}/0xa8-security-misconfiguration.md`,
      `${API_TOP10}/0xa9-improper-inventory-management.md`,
      `${API_TOP10}/0xaa-unsafe-consumption-of-apis.md`,
    ],
  },
  {
    id: "owasp-asvs",
    name: "OWASP Application Security Verification Standard 5.0",
    license: "CC BY-SA 4.0",
    origin: "remote",
    reference: "https://owasp.org/www-project-application-security-verification-standard/",
    urls: [
      "https://raw.githubusercontent.com/OWASP/ASVS/master/5.0/docs_en/"
      + "OWASP_Application_Security_Verification_Standard_5.0.0_en.csv",
    ],
  },
]

export function sourceById(id: string): KnowledgeSource | undefined {
  return builtInSources.find((source) => source.id === id)
}

/** Refuses a hand-written source before it is fetched. Same discipline as a skill pack. */
export function knowledgeSourceError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "source must be an object"
  const source = value as Record<string, unknown>
  const allowed = ["id", "name", "license", "origin", "urls", "path", "extensions", "reference"]
  const extra = Object.keys(source).find((key) => !allowed.includes(key))
  if (extra) return `unexpected field ${extra}`
  if (typeof source.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(source.id)) {
    return "id must be a lowercase identifier"
  }
  if (typeof source.name !== "string" || !source.name.trim() || source.name.length > 128) {
    return "name must be a non-empty string of at most 128 characters"
  }
  if (typeof source.license !== "string" || !source.license.trim() || source.license.length > 64) {
    return "license must be stated"
  }
  if (source.origin !== "local" && source.origin !== "remote") return "origin must be local or remote"
  if (source.origin === "remote") {
    if (!Array.isArray(source.urls) || !source.urls.length || source.urls.length > 256) {
      return "a remote source must list 1 to 256 urls"
    }
    for (const url of source.urls) {
      const error = fetchUrlError(url)
      if (error) return error
    }
  } else if (typeof source.path !== "string" || !source.path.trim()) {
    return "a local source must name a path"
  }
  return undefined
}

/**
 * Transport rules for a corpus fetch.
 *
 * TLS unless the host is loopback: a corpus arrives over the network and then
 * becomes text a worker reads, so a plaintext fetch is a rewrite opportunity
 * for anyone on the path.
 */
export function fetchUrlError(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return "url must be a string of at most 2048 characters"
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return `url is not absolute: ${value.slice(0, 80)}`
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return `url must use https (or http to loopback): ${value.slice(0, 80)}`
  }
  if (url.username || url.password) return "url must not carry credentials"
  return undefined
}
