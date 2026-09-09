import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { chunkDocument, clean, type TextChunk } from "./chunk"
import type {
  CorpusStatus,
  Embedder,
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgeSearchResult,
  KnowledgeSource,
  MatchMode,
} from "./types"
import { KNOWLEDGE_VERSION } from "./types"

const SCHEMA_VERSION = "1"
/** Bounds one snippet handed to a worker. Retrieval informs a step; it is not the step. */
export const MAX_SNIPPET_CHARS = 600
/** Bounds one search. A worker asking for more is asking for context, not for an answer. */
export const MAX_HITS = 8
const MAX_QUERY_CHARS = 256
const MAX_QUERY_TERMS = 12
/** Reciprocal-rank-fusion constant. 60 is the value the original RRF paper used. */
const RRF_K = 60

export interface IngestInput {
  sourceId: string
  title: string
  reference: string
  text: string
}

export interface SearchOptions {
  k?: number
  embedder?: Embedder
  signal?: AbortSignal
}

/**
 * The local knowledge corpus.
 *
 * SQLite with FTS5, and vectors held as blobs scored in process. A vector
 * extension would be faster; requiring one would mean an operator cannot use
 * their own knowledge base without installing a database, which is the thing
 * this design is trying to avoid. Corpora here are public standards — thousands
 * of chunks, not millions — so a linear scan is measured in milliseconds.
 */
export class KnowledgeStore {
  readonly #db: Database
  readonly path: string

  private constructor(db: Database, path: string) {
    this.#db = db
    this.path = path
  }

  static open(path: string): KnowledgeStore {
    const db = new Database(path, { create: true })
    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA foreign_keys = ON")
    migrate(db)
    return new KnowledgeStore(db, path)
  }

  close(): void {
    this.#db.close()
  }

