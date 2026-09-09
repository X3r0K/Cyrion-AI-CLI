import type { ScopePolicy, ToolExecutionRequest, ToolProgress } from "@cyrion/contracts"
import { evaluateScope, parseTarget } from "@cyrion/scope"
import { assertPinnedHost } from "./http"
import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "./types"

/** Requests one page load may make before the rest are refused outright. */
const MAX_REQUESTS = 300
/** Requests named in the summary. The artifact holds the whole log. */
const MAX_REPORTED = 60
/** Rendered DOM handed back to a worker. */
const MAX_DOM_SUMMARY = 16 * 1024
/** Rendered DOM written to the artifact. */
const MAX_DOM_ARTIFACT = 512 * 1024
/** Console lines kept. A page in a loop can produce thousands. */
const MAX_CONSOLE = 40
const MAX_CONSOLE_LENGTH = 300
const VIEWPORT = { width: 1280, height: 800 }

export type RequestDisposition = "allowed" | "blocked"

export interface BrowserRequestRecord {
  url: string
  method: string
  resourceType: string
  disposition: RequestDisposition
  /** Why it was blocked. Absent when it was allowed. */
  reason?: string
}

/**
 * Whether the page may make this request.
 *
 * This is the whole reason a browser capability is more than "we added
 * Playwright". Every other adapter makes the requests it decided to make; a
 * page makes whatever its markup and scripts tell it to — fonts, analytics,
 * a third-party tag manager, an API on a host nobody approved. Left alone a
 * headless browser is the single most likely capability to leave the scope,
 * and it would do it from the operator's own machine.
 *
 * So the decision is taken per request, against the same scope engine
 * everything else uses, and a refusal aborts the request rather than
 * recording it after the fact.
 */
export function requestDecision(
  scope: ScopePolicy,
  url: string,
): { allowed: boolean; reason?: string } {
  // A page may address things a scope expression cannot describe. None of them
  // leave the machine, and refusing them would break rendering for no gain.
  if (/^(data|blob|about):/i.test(url)) return { allowed: true }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { allowed: false, reason: "request URL could not be parsed" }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: `scheme ${parsed.protocol} is not http or https` }
  }
  const decision = evaluateScope(scope, parsed.toString())
  return decision.allowed
    ? { allowed: true }
    : { allowed: false, reason: decision.reason ?? "outside the approved scope" }
}

/** Hosts a page reached, in the order first seen, so a summary can name them. */
export function hostsOf(records: readonly BrowserRequestRecord[]): string[] {
  const hosts: string[] = []
  for (const record of records) {
    try {
      const host = new URL(record.url).hostname.toLowerCase()
      if (host && !hosts.includes(host)) hosts.push(host)
    } catch {
      // A request whose URL will not parse was refused before it was sent.
    }
  }
  return hosts
}

/** Console text is the page's own words: bounded, and stripped of terminal control. */
export function consoleLine(type: string, text: string): string {
  const clean = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim()
  return `${type}: ${clean}`.slice(0, MAX_CONSOLE_LENGTH)
}

/**
 * Renders one approved page and reports what it actually did.
 *
 * A crawl reads the links a site publishes, which is most of a server-rendered
 * application and almost none of a single-page one: the endpoints that matter
 * are the ones a script calls after the document loads, and no amount of HTML
 * parsing finds them. Rendering the page finds them by letting it run.
 *
 * What comes back is what happened — the final URL after redirects, the status,
 * the title, a screenshot, the rendered DOM, the page's own console errors, and
 * every request it attempted with the ones that left the scope marked refused.
 * As with a crawl, a discovered address is a report and never a permission:
 * the endpoints are recorded on an observation, and reaching one of them takes
 * a manifest that already covers it.
 */
