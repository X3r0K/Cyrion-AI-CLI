import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { evidenceRefContractError, type EvidenceCapture, type EvidenceRef, type EvidenceStore } from "@cyrion/contracts"

const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export class LocalEvidenceStore implements EvidenceStore {
  readonly #root: string

  constructor(root: string) {
    this.#root = resolve(root)
  }

  async capture(input: EvidenceCapture): Promise<EvidenceRef> {
    validateSegment("engagement ID", input.engagementId)
    validateSegment("evidence ID", input.id)
    const extension = input.extension ?? extensionFor(input.contentType)
    validateSegment("evidence extension", extension)
    const directory = this.#directory(input.engagementId)
    await mkdir(directory, { recursive: true, mode: 0o700 })

    const bytes = artifactBytes(input)
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const filename = `${input.id}.${extension}`
    const artifactPath = this.#inside(directory, filename)
    const metadataPath = this.#inside(directory, `${input.id}.meta.json`)
    const existing = await this.#existing(metadataPath, artifactPath, sha256)
    if (existing) return existing

    const reference: EvidenceRef = {
      id: input.id,
      kind: input.kind,
      uri: `artifact://${input.engagementId}/${filename}`,
      sha256,
      capturedAt: new Date().toISOString(),
      source: input.source,
      contentType: input.contentType,
      sizeBytes: bytes.byteLength,
    }
    await atomicWrite(artifactPath, bytes)
    await atomicWrite(metadataPath, new TextEncoder().encode(`${JSON.stringify(reference, null, 2)}\n`))
    return reference
  }

  async read(reference: EvidenceRef): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.#pathFromUri(reference.uri)))
  }

  async metadata(reference: EvidenceRef): Promise<EvidenceRef | undefined> {
    try {
      this.#pathFromUri(reference.uri)
      validateSegment("evidence ID", reference.id)
      const engagementId = reference.uri.slice("artifact://".length).split("/")[0]
      if (!engagementId) return undefined
      const metadataPath = this.#inside(this.#directory(engagementId), `${reference.id}.meta.json`)
      const value: unknown = JSON.parse(await readFile(metadataPath, "utf8"))
      if (evidenceRefContractError(value)) return undefined
      const metadata = value as EvidenceRef
      return metadata.id === reference.id && metadata.uri === reference.uri ? metadata : undefined
    } catch {
      return undefined
    }
  }

  async verify(reference: EvidenceRef): Promise<boolean> {
    try {
      const bytes = await this.read(reference)
      return createHash("sha256").update(bytes).digest("hex") === reference.sha256
        && (reference.sizeBytes === undefined || reference.sizeBytes === bytes.byteLength)
    } catch {
      return false
    }
  }

  #directory(engagementId: string): string {
    return this.#inside(this.#root, engagementId)
  }

  #inside(parent: string, child: string): string {
    const candidate = resolve(parent, child)
    if (candidate !== parent && !candidate.startsWith(`${parent}${sep}`)) throw new Error("Evidence path escapes artifact root")
    return candidate
  }

  #pathFromUri(uri: string): string {
    if (!uri.startsWith("artifact://")) throw new Error("Unsupported evidence URI")
    const path = uri.slice("artifact://".length)
    const [engagementId, filename, ...extra] = path.split("/")
    if (!engagementId || !filename || extra.length) throw new Error("Invalid evidence URI")
    validateSegment("engagement ID", engagementId)
    validateSegment("artifact filename", filename)
    return this.#inside(this.#directory(engagementId), filename)
  }

  async #existing(metadataPath: string, artifactPath: string, expectedHash: string): Promise<EvidenceRef | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(metadataPath, "utf8"))
      const metadataError = evidenceRefContractError(value)
      if (metadataError) throw new Error(`Existing evidence metadata is invalid: ${metadataError}`)
      const metadata = value as EvidenceRef
      const artifact = await readFile(artifactPath)
      const actualHash = createHash("sha256").update(artifact).digest("hex")
      if (metadata.sha256 !== expectedHash || actualHash !== expectedHash) {
        throw new Error(
          `Evidence ID ${metadata.id} already exists with different content at ${artifactPath}. `
          + "Remove that engagement artifact directory or run with a different --artifacts location.",
        )
      }
      return metadata
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
      throw error
    }
  }
}

export class MemoryEvidenceStore implements EvidenceStore {
  readonly #content = new Map<string, Uint8Array>()
  readonly #references = new Map<string, EvidenceRef>()

  async capture(input: EvidenceCapture): Promise<EvidenceRef> {
    validateSegment("engagement ID", input.engagementId)
    validateSegment("evidence ID", input.id)
    const bytes = artifactBytes(input)
    const extension = input.extension ?? extensionFor(input.contentType)
    const reference: EvidenceRef = {
      id: input.id,
      kind: input.kind,
      uri: `artifact://${input.engagementId}/${input.id}.${extension}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      capturedAt: new Date().toISOString(),
      source: input.source,
      contentType: input.contentType,
      sizeBytes: bytes.byteLength,
    }
    const existing = this.#content.get(reference.uri)
    if (existing && createHash("sha256").update(existing).digest("hex") !== reference.sha256) {
      throw new Error(`Evidence ID ${input.id} already exists with different content`)
    }
    const existingReference = this.#references.get(reference.uri)
    if (existingReference) return structuredClone(existingReference)
    this.#content.set(reference.uri, bytes)
    this.#references.set(reference.uri, structuredClone(reference))
    return reference
  }

  async metadata(reference: EvidenceRef): Promise<EvidenceRef | undefined> {
    const stored = this.#references.get(reference.uri)
    return stored?.id === reference.id ? structuredClone(stored) : undefined
  }

  async read(reference: EvidenceRef): Promise<Uint8Array> {
    const bytes = this.#content.get(reference.uri)
    if (!bytes) throw new Error(`Evidence artifact not found: ${reference.uri}`)
    return bytes.slice()
  }

  async verify(reference: EvidenceRef): Promise<boolean> {
    try {
      const bytes = await this.read(reference)
      return createHash("sha256").update(bytes).digest("hex") === reference.sha256
    } catch {
      return false
    }
  }
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 })
  await rename(temporary, path)
  await chmod(path, 0o600)
  const details = await stat(path)
  if (!details.isFile()) throw new Error("Evidence artifact is not a regular file")
}

function validateSegment(label: string, value: string): void {
  if (!safeSegment.test(value) || value === "." || value === "..") throw new Error(`Invalid ${label}`)
}

/**
 * The artifact's bytes, from whichever side the caller supplied.
 *
 * Exactly one, because two sources of truth for what was captured is two
 * possible digests for one exhibit.
 */
function artifactBytes(input: EvidenceCapture): Uint8Array {
  if (input.bytes !== undefined && input.content !== undefined) {
    throw new Error("Evidence capture must supply either content or bytes, not both")
  }
  if (input.bytes !== undefined) return input.bytes
  if (input.content === undefined) throw new Error("Evidence capture must supply content or bytes")
  return new TextEncoder().encode(input.content)
}

function extensionFor(contentType: string): string {
  if (contentType === "application/json") return "json"
  if (contentType === "text/markdown") return "md"
  if (contentType === "image/png") return "png"
  if (contentType === "text/html") return "html"
  return "txt"
}

export * from "./review-preview"
