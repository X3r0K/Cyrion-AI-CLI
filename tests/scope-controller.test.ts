import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { assertManifest, type EngagementManifest, type EngagementSnapshot } from "@cyrion/contracts"
import { CyrionController, FixtureRootPlanner, ScopedToolGateway } from "@cyrion/controller"
import { MemoryEvidenceStore } from "@cyrion/evidence"
import { createScopeLock, scopeHash } from "@cyrion/scope"
import { FixtureAgentRuntime, FixtureToolAdapter } from "@cyrion/runtime-opencode"

const projectRoot = join(import.meta.dir, "..")

async function baseManifest(): Promise<EngagementManifest> {
  const value: unknown = await Bun.file(join(projectRoot, "fixtures/demo/engagement.json")).json()
  assertManifest(value)
  return value
}

function build(manifest: EngagementManifest, scopeLock?: unknown): CyrionController {
  const adapter = new FixtureToolAdapter()
  return new CyrionController(
    manifest,
    new FixtureAgentRuntime(),
    new FixtureRootPlanner(),
    join(projectRoot, "agents"),
    {
      toolGateway: new ScopedToolGateway(manifest, { "fixture.read": adapter, "fixture.compare": adapter }),
      heartbeatIntervalMs: 50,
      evidenceStore: new MemoryEvidenceStore(),
      ...(scopeLock === undefined ? {} : { scopeLock }),
    },
  )
}

describe("scope enforcement at the controller boundary", () => {
  test("refuses to start on a scope expression it cannot parse", async () => {
    const manifest = await baseManifest()
    const broken = { ...manifest, scope: { ...manifest.scope, targets: ["demo.lab.test", "10.0.0.0/33"] } }
    expect(() => build(broken)).toThrow(/Invalid engagement scope/)
  })

  test("records the scope hash on the engagement it started", async () => {
    const manifest = await baseManifest()
    const controller = build(manifest)
    const snapshot: EngagementSnapshot = await controller.run()
    controller.close()
    const started = snapshot.events.find((event) => event.type === "engagement.started")
    expect((started?.payload as { scopeHash?: string }).scopeHash).toBe(scopeHash(manifest.scope))
  })

  test("accepts an operator lock written for this exact scope", async () => {
    const manifest = await baseManifest()
    const lock = createScopeLock(manifest, "Authorized by the platform team, ticket SEC-1042")
    const controller = build(manifest, lock)
    const snapshot = await controller.run()
    controller.close()
    expect(snapshot.status).toBe("completed")
  })

  test("refuses a lock that no longer matches the scope it attested to", async () => {
    const manifest = await baseManifest()
    const lock = createScopeLock(manifest, "Authorized by the platform team, ticket SEC-1042")
    const widened: EngagementManifest = {
      ...manifest,
      scope: { ...manifest.scope, targets: [...manifest.scope.targets, "10.0.0.0/8"] },
    }
    expect(() => build(widened, lock)).toThrow(/does not match the current scope/)
    expect(() => build({ ...manifest, id: "ENG-OTHER" }, lock)).toThrow(/written for engagement/)
    expect(() => build(manifest, { version: "nope" })).toThrow(/Scope lock rejected/)
  })

  test("admits a task target inside an approved range, and refuses one outside it", async () => {
    const manifest = await baseManifest()
    const ranged: EngagementManifest = {
      ...manifest,
      scope: { ...manifest.scope, targets: ["10.10.0.0/24"], excluded: ["10.10.0.1"] },
    }
    const gateway = new ScopedToolGateway(ranged, { "fixture.read": new FixtureToolAdapter() })
    const emit = (): void => {}
    const bind = (target: string) => gateway.bind({
      engagementId: ranged.id,
      agentId: "web-t-001",
      task: {
        id: "T-001", key: "k", role: "web", objective: "o", target,
        capabilities: ["fixture.read"], dependencies: [], depth: 1, expectedOutput: "assessment",
      },
      emit,
    })
    const invoke = { capability: "fixture.read", timeoutMs: 1_000, maxOutputBytes: 1_024, input: {} }

    // Inside the approved range the gateway hands the call to the adapter.
    expect((await bind("10.10.0.9").execute({ ...invoke, target: "10.10.0.9" })).outputBytes).toBeGreaterThan(0)
    expect(bind("10.10.0.1").execute({ ...invoke, target: "10.10.0.1" })).rejects.toThrow(/outside the approved scope/)
    expect(bind("10.11.0.9").execute({ ...invoke, target: "10.11.0.9" })).rejects.toThrow(/outside the approved scope/)
  })
})
