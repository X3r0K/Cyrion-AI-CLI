import { readdir } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { assertSkill, type Skill } from "@cyrion/skills"
import type { KnowledgeStore } from "./store"
import type { Embedder, KnowledgeSource } from "./types"
import { fetchUrlError } from "./sources"

/** One corpus document. Larger than this is a distribution, not a document. */
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
const FETCH_TIMEOUT_MS = 30_000
const MAX_LOCAL_FILES = 512
/** Text a chunker can read. A PDF or an archive is refused rather than mangled. */
const ALLOWED_CONTENT_TYPES = ["text/", "application/json", "application/xml"]

/**
 * The narrow slice of `fetch` an ingest actually uses.
 *
 * Narrower than `typeof fetch` so a test can supply a plain function without
 * reimplementing the platform's static members.
 */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; redirect?: RequestRedirect },
) => Promise<Response>

export interface SyncOptions {
  /** Project root a local source's path is resolved against. */
  root?: string
  signal?: AbortSignal
  /** Injected in tests so a sync never needs the network to be exercised. */
  fetchImpl?: FetchLike
}

export interface SyncReport {
  sourceId: string
  documents: number
  chunks: number
  bytes: number
  /** What was not ingested, and why. A sync states its gaps rather than hiding them. */
  skipped: Array<{ reference: string; reason: string }>
}

/** Ingests one source, replacing whatever it held before. */
export async function syncSource(
  store: KnowledgeStore,
  source: KnowledgeSource,
  options: SyncOptions = {},
): Promise<SyncReport> {
  store.upsertSource(source)
  return source.origin === "remote"
    ? syncRemote(store, source, options)
    : syncLocal(store, source, options)
}

async function syncRemote(
  store: KnowledgeStore,
  source: KnowledgeSource,
  options: SyncOptions,
): Promise<SyncReport> {
  const report: SyncReport = { sourceId: source.id, documents: 0, chunks: 0, bytes: 0, skipped: [] }
  const request = options.fetchImpl ?? fetch
  for (const url of source.urls ?? []) {
    const urlError = fetchUrlError(url)
    if (urlError) {
      report.skipped.push({ reference: url, reason: urlError })
      continue
    }
    let text: string
    try {
      text = await fetchDocument(request, url, options.signal)
    } catch (error) {
      report.skipped.push({ reference: url, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    const document = store.ingest({
      sourceId: source.id,
      title: titleFor(url, text),
      reference: url,
      text,
    })
    report.documents += 1
    report.chunks += document.chunks
    report.bytes += document.bytes
  }
  return report
}

async function syncLocal(
  store: KnowledgeStore,
  source: KnowledgeSource,
  options: SyncOptions,
): Promise<SyncReport> {
  const report: SyncReport = { sourceId: source.id, documents: 0, chunks: 0, bytes: 0, skipped: [] }
  const root = resolve(options.root ?? process.cwd())
  const directory = resolve(root, source.path ?? ".")
  // A source path is operator input, and an operator editing a JSON file is not
  // an audit. Reading outside the project root is refused rather than resolved.
  if (directory !== root && !directory.startsWith(root + sep)) {
    report.skipped.push({ reference: source.path ?? "", reason: "path escapes the project root" })
    return report
  }
  const extensions = source.extensions ?? [".md", ".txt"]
  const files = (await readdir(directory).catch(() => []))
    .filter((name) => extensions.some((extension) => name.endsWith(extension)))
    .sort()
    .slice(0, MAX_LOCAL_FILES)
  if (!files.length) report.skipped.push({ reference: source.path ?? "", reason: "no matching files" })

  for (const name of files) {
    const path = join(directory, name)
    const file = Bun.file(path)
    if (file.size > MAX_DOCUMENT_BYTES) {
      report.skipped.push({ reference: name, reason: `larger than ${MAX_DOCUMENT_BYTES} bytes` })
      continue
    }
    let text: string
    let title = name
    if (name.endsWith(".skill.json")) {
      let skill: unknown
      try {
        skill = await file.json()
        assertSkill(skill)
      } catch (error) {
        report.skipped.push({ reference: name, reason: error instanceof Error ? error.message : String(error) })
        continue
      }
      text = renderSkill(skill)
      title = skill.name
    } else {
      text = await file.text()
      title = titleFor(name, text)
    }
    const document = store.ingest({
      sourceId: source.id,
      title,
      reference: projectRelative(root, path),
      text,
    })
    report.documents += 1
    report.chunks += document.chunks
    report.bytes += document.bytes
  }
  return report
}

/**
 * Embeds every chunk that has no vector for this model yet.
 *
 * Resumable because a local model on a cold start is slow and an operator will
 * interrupt it: what was embedded stays embedded, and the next run continues
 * from the gap rather than paying for the corpus twice.
 */
export async function embedPending(
  store: KnowledgeStore,
  embedder: Embedder,
  options: { batchSize?: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ embedded: number; total: number }> {
  const pending = store.pendingEmbeddings(embedder.model)
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 16, 128))
  let embedded = 0
  for (let index = 0; index < pending.length; index += batchSize) {
    if (options.signal?.aborted) break
    const batch = pending.slice(index, index + batchSize)
    const vectors = await embedder.embed(batch.map((chunk) => chunk.text), options.signal)
    if (vectors.length !== batch.length) throw new Error("Embedder returned a different number of vectors than inputs")
    store.saveEmbeddings(
      embedder.model,
      batch.map((chunk, position) => ({ chunkId: chunk.id, vector: vectors[position]! })),
    )
    embedded += batch.length
    options.onProgress?.(embedded, pending.length)
  }
  return { embedded, total: pending.length }
}

async function fetchDocument(request: FetchLike, url: string, signal?: AbortSignal): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(`Fetching ${url} timed out`)), FETCH_TIMEOUT_MS)
  const onAbort = (): void => controller.abort(signal?.reason)
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const response = await request(url, { signal: controller.signal, redirect: "follow" })
    if (!response.ok) throw new Error(`fetch returned ${response.status}`)
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
    if (contentType && !ALLOWED_CONTENT_TYPES.some((allowed) => contentType.startsWith(allowed))) {
      throw new Error(`unsupported content type ${contentType.split(";")[0]}`)
    }
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_DOCUMENT_BYTES) throw new Error(`larger than ${MAX_DOCUMENT_BYTES} bytes`)
    return new TextDecoder().decode(buffer)
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", onAbort)
  }
}

