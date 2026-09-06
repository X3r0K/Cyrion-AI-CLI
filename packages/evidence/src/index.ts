import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import type { EvidenceCapture, EvidenceRef, EvidenceStore } from "@cyrion/contracts"

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

    const bytes = new TextEncoder().encode(input.content)
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
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as EvidenceRef
      const artifact = await readFile(artifactPath)
      const actualHash = createHash("sha256").update(artifact).digest("hex")
      if (metadata.sha256 !== expectedHash || actualHash !== expectedHash) {
        throw new Error(`Evidence ID ${metadata.id} already exists with different content`)
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

  async capture(input: EvidenceCapture): Promise<EvidenceRef> {
    validateSegment("engagement ID", input.engagementId)
    validateSegment("evidence ID", input.id)
    const bytes = new TextEncoder().encode(input.content)
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
    this.#content.set(reference.uri, bytes)
    return reference
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

function extensionFor(contentType: string): string {
  if (contentType === "application/json") return "json"
  if (contentType === "text/markdown") return "md"
  return "txt"
}