  /**
   * Replaces one document and its chunks in a single transaction.
   *
   * Replacement rather than append: re-syncing a standard that changed must not
   * leave the superseded text searchable, or a citation would point at a
   * paragraph the source no longer contains.
   */
  ingest(input: IngestInput): KnowledgeDocument {
    const text = clean(input.text)
    const sha256 = createHash("sha256").update(text).digest("hex")
    const documentId = documentIdFor(input.sourceId, input.reference)
    const chunks = chunkDocument(text)
    const document: KnowledgeDocument = {
      id: documentId,
      sourceId: input.sourceId,
      title: input.title.slice(0, 200),
      reference: input.reference.slice(0, 400),
      sha256,
      bytes: Buffer.byteLength(text),
      chunks: chunks.length,
      ingestedAt: new Date().toISOString(),
    }

    this.#db.transaction(() => {
      this.#deleteDocument(documentId)
      this.#db.run(
        "INSERT INTO documents (id, source_id, title, reference, sha256, bytes, chunks, ingested_at)"
        + " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          document.id,
          document.sourceId,
          document.title,
          document.reference,
          document.sha256,
          document.bytes,
          document.chunks,
          document.ingestedAt,
        ],
      )
      const insertChunk = this.#db.prepare(
        "INSERT INTO chunks (id, document_id, source_id, ordinal, heading, text) VALUES (?, ?, ?, ?, ?, ?)",
      )
      const insertFts = this.#db.prepare("INSERT INTO chunk_fts (chunk_id, text) VALUES (?, ?)")
      for (const chunk of chunks) {
        const id = chunkIdFor(documentId, chunk)
        insertChunk.run(id, documentId, input.sourceId, chunk.ordinal, chunk.heading ?? null, chunk.text)
        insertFts.run(id, searchableText(chunk))
      }
    })()
    return document
  }

  upsertSource(source: KnowledgeSource): void {
    this.#db.run(
      "INSERT INTO sources (id, name, license, origin, reference, ingested_at) VALUES (?, ?, ?, ?, ?, ?)"
      + " ON CONFLICT(id) DO UPDATE SET name = excluded.name, license = excluded.license,"
      + " origin = excluded.origin, reference = excluded.reference, ingested_at = excluded.ingested_at",
      [source.id, source.name, source.license, source.origin, source.reference ?? null, new Date().toISOString()],
    )
  }

  /** Removes a source and everything ingested under it. */
  forget(sourceId: string): number {
    const rows = this.#db.query<{ id: string }, [string]>("SELECT id FROM documents WHERE source_id = ?").all(sourceId)
    this.#db.transaction(() => {
      for (const row of rows) this.#deleteDocument(row.id)
      this.#db.run("DELETE FROM sources WHERE id = ?", [sourceId])
    })()
    return rows.length
  }

  documents(): KnowledgeDocument[] {
    return this.#db
      .query<DocumentRow, []>(
        "SELECT id, source_id, title, reference, sha256, bytes, chunks, ingested_at FROM documents ORDER BY id",
      )
      .all()
      .map(toDocument)
  }

  chunk(id: string): KnowledgeChunk | undefined {
    const row = this.#db
      .query<ChunkRow, [string]>(
        "SELECT id, document_id, source_id, ordinal, heading, text FROM chunks WHERE id = ?",
      )
      .get(id)
    return row ? toChunk(row) : undefined
  }

  /**
   * A digest over every ingested document.
   *
   * This is what a report states, so that "which knowledge base produced this"
   * has an answer that changes when the corpus changes and does not change when
   * it does not.
   */
  corpusVersion(): string {
    const rows = this.#db
      .query<{ source_id: string; id: string; sha256: string }, []>(
        "SELECT source_id, id, sha256 FROM documents ORDER BY source_id, id",
      )
      .all()
    if (!rows.length) return "empty"
    const digest = createHash("sha256")
    for (const row of rows) digest.update(`${row.source_id}|${row.id}|${row.sha256}\n`)
    return digest.digest("hex").slice(0, 16)
  }

  status(): CorpusStatus {
    const counts = this.#db
      .query<{ documents: number; chunks: number }, []>(
        "SELECT (SELECT COUNT(*) FROM documents) AS documents, (SELECT COUNT(*) FROM chunks) AS chunks",
      )
      .get()
    const embedding = this.#db
      .query<{ model: string; dimensions: number; embedded: number }, []>(
        "SELECT model, dimensions, COUNT(*) AS embedded FROM embeddings GROUP BY model, dimensions"
        + " ORDER BY embedded DESC LIMIT 1",
      )
      .get()
    const sources = this.#db
      .query<{ id: string; name: string; license: string; ingested_at: string; documents: number }, []>(
        "SELECT s.id, s.name, s.license, s.ingested_at,"
        + " (SELECT COUNT(*) FROM documents d WHERE d.source_id = s.id) AS documents"
        + " FROM sources s ORDER BY s.id",
      )
      .all()
    return {
      version: KNOWLEDGE_VERSION,
      corpusVersion: this.corpusVersion(),
      documents: counts?.documents ?? 0,
      chunks: counts?.chunks ?? 0,
      embedded: embedding?.embedded ?? 0,
      ...(embedding ? { embeddingModel: embedding.model, dimensions: embedding.dimensions } : {}),
      sources: sources.map((row) => ({
        id: row.id,
        name: row.name,
        license: row.license,
        documents: row.documents,
        ingestedAt: row.ingested_at,
      })),
    }
  }

  /** Chunks with no vector for this model yet, so a sync can resume where it stopped. */
  pendingEmbeddings(model: string, limit = 10_000): KnowledgeChunk[] {
    return this.#db
      .query<ChunkRow, [string, number]>(
        "SELECT c.id, c.document_id, c.source_id, c.ordinal, c.heading, c.text FROM chunks c"
        + " LEFT JOIN embeddings e ON e.chunk_id = c.id AND e.model = ?"
        + " WHERE e.chunk_id IS NULL ORDER BY c.id LIMIT ?",
      )
      .all(model, limit)
      .map(toChunk)
  }

  saveEmbeddings(model: string, entries: ReadonlyArray<{ chunkId: string; vector: Float32Array }>): void {
    this.#db.transaction(() => {
      const statement = this.#db.prepare(
        "INSERT INTO embeddings (chunk_id, model, dimensions, vector) VALUES (?, ?, ?, ?)"
        + " ON CONFLICT(chunk_id, model) DO UPDATE SET dimensions = excluded.dimensions, vector = excluded.vector",
      )
      for (const entry of entries) {
        statement.run(entry.chunkId, model, entry.vector.length, Buffer.from(entry.vector.buffer.slice(0)))
      }
    })()
  }

  /**
   * Retrieves bounded snippets for a query.
   *
   * Lexical always runs; vectors join it only when an embedder is supplied and
   * the corpus actually holds vectors for that model. The mode returned names
   * what happened, so a caller can never present a keyword match as semantic
   * retrieval.
   */
  async search(query: string, options: SearchOptions = {}): Promise<KnowledgeSearchResult> {
    const trimmed = clean(query).replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS)
    const k = Math.max(1, Math.min(Math.trunc(options.k ?? 5), MAX_HITS))
    const corpusVersion = this.corpusVersion()
    if (!trimmed) return { query: trimmed, mode: "lexical", corpusVersion, hits: [] }

    const lexical = this.#lexical(trimmed, k * 4)
    const vector = options.embedder ? await this.#vector(trimmed, options.embedder, k * 4, options.signal) : []
    const mode: MatchMode = vector.length ? (lexical.length ? "hybrid" : "vector") : "lexical"
    const fused = fuse(lexical, vector).slice(0, k)

    const hits: KnowledgeHit[] = []
    for (const entry of fused) {
      const row = this.#db
        .query<HitRow, [string]>(
          "SELECT c.id, c.document_id, c.source_id, c.heading, c.text, d.title, d.reference"
          + " FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = ?",
        )
        .get(entry.chunkId)
      if (!row) continue
      hits.push({
        chunkId: row.id,
        documentId: row.document_id,
        sourceId: row.source_id,
        title: row.title,
        reference: row.reference,
        ...(row.heading ? { heading: row.heading } : {}),
        snippet: snippet(row.text, trimmed),
        score: Number(entry.score.toFixed(6)),
        matchedBy: entry.matchedBy,
      })
    }
    return { query: trimmed, mode, corpusVersion, hits }
  }

  #lexical(query: string, limit: number): Ranked[] {
    const match = ftsQuery(query)
    if (!match) return []
    try {
      return this.#db
        .query<{ chunk_id: string }, [string, number]>(
          "SELECT chunk_id FROM chunk_fts WHERE chunk_fts MATCH ? ORDER BY bm25(chunk_fts) LIMIT ?",
        )
        .all(match, limit)
        .map((row, index) => ({ chunkId: row.chunk_id, rank: index, matchedBy: "lexical" as const }))
    } catch {
      // A term the tokenizer rejects is an empty result, never a failed search:
      // a worker's query string must not be able to error the capability.
      return []
    }
  }

  async #vector(query: string, embedder: Embedder, limit: number, signal?: AbortSignal): Promise<Ranked[]> {
    const rows = this.#db
      .query<{ chunk_id: string; vector: Uint8Array }, [string]>(
        "SELECT chunk_id, vector FROM embeddings WHERE model = ?",
      )
      .all(embedder.model)
    if (!rows.length) return []
    const [embedded] = await embedder.embed([query], signal)
    if (!embedded) return []
    const scored: Array<{ chunkId: string; similarity: number }> = []
    for (const row of rows) {
      const vector = toFloat32(row.vector)
      if (vector.length !== embedded.length) continue
      scored.push({ chunkId: row.chunk_id, similarity: cosine(embedded, vector) })
    }
    scored.sort((left, right) => right.similarity - left.similarity || left.chunkId.localeCompare(right.chunkId))
    return scored.slice(0, limit).map((entry, index) => ({
      chunkId: entry.chunkId,
      rank: index,
      matchedBy: "vector" as const,
    }))
  }

  #deleteDocument(documentId: string): void {
    this.#db.run(
      "DELETE FROM chunk_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
      [documentId],
    )
    this.#db.run(
      "DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
      [documentId],
    )
    this.#db.run("DELETE FROM chunks WHERE document_id = ?", [documentId])
    this.#db.run("DELETE FROM documents WHERE id = ?", [documentId])
  }
}

