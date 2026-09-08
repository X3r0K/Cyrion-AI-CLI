/**
 * A deliberately imperfect lab used by the assessment tests.
 *
 * It is not a general-purpose vulnerable app: it exposes exactly the two
 * behaviours the starter skills look for, plus a control endpoint that behaves
 * correctly, so precision and recall are both measurable.
 */
const PROTECTED = {
  "content-security-policy": "default-src 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
}

export interface Lab {
  port: number
  /** Lets a test change the target between discovery and validation. */
  harden(value: boolean): void
  stop(): void
}

export function startLab(port = 0): Lab {
  let hardened = false
  const server = Bun.serve({
    port,
    fetch(request) {
      const path = new URL(request.url).pathname
      // The object endpoint answers without a credential: the finding to confirm.
      if (path.startsWith("/api/objects/")) {
        if (hardened) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json", ...PROTECTED },
          })
        }
        return Response.json({ id: path.split("/").pop(), owner: "someone-else", balance: 4210 })
      }
      // The control endpoint refuses, so a correct assessment raises nothing here.
      if (path.startsWith("/api/private/")) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json", ...PROTECTED },
        })
      }
      if (path === "/hardened") {
        return new Response("<html><title>hardened</title></html>", {
          headers: { "content-type": "text/html", ...PROTECTED },
        })
      }
      // The default page sets none of the browser protections: the second finding.
      return new Response("<html><title>lab</title><body>index</body></html>", {
        headers: {
          "content-type": "text/html",
          server: "cyrion-lab/1.0",
          ...(hardened ? PROTECTED : {}),
        },
      })
    },
  })
  return {
    port: server.port ?? port,
    harden: (value: boolean) => {
      hardened = value
    },
    stop: () => server.stop(true),
  }
}

if (import.meta.main) {
  const lab = startLab(Number(Bun.env.CYRION_LAB_PORT ?? 8123))
  console.error(`cyrion lab listening on ${lab.port}`)
}
