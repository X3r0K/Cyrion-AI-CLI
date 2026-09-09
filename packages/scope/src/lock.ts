import type { EngagementManifest } from "@cyrion/contracts"
import { canonicalScope, scopeHash } from "./policy"

export const SCOPE_LOCK_VERSION = "cyrion.community/scope-lock-v1" as const

export interface ScopeLock {
  version: typeof SCOPE_LOCK_VERSION
  engagementId: string
  scopeHash: string
  canonicalScope: string
  /**
   * What the operator wrote down about who authorized this, when they wanted a
   * record. Optional: a scope lock is a record an operator chooses to keep, not
   * a gate a run has to pass.
   */
  attestation?: string
  lockedAt: string
}

/**
 * A record of exactly what scope was approved, bound to that scope by hash.
 *
 * Writing one is optional and nothing refuses a run without it. What it buys an
 * operator who wants it is that a later scope change invalidates the lock
 * rather than silently inheriting it — worth having for a client engagement
 * with a paper trail, irrelevant for scanning your own staging box.
 */
export function createScopeLock(
  manifest: EngagementManifest,
  attestation?: string,
  now = new Date(),
): ScopeLock {
  const clean = attestation?.trim()
  if (clean && clean.length > 2_048) throw new Error("Attestation is too long")
  return {
    version: SCOPE_LOCK_VERSION,
    engagementId: manifest.id,
    scopeHash: scopeHash(manifest.scope),
    canonicalScope: canonicalScope(manifest.scope),
    ...(clean ? { attestation: clean } : {}),
    lockedAt: now.toISOString(),
  }
}

export function scopeLockError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "lock must be an object"
  const lock = value as Record<string, unknown>
  const extra = Object.keys(lock).find((key) =>
    !["version", "engagementId", "scopeHash", "canonicalScope", "attestation", "lockedAt"].includes(key))
  if (extra) return `lock contains unexpected field ${extra}`
  if (lock.version !== SCOPE_LOCK_VERSION) return "unsupported lock version"
  if (typeof lock.engagementId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(lock.engagementId)) {
    return "lock engagementId is invalid"
  }
  if (typeof lock.scopeHash !== "string" || !/^[a-f0-9]{64}$/.test(lock.scopeHash)) return "lock scopeHash is invalid"
  if (typeof lock.canonicalScope !== "string" || !lock.canonicalScope.trim()) return "lock canonicalScope is invalid"
  if (lock.attestation !== undefined
    && (typeof lock.attestation !== "string" || !lock.attestation.trim())) {
    return "lock attestation is invalid"
  }
  if (typeof lock.lockedAt !== "string" || !Number.isFinite(Date.parse(lock.lockedAt))) return "lock lockedAt is invalid"
  return undefined
}

/** Returns the mismatch that makes a lock inapplicable, or undefined when it holds. */
export function verifyScopeLock(lock: unknown, manifest: EngagementManifest): string | undefined {
  const contractError = scopeLockError(lock)
  if (contractError) return `Scope lock rejected: ${contractError}`
  const value = lock as ScopeLock
  if (value.engagementId !== manifest.id) {
    return `Scope lock was written for engagement ${value.engagementId}, not ${manifest.id}`
  }
  const current = scopeHash(manifest.scope)
  if (value.scopeHash !== current) {
    return "Scope lock does not match the current scope. Review the change and run `cyrion scope lock` again."
  }
  if (value.canonicalScope !== canonicalScope(manifest.scope)) {
    return "Scope lock canonical text does not match the current scope"
  }
  return undefined
}
