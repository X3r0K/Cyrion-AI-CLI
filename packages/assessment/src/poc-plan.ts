import {
  POC_VERSION,
  assertPocPlan,
  type EvidenceRef,
  type EvidenceStore,
  type Finding,
  type PocPlan,
} from "@cyrion/contracts"

/** Browser protections whose absence the header skill reports. */
export const PROTECTION_HEADERS = [
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "strict-transport-security",
] as const

/** What the discovery artifact says the target actually returned. */
export interface DiscoveryClaim {
  status: number
  headers: Record<string, string>
}

/**
 * Reads the response the candidate cites.
 *
 * A validator may look at what the target returned — that is a record, and it
 * verifies by digest. What it must never see is how the discovering worker
 * reasoned about it, which is why only artifacts reach this function.
 */
export async function readDiscoveryClaim(
  references: readonly EvidenceRef[],
  store: EvidenceStore,
): Promise<DiscoveryClaim | undefined> {
  for (const reference of references) {
    if (reference.contentType !== "application/json") continue
    try {
      if (!(await store.verify(reference))) continue
      const value: unknown = JSON.parse(new TextDecoder().decode(await store.read(reference)))
      const response = (value as { response?: unknown }).response
      if (!response || typeof response !== "object") continue
      const status = (response as { status?: unknown }).status
      const headers = (response as { headers?: unknown }).headers
      if (!Number.isSafeInteger(status) || !headers || typeof headers !== "object") continue
      const normalized: Record<string, string> = {}
      for (const [name, headerValue] of Object.entries(headers as Record<string, unknown>)) {
        if (typeof headerValue === "string") normalized[name.toLowerCase()] = headerValue
      }
      return { status: status as number, headers: normalized }
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Turns a candidate and the response it cites into a reproduction plan.
 *
 * The plan states the claim as a condition a later run either meets or does
 * not: the headers that were absent when the finding was raised must still be
 * absent, the endpoint that answered without a credential must still answer.
 * Returning `undefined` is the honest outcome when the record does not support
 * a mechanical check — the validator then falls back to a bounded observation
 * and says so rather than inventing a proof.
 */
export function buildPocPlan(candidate: Finding, claim: DiscoveryClaim | undefined): PocPlan | undefined {
  if (!claim) return undefined
  const url = concreteUrl(candidate.asset)
  if (!url.startsWith("http://") && !url.startsWith("https://")) return undefined

  let plan: PocPlan | undefined
  if (candidate.skillId === "web-security-headers") {
    const missing = PROTECTION_HEADERS.filter((header) => claim.headers[header] === undefined)
    if (!missing.length) return undefined
    plan = {
      version: POC_VERSION,
      findingId: candidate.id,
      title: `${candidate.title} on ${url}`,
      rationale:
        "The finding claims the response omits browser protection headers. One request repeats the exchange: "
        + `the response must still answer ${claim.status} and must still omit ${missing.join(", ")}.`,
      steps: [{
        id: "request",
        description: `Request ${url} and inspect the response headers`,
        method: "GET",
        url,
        expect: { status: [claim.status], headersAbsent: [...missing] },
      }],
    }
  } else if (candidate.skillId === "api-object-boundary") {
    const contentType = claim.headers["content-type"]
    if (claim.status !== 200 || !contentType?.includes("application/json")) return undefined
    plan = {
      version: POC_VERSION,
      findingId: candidate.id,
      title: `${candidate.title} on ${url}`,
      rationale:
        "The finding claims an object endpoint answers a request that carries no credential. The proof sends "
        + "exactly that request — no credential, no cookie, no session — and requires the endpoint to answer 200 "
        + "with an object body, which is what an enforced boundary would refuse.",
      steps: [{
        id: "unauthenticated-request",
        description: `Request ${url} without any credential`,
        method: "GET",
        url,
        expect: { status: [200], contentType: "application/json" },
      }],
    }
  }

  if (!plan) return undefined
  // The plan is about to become an execution request; refuse a malformed one
  // here rather than letting the adapter reject it mid-validation.
  assertPocPlan(plan)
  return plan
}

/** A scope expression may end in a wildcard; a request may not. */
export function concreteUrl(expression: string): string {
  return expression.replace(/\*$/, "")
}