interface Ranked {
  chunkId: string
  rank: number
  matchedBy: "lexical" | "vector"
}

/**
 * Reciprocal rank fusion.
 *
 * Chosen over a weighted score blend because bm25 and cosine are not on a
 * comparable scale, and any constant that made them comparable on one corpus
 * would be wrong on the next. Ranks are comparable everywhere.
 */
function fuse(lexical: readonly Ranked[], vector: readonly Ranked[]): Array<{
  chunkId: string
  score: number
  matchedBy: MatchMode
}> {
  const scores = new Map<string, { score: number; lexical: boolean; vector: boolean }>()
  for (const list of [lexical, vector]) {
    for (const entry of list) {
      const current = scores.get(entry.chunkId) ?? { score: 0, lexical: false, vector: false }
      current.score += 1 / (RRF_K + entry.rank + 1)
      if (entry.matchedBy === "lexical") current.lexical = true
      else current.vector = true
      scores.set(entry.chunkId, current)
    }
  }
  return [...scores.entries()]
    .map(([chunkId, entry]) => ({
      chunkId,
      score: entry.score,
      matchedBy: (entry.lexical && entry.vector ? "hybrid" : entry.lexical ? "lexical" : "vector") as MatchMode,
    }))
    .sort((left, right) => right.score - left.score || left.chunkId.localeCompare(right.chunkId))
}

