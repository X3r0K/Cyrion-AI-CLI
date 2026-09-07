import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import type { EvidenceRef, EvidenceStore } from "@cyrion/contracts"
import { MemoryEvidenceStore } from "@cyrion/evidence"
import { collectEvidenceReviewPreviews } from "@cyrion/runtime-opencode"

describe("provider evidence review previews", () => {
  test("discloses only bounded, verified text and removes unsafe controls", async () => {
    const store = new MemoryEvidenceStore()
    const first = await capture(store, "E-001", "alpha\u0000beta\r\ngamma", "application/json; charset=utf-8")
    const second = await capture(store, "E-002", "second artifact", "text/plain")

    const review = await collectEvidenceReviewPreviews(store, [first, second], policy({
      maxArtifacts: 2,
      maxBytesPerArtifact: 11,
      maxTotalBytes: 14,
      maxSourceBytes: 20,
    }))

    expect(review).toEqual({
      limits: { maxArtifacts: 2, maxBytesPerArtifact: 11, maxTotalBytes: 14, maxSourceBytes: 20 },
      previews: [
        {
          evidenceId: "E-001",
          status: "verified-text",
          contentType: "application/json; charset=utf-8",
          sizeBytes: first.sizeBytes!,
          content: "alphabeta\n",
          truncated: true,
        },
        {
          evidenceId: "E-002",
          status: "verified-text",
          contentType: "text/plain",
          sizeBytes: second.sizeBytes!,
          content: "sec",
          truncated: true,
        },
      ],
      omittedArtifacts: 0,
    })
  })

  test("withholds bodies for forged metadata, binary media, and exhausted budgets", async () => {
    const store = new MemoryEvidenceStore()
    const text = await capture(store, "E-001", "safe text", "text/plain")
    const binary = await capture(store, "E-002", "binary-looking payload", "application/octet-stream")
    const forged = { ...text, sizeBytes: (text.sizeBytes ?? 0) + 1 }

    const review = await collectEvidenceReviewPreviews(store, [forged, binary, text], policy({
      maxBytesPerArtifact: 10,
      maxTotalBytes: 0,
    }))

    expect(review.previews).toEqual([
      {
        evidenceId: "E-001",
        status: "rejected",
        contentType: "text/plain",
        sizeBytes: forged.sizeBytes,
        reason: "metadata-mismatch",
      },
      {
        evidenceId: "E-002",
        status: "metadata-only",
        contentType: "application/octet-stream",
        sizeBytes: binary.sizeBytes!,
        reason: "unsupported-content-type",
      },
      {
        evidenceId: "E-001",
        status: "metadata-only",
        contentType: "text/plain",
        sizeBytes: text.sizeBytes!,
        reason: "preview-budget-exhausted",
      },
    ])
    expect(review.previews.every((preview) => preview.content === undefined)).toBe(true)
  })

  test("re-hashes bytes read after store verification", async () => {
    const canonical = referenceFor("trusted")
    const store: EvidenceStore = {
      async capture() { throw new Error("not used") },
      async metadata() { return structuredClone(canonical) },
      async verify() { return true },
      async read() { return new TextEncoder().encode("changed") },
    }

    const review = await collectEvidenceReviewPreviews(store, [canonical], policy())

    expect(review.previews).toEqual([{
      evidenceId: "E-TOCTOU",
      status: "rejected",
      contentType: "text/plain",
      sizeBytes: 7,
      reason: "integrity-failed",
    }])
  })

  test("rejects evidence outside the current engagement or worker before store access", async () => {
    const outside = { ...referenceFor("outside"), uri: "artifact://OTHER/E-TOCTOU.txt" }
    const wrongWorker = { ...referenceFor("wrong worker"), id: "E-WRONG", source: "other-worker" }
    const store: EvidenceStore = {
      async capture() { throw new Error("not used") },
      async metadata() { throw new Error("must not inspect") },
      async verify() { throw new Error("must not verify") },
      async read() { throw new Error("must not read") },
    }

    const review = await collectEvidenceReviewPreviews(store, [outside, wrongWorker], policy())

    expect(review.previews.map(({ evidenceId, status, reason }) => ({ evidenceId, status, reason }))).toEqual([
      { evidenceId: "E-TOCTOU", status: "rejected", reason: "policy-mismatch" },
      { evidenceId: "E-WRONG", status: "rejected", reason: "policy-mismatch" },
    ])
  })

  test("withholds verified bytes that are not valid UTF-8", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0xfd])
    const canonical = referenceForBytes("E-UTF8", bytes, "text/plain")
    const store: EvidenceStore = {
      async capture() { throw new Error("not used") },
      async metadata() { return structuredClone(canonical) },
      async verify() { return true },
      async read() { return bytes.slice() },
    }

    const review = await collectEvidenceReviewPreviews(store, [canonical], policy())

    expect(review.previews).toEqual([{
      evidenceId: "E-UTF8",
      status: "metadata-only",
      contentType: "text/plain",
      sizeBytes: 3,
      reason: "invalid-utf8",
    }])
  })

  test("does not read text artifacts with unknown or excessive source size", async () => {
    const unknownSize = { ...referenceFor("trusted") }
    delete unknownSize.sizeBytes
    const oversized = { ...referenceFor("trusted"), id: "E-LARGE", sizeBytes: 1_048_577 }
    const store: EvidenceStore = {
      async capture() { throw new Error("not used") },
      async metadata(reference) { return reference.id === "E-LARGE" ? structuredClone(oversized) : structuredClone(unknownSize) },
      async verify() { throw new Error("must not verify") },
      async read() { throw new Error("must not read") },
    }

    const review = await collectEvidenceReviewPreviews(store, [unknownSize, oversized], policy())

    expect(review.previews).toEqual([
      {
        evidenceId: "E-TOCTOU",
        status: "metadata-only",
        contentType: "text/plain",
        reason: "unknown-size",
      },
      {
        evidenceId: "E-LARGE",
        status: "metadata-only",
        contentType: "text/plain",
        sizeBytes: 1_048_577,
        reason: "source-too-large",
      },
    ])
  })

  test("limits the number of preview records", async () => {
    const store = new MemoryEvidenceStore()
    const references = await Promise.all([
      capture(store, "E-001", "one", "text/plain"),
      capture(store, "E-002", "two", "text/plain"),
      capture(store, "E-003", "three", "text/plain"),
    ])

    const review = await collectEvidenceReviewPreviews(store, references, policy({ maxArtifacts: 2 }))

    expect(review.previews.map((preview) => preview.evidenceId)).toEqual(["E-001", "E-002"])
    expect(review.omittedArtifacts).toBe(1)
  })

  test("custom limits can tighten but not expand the disclosure caps", async () => {
    const store = new MemoryEvidenceStore()
    const reference = await capture(store, "E-001", "one", "text/plain")

    const review = await collectEvidenceReviewPreviews(store, [reference], policy({
      maxArtifacts: 1_000,
      maxBytesPerArtifact: 1_000_000,
      maxTotalBytes: 1_000_000,
      maxSourceBytes: 10_000_000,
    }))

    expect(review.limits).toEqual({
      maxArtifacts: 32,
      maxBytesPerArtifact: 4_096,
      maxTotalBytes: 12_288,
      maxSourceBytes: 1_048_576,
    })
  })
})

async function capture(store: MemoryEvidenceStore, id: string, content: string, contentType: string): Promise<EvidenceRef> {
  return store.capture({
    engagementId: "ENG-PREVIEW",
    id,
    kind: "fixture",
    content,
    contentType,
    source: "recon-t-preview",
  })
}

function referenceFor(content: string): EvidenceRef {
  const bytes = new TextEncoder().encode(content)
  return referenceForBytes("E-TOCTOU", bytes, "text/plain")
}

function referenceForBytes(id: string, bytes: Uint8Array, contentType: string): EvidenceRef {
  return {
    id,
    kind: "fixture",
    uri: `artifact://ENG-PREVIEW/${id}.txt`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    capturedAt: "2026-09-07T00:00:00.000Z",
    source: "recon-t-preview",
    contentType,
    sizeBytes: bytes.byteLength,
  }
}

function policy(overrides: Partial<Parameters<typeof collectEvidenceReviewPreviews>[2]> = {}) {
  return { engagementId: "ENG-PREVIEW", agentId: "recon-t-preview", ...overrides }
}
