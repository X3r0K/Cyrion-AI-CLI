import { createHash } from "node:crypto"
import type { EvidenceRef, EvidenceStore } from "@cyrion/contracts"

export const DEFAULT_EVIDENCE_REVIEW_LIMITS = {
  maxArtifacts: 32,
  maxBytesPerArtifact: 4_096,
  maxTotalBytes: 12_288,
  maxSourceBytes: 1_048_576,
} as const

export interface EvidenceReviewPolicy {
  engagementId: string
  agentId: string
  maxArtifacts?: number
  maxBytesPerArtifact?: number
  maxTotalBytes?: number
  maxSourceBytes?: number
}

export interface EvidenceReviewPreview {
  evidenceId: string
  status: "verified-text" | "metadata-only" | "rejected"
  contentType?: string
  sizeBytes?: number
  content?: string
  truncated?: boolean
  reason?: "unsupported-content-type" | "invalid-utf8" | "unknown-size" | "source-too-large" | "preview-budget-exhausted" | "policy-mismatch" | "metadata-mismatch" | "integrity-failed" | "inaccessible"
}

export interface EvidenceReviewBundle {
  limits: {
    maxArtifacts: number
    maxBytesPerArtifact: number
    maxTotalBytes: number
    maxSourceBytes: number
  }
  previews: EvidenceReviewPreview[]
  omittedArtifacts: number
}

/**
 * Build a deliberately small provider-facing view of worker evidence.
 *
 * The controller still performs authoritative evidence admission after review.
 * These checks only prevent unverified or mismatched bytes from entering a
 * provider prompt. The bytes are re-hashed after reading to close the gap
 * between the store's verify and read operations.
 */
export async function collectEvidenceReviewPreviews(
  store: EvidenceStore,
  references: readonly EvidenceRef[],
  policy: EvidenceReviewPolicy,
): Promise<EvidenceReviewBundle> {
  const limits = normalizeLimits(policy)
  const selected = references.slice(0, limits.maxArtifacts)
  const previews: EvidenceReviewPreview[] = []
  let remainingBytes = limits.maxTotalBytes

  for (const reference of selected) {
    const base = previewBase(reference)
    if (reference.source !== policy.agentId || !reference.uri.startsWith(`artifact://${policy.engagementId}/`)) {
      previews.push({ ...base, status: "rejected", reason: "policy-mismatch" })
      continue
    }
    let canonical: EvidenceRef | undefined
    try {
      canonical = await store.metadata(reference)
    } catch {
      previews.push({ ...base, status: "rejected", reason: "inaccessible" })
      continue
    }

    if (!canonical || !sameEvidenceMetadata(reference, canonical)) {
      previews.push({ ...base, status: "rejected", reason: "metadata-mismatch" })
      continue
    }

    if (!isTextualContentType(canonical.contentType)) {
      previews.push({ ...base, status: "metadata-only", reason: "unsupported-content-type" })
      continue
    }

    if (canonical.sizeBytes === undefined) {
      previews.push({ ...base, status: "metadata-only", reason: "unknown-size" })
      continue
    }
    if (canonical.sizeBytes > limits.maxSourceBytes) {
      previews.push({ ...base, status: "metadata-only", reason: "source-too-large" })
      continue
    }

    if (limits.maxBytesPerArtifact === 0 || remainingBytes === 0) {
      previews.push({ ...base, status: "metadata-only", reason: "preview-budget-exhausted" })
      continue
    }

    let verified = false
    try {
      verified = await store.verify(canonical)
    } catch {
      previews.push({ ...base, status: "rejected", reason: "inaccessible" })
      continue
    }
    if (!verified) {
      previews.push({ ...base, status: "rejected", reason: "integrity-failed" })
      continue
    }

    let bytes: Uint8Array
    try {
      bytes = await store.read(canonical)
    } catch {
      previews.push({ ...base, status: "rejected", reason: "inaccessible" })
      continue
    }
    if (!matchesCanonicalBytes(bytes, canonical)) {
      previews.push({ ...base, status: "rejected", reason: "integrity-failed" })
      continue
    }

    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      previews.push({ ...base, status: "metadata-only", reason: "invalid-utf8" })
      continue
    }

    const disclosedBytes = Math.min(bytes.byteLength, limits.maxBytesPerArtifact, remainingBytes)
    const truncated = disclosedBytes < bytes.byteLength
    const content = sanitizeUntrustedText(new TextDecoder().decode(bytes.slice(0, disclosedBytes)))
    previews.push({
      ...base,
      status: "verified-text",
      content,
      ...(truncated ? { truncated: true } : {}),
    })
    remainingBytes -= disclosedBytes
  }

  return {
    limits,
    previews,
    omittedArtifacts: references.length - selected.length,
  }
}

function previewBase(reference: EvidenceRef): Pick<EvidenceReviewPreview, "evidenceId" | "contentType" | "sizeBytes"> {
  return {
    evidenceId: reference.id,
    ...(reference.contentType === undefined ? {} : { contentType: reference.contentType }),
    ...(reference.sizeBytes === undefined ? {} : { sizeBytes: reference.sizeBytes }),
  }
}

function normalizeLimits(requested: EvidenceReviewPolicy): EvidenceReviewBundle["limits"] {
  return {
    maxArtifacts: boundedInteger(requested.maxArtifacts, DEFAULT_EVIDENCE_REVIEW_LIMITS.maxArtifacts),
    maxBytesPerArtifact: boundedInteger(
      requested.maxBytesPerArtifact,
      DEFAULT_EVIDENCE_REVIEW_LIMITS.maxBytesPerArtifact,
    ),
    maxTotalBytes: boundedInteger(requested.maxTotalBytes, DEFAULT_EVIDENCE_REVIEW_LIMITS.maxTotalBytes),
    maxSourceBytes: boundedInteger(requested.maxSourceBytes, DEFAULT_EVIDENCE_REVIEW_LIMITS.maxSourceBytes),
  }
}

function boundedInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Evidence review limits must be non-negative integers")
  return Math.min(value, fallback)
}

function isTextualContentType(contentType: string | undefined): boolean {
  if (!contentType) return false
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase()
  return mediaType?.startsWith("text/") === true
    || mediaType === "application/json"
    || mediaType?.endsWith("+json") === true
}

function matchesCanonicalBytes(bytes: Uint8Array, canonical: EvidenceRef): boolean {
  const digest = createHash("sha256").update(bytes).digest("hex")
  return digest === canonical.sha256
    && (canonical.sizeBytes === undefined || canonical.sizeBytes === bytes.byteLength)
}

function sameEvidenceMetadata(left: EvidenceRef, right: EvidenceRef): boolean {
  return left.id === right.id
    && left.kind === right.kind
    && left.uri === right.uri
    && left.sha256 === right.sha256
    && left.capturedAt === right.capturedAt
    && left.source === right.source
    && left.contentType === right.contentType
    && left.sizeBytes === right.sizeBytes
}

function sanitizeUntrustedText(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "")
}
