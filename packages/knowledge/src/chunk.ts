/** Bounds a chunk so one retrieval cannot flood a worker's context. */
export const MAX_CHUNK_CHARS = 1_200
const OVERLAP_CHARS = 160
const MAX_HEADING_CHARS = 160
const MAX_CHUNKS_PER_DOCUMENT = 4_000

export interface TextChunk {
  ordinal: number
  heading?: string
  text: string
}

/**
 * Splits a document into retrievable pieces.
 *
 * Deterministic on purpose: the same bytes must always produce the same chunk
 * identifiers, or re-ingesting a corpus would invalidate every citation a past
 * report made. Headings are carried alongside the text rather than merged into
 * it, so a snippet can say where in the standard it came from.
 */
export function chunkDocument(text: string, maxChars = MAX_CHUNK_CHARS): TextChunk[] {
  const chunks: TextChunk[] = []
  for (const section of sections(clean(text))) {
    for (const body of pack(section.body, maxChars)) {
      if (chunks.length >= MAX_CHUNKS_PER_DOCUMENT) return chunks
      chunks.push({
        ordinal: chunks.length,
        ...(section.heading ? { heading: section.heading } : {}),
        text: body,
      })
    }
  }
  return chunks
}

/**
 * Strips control characters and normalizes line endings.
 *
 * Corpus text is public but not operator-authored, so it is untrusted the same
 * way target output is: it may not carry escape sequences into a terminal, an
 * event payload, or a report.
 */
export function clean(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, " ")
    .replace(/[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
}

interface Section {
  heading?: string
  body: string
}

/** Markdown headings, when the document has them; otherwise the whole text. */
function sections(text: string): Section[] {
  const result: Section[] = []
  let heading: string | undefined
  let body: string[] = []
  const flush = (): void => {
    const joined = body.join("\n").trim()
    if (joined) result.push({ ...(heading ? { heading } : {}), body: joined })
    body = []
  }
  for (const line of text.split("\n")) {
    const match = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line)
    if (match?.[2]) {
      flush()
      heading = match[2].trim().slice(0, MAX_HEADING_CHARS)
      continue
    }
    body.push(line)
  }
  flush()
  return result.length ? result : [{ body: text.trim() }]
}

/**
 * Packs paragraphs into chunks, overlapping the tail of one into the next.
 *
 * The overlap is what keeps a requirement that straddles a boundary findable
 * from either side; without it a search for the second half of a sentence
 * returns the chunk that does not contain the answer.
 */
function pack(body: string, maxChars: number): string[] {
  const paragraphs = body
    .split(/\n{2,}/)
    .flatMap((paragraph) => split(paragraph.trim(), maxChars))
    .filter(Boolean)
  const chunks: string[] = []
  let current = ""
  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph
      continue
    }
    if (current.length + paragraph.length + 2 <= maxChars) {
      current = `${current}\n\n${paragraph}`
      continue
    }
    chunks.push(current)
    const tail = current.slice(-OVERLAP_CHARS)
    const boundary = tail.indexOf(" ")
    const overlap = boundary > 0 ? tail.slice(boundary + 1) : tail
    current = overlap && overlap.length + paragraph.length + 2 <= maxChars ? `${overlap}\n\n${paragraph}` : paragraph
  }
  if (current) chunks.push(current)
  return chunks
}

/** Breaks a paragraph longer than one chunk at a sentence or word boundary. */
function split(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph]
  const parts: string[] = []
  let rest = paragraph
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"))
    const word = window.lastIndexOf(" ")
    const cut = sentence > maxChars / 2 ? sentence + 1 : word > maxChars / 2 ? word : maxChars
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts
}