/** A skill is methodology; rendering it as prose makes it retrievable alongside the standards. */
export function renderSkill(skill: Skill): string {
  return [
    `# ${skill.name}`,
    "",
    `Identifier: ${skill.id}`,
    ...(skill.source ? [`Source: ${skill.source}`] : []),
    `Severity when it holds: ${skill.severity}`,
    `Applies to: ${skill.appliesTo.kinds.join(", ")} via ${skill.appliesTo.capabilities.join(", ")}`,
    "",
    "## Objective",
    "",
    skill.objective,
    ...(skill.preconditions?.length
      ? ["", "## Preconditions", "", ...skill.preconditions.map((entry) => `- ${entry}`)]
      : []),
    "",
    "## Steps",
    "",
    ...skill.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## Expected evidence",
    "",
    ...skill.expectedEvidence.map((entry) => `- ${entry}`),
    ...(skill.falsePositives?.length
      ? ["", "## What would make this claim wrong", "", ...skill.falsePositives.map((entry) => `- ${entry}`)]
      : []),
    ...(skill.references?.length ? ["", "## References", "", ...skill.references.map((entry) => `- ${entry}`)] : []),
    "",
  ].join("\n")
}

/** The first markdown heading, else the file name. Never model-supplied. */
function titleFor(reference: string, text: string): string {
  const heading = /^#{1,3}\s+(.{1,120})$/m.exec(text)?.[1]?.trim()
  if (heading) return heading
  const name = reference.split("/").pop() ?? reference
  return name.slice(0, 200)
}

function projectRelative(root: string, path: string): string {
  const value = relative(root, path)
  return !value || isAbsolute(value) || value.startsWith("..") ? path : value
}
