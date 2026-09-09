import type { ToolExecutionRequest } from "@cyrion/contracts"
import { evaluateScope, parseTarget } from "@cyrion/scope"
import { assertPinnedHost, httpExchange } from "./http"
import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "./types"

/** Pages one crawl may fetch, whatever the task asks for. */
const MAX_PAGES = 25
/** How far from the starting page a link may be followed. */
const MAX_DEPTH = 3
/** Links read out of one page. A page that lists thousands is still bounded. */
const MAX_LINKS_PER_PAGE = 200
/** Endpoints handed back to a worker. The artifact holds the whole inventory. */
const MAX_REPORTED = 100
/** Politeness gap between requests to the same approved origin. */
const REQUEST_GAP_MS = 150

interface CrawledPage {
  url: string
  status: number
  contentType: string | null
  bytes: number
  depth: number
  links: number
}

/**
 * Walks an approved origin and reports the endpoints it actually found.
 *
 * An assessment that only ever looks at the addresses an operator typed is an
 * assessment of a list, not of a site. This turns one approved origin into the
 * inventory the skills are then run against — bounded by pages, depth, and the
 * task's own clock, and confined by the scope: a link that leaves what was
 * approved is counted and recorded, never followed.
 *
 * Nothing here is discovery by guessing. It reads links the target itself
 * published; there is no wordlist, no path brute force, and no request that
 * changes state.
 */
export const httpCrawl: CapabilityAdapter = {
  capability: "http.crawl",
  containerBinary: "curl",

  async execute(
    request: ToolExecutionRequest,
    context: CapabilityContext,
    signal: AbortSignal,
  ): Promise<CapabilityResult> {
    const decision = evaluateScope(context.scope, request.target)
    if (!decision.allowed) throw new Error(`http.crawl refused: ${decision.reason}`)
    const target = parseTarget(request.target)
    if (target.kind !== "url") throw new Error("http.crawl needs a URL target")

    const input = (request.input ?? {}) as { maxPages?: unknown; maxDepth?: unknown }
    const maxPages = bounded(input.maxPages, MAX_PAGES, 1)
    // Depth 0 is a real answer: fetch the page you were given and follow nothing.
    const maxDepth = bounded(input.maxDepth, MAX_DEPTH, 0)

    const start = new URL(target.raw.replace(/\*$/, ""))
    await assertPinnedHost(start, context, "http.crawl")

    const queue: Array<{ url: URL; depth: number }> = [{ url: start, depth: 0 }]
    const seen = new Set<string>([key(start)])
    const pages: CrawledPage[] = []
    const endpoints: string[] = []
    const refused: Array<{ url: string; reason: string }> = []
    let outOfScopeLinks = 0

    while (queue.length && pages.length < maxPages) {
      if (signal.aborted) throw signal.reason
      const next = queue.shift()!
      if (pages.length) await Bun.sleep(REQUEST_GAP_MS)

      const exchange = await httpExchange(next.url, "GET", request, context, signal)
        .catch((error: unknown) => {
          // One endpoint that will not answer is an observation about that
          // endpoint, not the end of the inventory.
          refused.push({ url: next.url.toString(), reason: reason(error) })
          return undefined
        })
      if (!exchange) continue

      const contentType = exchange.headers["content-type"] ?? null
      const found = isHtml(contentType) ? links(exchange.body, next.url) : []
      pages.push({
        url: next.url.toString(),
        status: exchange.status,
        contentType,
        bytes: exchange.body.length,
        depth: next.depth,
        links: found.length,
      })
      endpoints.push(next.url.toString())

      if (next.depth >= maxDepth) continue
      for (const link of found) {
        if (seen.has(key(link))) continue
        seen.add(key(link))
        // The scope decides what may be requested, one link at a time. A link
        // out of it is a fact about the page, not somewhere to go next.
        if (!evaluateScope(context.scope, link.toString()).allowed) {
          outOfScopeLinks += 1
          continue
        }
        if (seen.size > maxPages * MAX_LINKS_PER_PAGE) break
        queue.push({ url: link, depth: next.depth + 1 })
      }
    }

    const record = {
      start: start.toString(),
      limits: { maxPages, maxDepth },
      pages,
      // What was found and not visited: the budget stopped the walk, not the scope.
      queued: queue.map((entry) => entry.url.toString()).slice(0, MAX_REPORTED),
      outOfScopeLinks,
      refused,
    }
    const evidence = await context.evidence.capture({
      engagementId: request.engagementId,
      id: context.nextEvidenceId("E"),
      kind: "log",
      content: `${JSON.stringify(record, null, 2)}\n`,
      contentType: "application/json",
      source: request.agentId,
    })

    return {
      summary: {
        start: start.toString(),
        pages: pages.length,
        // Every one of these was in scope when it was requested, and is checked
        // again by the controller before anything is planned against it.
        endpoints: endpoints.slice(0, MAX_REPORTED),
        truncated: endpoints.length > MAX_REPORTED || queue.length > 0,
        outOfScopeLinks,
        refused: refused.length,
        statuses: tally(pages),
      },
      evidence: [evidence],
      outcome: `${pages.length} page${pages.length === 1 ? "" : "s"} · ${endpoints.length} endpoint`
        + `${endpoints.length === 1 ? "" : "s"}`
        + `${outOfScopeLinks ? ` · ${outOfScopeLinks} link${outOfScopeLinks === 1 ? "" : "s"} out of scope` : ""}`
        + `${refused.length ? ` · ${refused.length} refused` : ""}`,
    }
  },
}

/** Links the page itself published: `href`, `src`, and form actions. */
export function links(html: string, base: URL): URL[] {
  const found: URL[] = []
  const pattern = /(?:href|src|action)\s*=\s*(?:"([^"]{1,2048})"|'([^']{1,2048})')/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null && found.length < MAX_LINKS_PER_PAGE) {
    const raw = (match[1] ?? match[2] ?? "").trim()
    if (!raw || raw.startsWith("#")) continue
    // Only what a browser would fetch over http. `javascript:`, `data:`, and
    // `mailto:` are not endpoints and are never requested.
    let url: URL
    try {
      url = new URL(raw, base)
    } catch {
      continue
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue
    if (url.origin !== base.origin) continue
    url.hash = ""
    found.push(url)
  }
  return found
}

function isHtml(contentType: string | null): boolean {
  return !!contentType && /text\/html|application\/xhtml/i.test(contentType)
}

function key(url: URL): string {
  const copy = new URL(url.toString())
  copy.hash = ""
  return copy.toString()
}

function bounded(value: unknown, maximum: number, minimum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) return maximum
  return Math.min(value, maximum)
}

function tally(pages: readonly CrawledPage[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const page of pages) counts[String(page.status)] = (counts[String(page.status)] ?? 0) + 1
  return counts
}

/** A refusal reaches an artifact, so it stays short and free of control characters. */
function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim().slice(0, 200)
}
