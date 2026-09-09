import { afterAll, describe, expect, test } from "bun:test"
import { resolveEntry } from "@cyrion/capabilities"
import { ContainerToolRunner, containerEngineReady, inspectWorkerImage, workerImageLabel } from "@cyrion/sandbox"

/**
 * These exercise a real container. They are opt-in because they need a working
 * engine and a pullable image; everything they prove about policy generation is
 * also covered by the pure tests in sandbox-runner.test.ts.
 */
const image = Bun.env.CYRION_TEST_IMAGE ?? "alpine:3.20"
const enabled = Bun.env.CYRION_TEST_CONTAINER === "1"
const engine = Bun.which("docker") ? "docker" as const : "podman" as const

let runner: ContainerToolRunner | undefined
afterAll(async () => {
  await runner?.close()
})

describe.skipIf(!enabled)("the image a run would execute in", () => {
  test("reads the identity under the tag, and says plainly when there is none", async () => {
    const status = await inspectWorkerImage(engine, image)
    expect(status.present).toBe(true)
    expect(status.id).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(workerImageLabel(status)).toContain("sha256:")

    const absent = await inspectWorkerImage(engine, "cyrion/definitely-not-built:0")
    expect(absent.present).toBe(false)
    expect(absent.detail).toContain("build-worker.sh")
  })

  test("refuses to start on an image that is not there, before anything runs", async () => {
    const missing = new ContainerToolRunner({
      engine,
      image: "cyrion/definitely-not-built:0",
      engagementId: "ENG-MISSING-IMAGE",
      allowedBinaries: ["id"],
    })
    // The engine is never asked to run anything: the refusal names the fix.
    expect(missing.start()).rejects.toThrow(/is not on this machine/)
    await missing.close()
  })

  test("starts once when several workers arrive at the same time", async () => {
    const shared = new ContainerToolRunner({
      engine,
      image,
      engagementId: "ENG-PARALLEL-START",
      allowedBinaries: ["id"],
      egress: { destinations: [{ address: "127.0.0.1" }] },
    })
    try {
      // Workers run in parallel and each starts the sandbox lazily. Two
      // containers with one engagement's name is a conflict the engine refuses,
      // so the second arrival has to wait for the first rather than race it.
      const results = await Promise.all([
        shared.run({ argv: ["id"], timeoutMs: 20_000, maxOutputBytes: 4_096 }),
        shared.run({ argv: ["id"], timeoutMs: 20_000, maxOutputBytes: 4_096 }),
        shared.run({ argv: ["id"], timeoutMs: 20_000, maxOutputBytes: 4_096 }),
      ])
      for (const result of results) expect(result.stdout).toContain("uid=1000")
    } finally {
      await shared.close()
    }
  }, 120_000)

  test("refuses an image that is not the one this release pinned", async () => {
    const status = await inspectWorkerImage(engine, image)
    const wrong = new ContainerToolRunner({
      engine,
      image,
      engagementId: "ENG-WRONG-IMAGE",
      allowedBinaries: ["id"],
      pin: { image, id: "sha256:" + "0".repeat(64), pinned: true },
    })
    expect(status.present).toBe(true)
    expect(wrong.start()).rejects.toThrow(/pins that image/)
    await wrong.close()
  })
})

describe.skipIf(!enabled)("container sandbox", () => {
  test("reports whether the engine can actually start something", async () => {
    const status = await containerEngineReady(engine)
    expect(typeof status.ready).toBe("boolean")
    expect(status.detail.length).toBeGreaterThan(0)
  })

  test("runs unprivileged, read-only, and behind an egress allowlist", async () => {
    runner = new ContainerToolRunner({
      engine,
      image,
      engagementId: "ENG-CONTAINER-TEST",
      allowedBinaries: ["id", "cat", "nc"],
      egress: { destinations: [{ address: "127.0.0.1" }] },
    })
    await runner.start()

    const report = runner.report()
    expect(report.ready).toBe(true)
    expect(report.missing).toEqual([])
    expect(runner.egressApplied).toBe(true)

    const identity = await runner.run({ argv: ["id"], timeoutMs: 15_000, maxOutputBytes: 4_096 })
    expect(identity.stdout).toContain("uid=1000")

    const shadow = await runner.run({ argv: ["cat", "/etc/shadow"], timeoutMs: 15_000, maxOutputBytes: 4_096 })
    expect(shadow.exitCode).not.toBe(0)

    const egress = await runner.run({
      argv: ["nc", "-z", "-w", "3", "1.1.1.1", "443"],
      timeoutMs: 20_000,
      maxOutputBytes: 4_096,
    })
    expect(egress.exitCode).not.toBe(0)

    expect(runner.run({ argv: ["wget", "http://example.com"], timeoutMs: 5_000, maxOutputBytes: 512 }))
      .rejects.toThrow(/not allowed in this engagement/)
  }, 180_000)

  test("refuses to start unfiltered unless the operator accepts it", async () => {
    const unfiltered = new ContainerToolRunner({
      engine,
      image,
      engagementId: "ENG-CONTAINER-UNFILTERED",
      allowedBinaries: ["id"],
    })
    try {
      expect(unfiltered.start()).rejects.toThrow(/Refusing to run with unfiltered egress/)
    } finally {
      await unfiltered.close()
    }
  }, 120_000)
})

describe("pinning addresses for curl", () => {
  test("puts every pinned address in one entry, IPv4 first, IPv6 bracketed", () => {
    // Separate --resolve flags for one host and port do not fall back: curl
    // commits to the first set, which strands a run whose pin answered with an
    // IPv6 address inside an IPv4-only sandbox.
    expect(resolveEntry("example.com", "443", ["2606:4700:10::6814:179a", "104.20.23.154"]))
      .toBe("example.com:443:104.20.23.154,[2606:4700:10::6814:179a]")
  })

  test("brackets IPv6 because the entry is itself colon-separated", () => {
    // Unbracketed, curl splits host:port:2606:4700:... on every colon and
    // misparses the whole entry rather than the address alone.
    const entry = resolveEntry("app.test", "8443", ["::1"])
    expect(entry).toBe("app.test:8443:[::1]")
    expect(entry.split(":").length).toBeGreaterThan(3)
  })

  test("leaves a single IPv4 address exactly as curl expects it", () => {
    expect(resolveEntry("app.test", "80", ["10.0.0.7"])).toBe("app.test:80:10.0.0.7")
  })
})