/**
 * Builds an FTS5 MATCH expression from a worker-supplied query.
 *
 * The query is rewritten rather than escaped. FTS5 has its own operator grammar
 * — `NEAR`, `*`, column filters — and a string that arrived from a model or a
 * target is not allowed to reach it. Terms only, quoted, joined with OR.
 */
export function ftsQuery(query: string): string | undefined {
  const terms = [...new Set(
    (query.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*/g) ?? [])
      .map((term) => term.replace(/[._-]+$/, ""))
      .filter((term) => term.length > 1),
  )].slice(0, MAX_QUERY_TERMS)
  if (!terms.length) return undefined
  return terms.map((term) => `"${term}"`).join(" OR ")
}

/** A window around the first matching term, so the snippet shows why it matched. */
function snippet(text: string, query: string): string {
  if (text.length <= MAX_SNIPPET_CHARS) return text
  const terms = (query.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*/g) ?? []).filter((term) => term.length > 2)
  const lower = text.toLowerCase()
  let start = 0
  for (const term of terms) {
    const at = lower.indexOf(term)
    if (at >= 0) {
      start = Math.max(0, at - Math.floor(MAX_SNIPPET_CHARS / 3))
      break
    }
  }
  const slice = text.slice(start, start + MAX_SNIPPET_CHARS)
  return `${start > 0 ? "…" : ""}${slice}${start + MAX_SNIPPET_CHARS < text.length ? "…" : ""}`
}

/** The heading is indexed with the body so a search for a section name finds it. */
function searchableText(chunk: TextChunk): string {
  return chunk.heading ? `${chunk.heading}\n${chunk.text}` : chunk.text
}

function documentIdFor(sourceId: string, reference: string): string {
  return `${sourceId}:${createHash("sha256").update(reference).digest("hex").slice(0, 12)}`
}

function chunkIdFor(documentId: string, chunk: TextChunk): string {
  const digest = createHash("sha256").update(chunk.text).digest("hex").slice(0, 8)
  return `${documentId}#${String(chunk.ordinal).padStart(4, "0")}-${digest}`
}

function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  const magnitude = Math.sqrt(leftNorm) * Math.sqrt(rightNorm)
  return magnitude === 0 ? 0 : dot / magnitude
}

function toFloat32(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength)
  copy.set(blob)
  return new Float32Array(copy.buffer)
}

interface DocumentRow {
  id: string
  source_id: string
  title: string
  reference: string
  sha256: string
  bytes: number
  chunks: number
  ingested_at: string
}

interface ChunkRow {
  id: string
  document_id: string
  source_id: string
  ordinal: number
  heading: string | null
  text: string
}

interface HitRow {
  id: string
  document_id: string
  source_id: string
  heading: string | null
  text: string
  title: string
  reference: string
}

function toDocument(row: DocumentRow): KnowledgeDocument {
  return {
    id: row.id,
    sourceId: row.source_id,
    title: row.title,
    reference: row.reference,
    sha256: row.sha256,
    bytes: row.bytes,
    chunks: row.chunks,
    ingestedAt: row.ingested_at,
  }
}

function toChunk(row: ChunkRow): KnowledgeChunk {
  return {
    id: row.id,
    documentId: row.document_id,
    sourceId: row.source_id,
    ordinal: row.ordinal,
    ...(row.heading ? { heading: row.heading } : {}),
    text: row.text,
  }
}

function migrate(db: Database): void {
  db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  const existing = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema'").get()
  if (existing && existing.value !== SCHEMA_VERSION) {
    throw new Error(
      `Knowledge store schema ${existing.value} was written by a different Cyrion version; `
      + "delete the store and run cyrion knowledge sync again",
    )
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      license TEXT NOT NULL,
      origin TEXT NOT NULL,
      reference TEXT,
      ingested_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      reference TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      chunks INTEGER NOT NULL,
      ingested_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id),
      source_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      heading TEXT,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chunks_document ON chunks (document_id);
    CREATE TABLE IF NOT EXISTS embeddings (
      chunk_id TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector BLOB NOT NULL,
      PRIMARY KEY (chunk_id, model)
    );
  `)
  db.run("CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(text, chunk_id UNINDEXED, tokenize = 'porter unicode61')")
  db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema', ?)", [SCHEMA_VERSION])
}