export const browserSession: CapabilityAdapter = {
  capability: "browser.session",

  async execute(
    request: ToolExecutionRequest,
    context: CapabilityContext,
    signal: AbortSignal,
    progress?: ToolProgress,
  ): Promise<CapabilityResult> {
    const decision = evaluateScope(context.scope, request.target)
    if (!decision.allowed) throw new Error(`browser.session refused: ${decision.reason}`)
    const target = parseTarget(request.target)
    if (target.kind !== "url") throw new Error("browser.session needs a URL target")

    // The browser is driven from this process, so in container mode it is
    // outside the egress allowlist that governs every other capability. The
    // route filter below is the substitute, and it is a weaker guarantee than
    // the kernel's, so the operator says whether that trade is acceptable
    // rather than discovering it in a report.
    if (context.runner.kind === "container" && !context.allowHostBrowser) {
      throw new Error(
        "browser.session runs the browser on this host, outside the container's egress allowlist. "
        + "Scope is enforced per request by Cyrion rather than by the kernel. "
        + "Pass --allow-host-browser to accept that, or run with --sandbox local.",
      )
    }

    const input = (request.input ?? {}) as { waitUntil?: unknown; screenshot?: unknown }
    const waitUntil = readWaitUntil(input.waitUntil)
    const wantScreenshot = input.screenshot !== false

    const url = new URL(target.raw.replace(/\*$/, ""))
    await assertPinnedHost(url, context, "browser.session")

    const playwright = await loadPlaywright()
    const timeoutMs = Math.min(request.timeoutMs, 120_000)

    const records: BrowserRequestRecord[] = []
    const messages: string[] = []
    let overflowed = false

    progress?.(`launching a browser for ${url.host}`)
    const browser = await playwright.chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({
        viewport: VIEWPORT,
        userAgent: USER_AGENT,
        // A target's certificate is something to report, not something to make
        // the run fail; net.tls is where a certificate is actually assessed.
        ignoreHTTPSErrors: true,
      })
      page.setDefaultTimeout(timeoutMs)

      await page.route("**/*", async (route: PlaywrightRoute) => {
        const requested = route.request()
        const requestedUrl = requested.url()
        if (records.length >= MAX_REQUESTS) {
          overflowed = true
          await route.abort().catch(() => undefined)
          return
        }
        const verdict = requestDecision(context.scope, requestedUrl)
        records.push({
          url: requestedUrl.slice(0, 2_048),
          method: requested.method(),
          resourceType: requested.resourceType(),
          disposition: verdict.allowed ? "allowed" : "blocked",
          ...(verdict.reason ? { reason: verdict.reason } : {}),
        })
        if (!verdict.allowed) {
          await route.abort().catch(() => undefined)
          return
        }
        await route.continue().catch(() => undefined)
      })

      page.on("console", (message: PlaywrightConsoleMessage) => {
        if (messages.length >= MAX_CONSOLE) return
        const type = message.type()
        if (type !== "error" && type !== "warning") return
        messages.push(consoleLine(type, message.text()))
      })

      const abort = (): void => void page.close().catch(() => undefined)
      signal.addEventListener("abort", abort, { once: true })

      progress?.(`loading ${url.pathname}`)
      const response = await page.goto(url.toString(), { waitUntil, timeout: timeoutMs })
      const status = response?.status() ?? 0
      const finalUrl = page.url()
      // A redirect the browser followed went through the route filter above, so
      // it was already held to the scope. Recording where it ended up is what
      // lets a reader see that it did.
      const finalDecision = evaluateScope(context.scope, finalUrl)
      const title = (await page.title().catch(() => "")).slice(0, 200)
      const dom = (await page.content().catch(() => "")).slice(0, MAX_DOM_ARTIFACT)
      const shot = wantScreenshot
        ? await page.screenshot({ fullPage: false }).catch(() => undefined)
        : undefined

      signal.removeEventListener("abort", abort)

      const evidence: CapabilityResult["evidence"] = []
      if (shot) {
        evidence.push(await context.evidence.capture({
          engagementId: request.engagementId,
          id: context.nextEvidenceId("E"),
          kind: "response",
          bytes: new Uint8Array(shot),
          contentType: "image/png",
          source: request.agentId,
        }))
      }
      evidence.push(await context.evidence.capture({
        engagementId: request.engagementId,
        id: context.nextEvidenceId("E"),
        kind: "response",
        content: `${JSON.stringify({
          url: url.toString(),
          finalUrl,
          status,
          title,
          waitUntil,
          viewport: VIEWPORT,
          console: messages,
          requests: records,
          requestsTruncated: overflowed,
        }, null, 2)}\n`,
        contentType: "application/json",
        source: request.agentId,
      }))
      evidence.push(await context.evidence.capture({
        engagementId: request.engagementId,
        id: context.nextEvidenceId("E"),
        kind: "response",
        content: dom,
        contentType: "text/html",
        source: request.agentId,
      }))

      const allowed = records.filter((record) => record.disposition === "allowed")
      const blocked = records.filter((record) => record.disposition === "blocked")
      return {
        summary: {
          url: url.toString(),
          finalUrl,
          // The browser follows redirects, so the page it settled on is worth
          // stating separately from the one that was asked for.
          redirected: finalUrl !== url.toString(),
          finalUrlInScope: finalDecision.allowed,
          status,
          title,
          requests: records.length,
          requestsTruncated: overflowed,
          blocked: blocked.length,
          hosts: hostsOf(allowed),
          blockedHosts: hostsOf(blocked),
          // What the page called, for the planner to compare against the
          // manifest. Reporting an endpoint is not permission to visit it.
          endpoints: allowed
            .filter((record) => record.resourceType === "xhr" || record.resourceType === "fetch")
            .map((record) => record.url)
            .slice(0, MAX_REPORTED),
          console: messages,
          domBytes: dom.length,
          dom: dom.slice(0, MAX_DOM_SUMMARY),
          domTruncated: dom.length > MAX_DOM_SUMMARY,
        },
        evidence,
        outcome: `rendered ${url.pathname} → ${status}`
          + `${title ? ` · ${title}` : ""}`
          + ` · ${records.length} request${records.length === 1 ? "" : "s"}`
          + `${blocked.length ? `, ${blocked.length} refused` : ""}`,
      }
    } finally {
      await browser.close().catch(() => undefined)
    }
  },
}

