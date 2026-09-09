/**
 * The labs the benchmark measures against.
 *
 * Each one exists to make a different number honest. The imperfect lab has
 * issues to find, so recall means something. The clean lab has none, so a
 * finding raised against it is a false positive and precision means something.
 * The partial lab answers inconsistently, so a run that reports `inconclusive`
 * rather than guessing can be told apart from one that guesses well.
 */

const PROTECTED = {
  "content-security-policy": "default-src 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
} as const

export interface LabServer {
  port: number
  stop(): void
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } })

const html = (body: string, headers: Record<string, string> = {}): Response =>
  new Response(`<html><title>lab</title><body>${body}</body></html>`, {
    headers: { "content-type": "text/html", ...headers },
  })

/**
 * Everything correct. A run that raises anything here has raised a false
 * positive, which is the only way to measure precision honestly.
 */
export function startCleanLab(port = 0): LabServer {
  const server = Bun.serve({
    port,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path.startsWith("/api/")) return json({ error: "unauthorized" }, 401, PROTECTED)
      return html("index", { server: "cyrion-lab-clean/1.0", ...PROTECTED })
    },
  })
  return { port: server.port ?? port, stop: () => server.stop(true) }
}

/**
 * How many looks the endpoint answers before it starts refusing.
 *
 * A run looks at each asset once for recon and once per assessment role before
 * a validator ever sees it, so three answers put the refusal exactly where a
 * validator lands. The number is coupled to the shape of a run on purpose, and
 * a test asserts the outcome rather than the count — change the flow and that
 * test fails loudly instead of the lab quietly measuring nothing.
 */
export const PARTIAL_LAB_ANSWERS = 3

/**
 * Deliberately unstable: the object endpoint answers while it is being
 * inventoried and assessed, then refuses everything after.
 *
 * An independent reproduction therefore never sees what discovery saw. The
 * honest outcomes are `rejected` or `inconclusive`; `confirmed` would mean the
 * run asserted something it could not check, and the benchmark fails on it.
 *
 * The count is tied to the shape of a run — recon looks once, assessment looks
 * once — rather than to a clock, so the lab behaves the same on a fast machine
 * and a slow one and the benchmark stays reproducible.
 */
export function startPartialLab(port = 0): LabServer {
  const looks = new Map<string, number>()
  const server = Bun.serve({
    port,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path.startsWith("/api/flaky/")) {
        const seen = (looks.get(path) ?? 0) + 1
        looks.set(path, seen)
        return seen <= PARTIAL_LAB_ANSWERS
          ? json({ id: path.split("/").pop(), owner: "someone-else" }, 200, PROTECTED)
          : json({ error: "unauthorized" }, 401, PROTECTED)
      }
      if (path.startsWith("/api/")) return json({ error: "unauthorized" }, 401, PROTECTED)
      return html("index", { server: "cyrion-lab-partial/1.0", ...PROTECTED })
    },
  })
  return { port: server.port ?? port, stop: () => server.stop(true) }
}

if (import.meta.main) {
  const which = Bun.argv[2] ?? "clean"
  const port = Number(Bun.env.CYRION_LAB_PORT ?? 0)
  const lab = which === "partial" ? startPartialLab(port) : startCleanLab(port)
  console.error(`cyrion ${which} lab listening on ${lab.port}`)
}
