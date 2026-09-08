import { afterAll, describe, expect, test } from "bun:test"
import { ContainerToolRunner, containerEngineReady } from "@cyrion/sandbox"

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