const USER_AGENT = "cyrion-community/0.1 (+authorized assessment)"

type WaitUntil = "load" | "domcontentloaded" | "networkidle"

function readWaitUntil(value: unknown): WaitUntil {
  if (value === undefined) return "load"
  if (value === "load" || value === "domcontentloaded" || value === "networkidle") return value
  throw new Error("browser.session waitUntil must be load, domcontentloaded, or networkidle")
}

/**
 * Playwright, if the operator installed it.
 *
 * It is not a dependency of Cyrion. A browser and its driver are a hundred
 * megabytes for a capability most engagements never grant, and `--sandbox
 * local` is supposed to work on a machine with nothing installed. So this is
 * the same bargain as nmap: absent is fine, and the error says what to run.
 */
async function loadPlaywright(): Promise<PlaywrightModule> {
  // Built from a variable rather than written as a literal, so the type check
  // and the bundler both treat it as a runtime lookup. A literal would make an
  // optional package a build requirement, which is the opposite of optional.
  const specifier = "playwright"
  try {
    return (await import(specifier)) as unknown as PlaywrightModule
  } catch {
    throw new Error(
      "browser.session needs the optional playwright package, which is not installed. "
      + "Run `bun add playwright && bunx playwright install chromium`, "
      + "or drop browser.session from the manifest's capabilities.",
    )
  }
}

/**
 * The slice of Playwright this adapter uses.
 *
 * Declared here rather than imported, so the package stays optional: a type
 * import would make the build require something an operator may never install.
 */
interface PlaywrightModule {
  chromium: {
    launch(options: { headless: boolean }): Promise<PlaywrightBrowser>
  }
}

interface PlaywrightBrowser {
  newPage(options: Record<string, unknown>): Promise<PlaywrightPage>
  close(): Promise<void>
}

interface PlaywrightPage {
  setDefaultTimeout(ms: number): void
  route(pattern: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void>
  on(event: "console", handler: (message: PlaywrightConsoleMessage) => void): void
  goto(url: string, options: { waitUntil: WaitUntil; timeout: number }): Promise<{ status(): number } | null>
  url(): string
  title(): Promise<string>
  content(): Promise<string>
  screenshot(options: { fullPage: boolean }): Promise<Uint8Array>
  close(): Promise<void>
}

export interface PlaywrightRoute {
  request(): { url(): string; method(): string; resourceType(): string }
  abort(): Promise<void>
  continue(): Promise<void>
}

export interface PlaywrightConsoleMessage {
  type(): string
  text(): string
}
