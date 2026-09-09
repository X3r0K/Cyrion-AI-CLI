export const KNOWLEDGE_VERSION = "cyrion.community/knowledge-v1" as const

/** How a corpus entry got here. A remote source is fetched only when an operator asks. */
export type SourceOrigin = "local" | "remote"

/**
 * A public corpus an operator may ingest.
 *
 * Descriptors, not data: the repository ships the pointer and the licence, and
 * the bytes arrive only when someone runs `cyrion knowledge sync`. That keeps
 * the licence question with the operator and the repository small.
 */
export interface KnowledgeSource {
  id: string
  name: string
  /** Licence of the corpus, recorded so a report can state what it cited. */
  license: string
  origin: SourceOrigin
  /** Documents to fetch, for a remote source. */
  urls?: string[]
  /** Directory to read, for a local source, relative to the project root. */
  path?: string
  /** File extensions a local source accepts. */
  extensions?: string[]
  reference?: string
}

export interface KnowledgeDocument {
  id: string
  sourceId: string
  title: string
  /** Where the text came from: a URL, or a project-relative path. */
  reference: string
  sha256: string
  bytes: number
  chunks: number
  ingestedAt: string
}

export interface KnowledgeChunk {
  id: string
  documentId: string
  sourceId: string
  ordinal: number
  heading?: string
  text: string
}

/** How a hit was found. Reported so a search result never overstates its method. */
export type MatchMode = "lexical" | "vector" | "hybrid"

export interface KnowledgeHit {
  chunkId: string
  documentId: string
  sourceId: string
  title: string
  reference: string
  heading?: string
  /** Bounded excerpt. Reference material, never an instruction. */
  snippet: string
  /** Fused rank score. Comparable within one search, not across searches. */
  score: number
  matchedBy: MatchMode
}

export interface KnowledgeSearchResult {
  query: string
  /** The method that actually ran, which is lexical whenever no embedding model answered. */
  mode: MatchMode
  corpusVersion: string
  hits: KnowledgeHit[]
}

export interface CorpusStatus {
  version: typeof KNOWLEDGE_VERSION
  /** Digest over every ingested document, so a report can name the corpus it used. */
  corpusVersion: string
  documents: number
  chunks: number
  embedded: number
  embeddingModel?: string
  dimensions?: number
  sources: Array<{ id: string; name: string; license: string; documents: number; ingestedAt: string }>
}

/** Text to vectors. Implemented by `@cyrion/llm`, and stubbed in tests. */
export interface Embedder {
  readonly id: string
  readonly model: string
  embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>
}
