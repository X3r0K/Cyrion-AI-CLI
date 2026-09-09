import { describe, expect, test } from "bun:test"
import { assertManifest } from "@cyrion/contracts"
import { createScopeLock, evaluateScope, verifyScopeLock } from "@cyrion/scope"
import {
  applicableCapabilities,
  buildScanManifest,
  scanCapabilities,
  defaultScanInput,
  engagementId,
  normalizeTarget,
  scanInputError,
  type ScanInput,
} from "../apps/cli/src/scan-config"
import {
  adjustLaunch,
  createLaunchState,
  editLaunchField,
  isLaunchTextField,
  launchKey,
  launchReadiness,
  moveLaunchSelection,
  selectedLaunchField,
  toggleCapability,
} from "../apps/cli/src/launch-ui"

function input(overrides: Partial<ScanInput> = {}): ScanInput {
  return {
    ...defaultScanInput,
    target: "https://example.com",
    ...overrides,
  }
}

describe("configuring a scan", () => {
  test("turns one address into a manifest the controller accepts", () => {
    const manifest = buildScanManifest(input())
    expect(() => assertManifest(manifest)).not.toThrow()
    expect(manifest.scope.targets).toEqual(["https://example.com/"])
    expect(manifest.id).toMatch(/^ENG-example-com-[a-f0-9]{8}$/)
    // A bare origin has to cover the pages under it, or a site scan sees one page.
    expect(evaluateScope(manifest.scope, "https://example.com/about").allowed).toBe(true)
    expect(evaluateScope(manifest.scope, "https://other.test/").allowed).toBe(false)
  })

  test("an address is the only thing a scan needs", () => {
    // No attestation, no capability checklist, no mode: naming the target is
    // the whole decision, and everything the target kind supports is granted.
    const manifest = buildScanManifest({ ...defaultScanInput, target: "example.com" })
    expect(scanInputError({ ...defaultScanInput, target: "example.com" })).toBeUndefined()
    expect(manifest.scope.capabilities).toContain("http.probe")
    expect(manifest.scope.capabilities).toContain("http.crawl")
    // Reproduction is granted like anything else now, rather than being opt-in.
    expect(manifest.scope.capabilities).toContain("poc.run")
    expect(manifest.mode).toBe("autonomous")
  })

  test("assumes https, keeps an explicit path, and refuses embedded credentials", () => {
    expect(normalizeTarget("example.com")).toBe("https://example.com/")
    expect(normalizeTarget("https://example.com/app")).toBe("https://example.com/app")
    expect(normalizeTarget("https://example.com:8443")).toBe("https://example.com:8443/")
    expect(() => buildScanManifest(input({ target: "https://user:pw@example.com" })))
      .toThrow(/credentials/)
  })

  test("the address is the only thing that can be wrong", () => {
    expect(scanInputError(input({ target: "" }))).toContain("Enter an address")
    // Everything that used to be a refusal here is now the operator's call:
    // no authorization string, and plain http reaches a plain-http target.
    expect(scanInputError(input({ target: "http://example.com" }))).toBeUndefined()
    expect(scanInputError(input({ target: "http://127.0.0.1:8123/" }))).toBeUndefined()
    expect(scanInputError(input({ target: "https://user:pw@example.com" }))).toContain("credentials")
  })

  test("drops a capability the target kind cannot use instead of refusing it", () => {
    expect(applicableCapabilities("https://example.com")).not.toContain("net.portscan")
    expect(applicableCapabilities("10.0.0.0/24")).toContain("net.portscan")
    // Naming a port scan against a URL is not an error to correct; it is a
    // capability that does not apply, so it never reaches the manifest.
    expect(scanInputError(input({ capabilities: ["http.probe", "net.portscan"] }))).toBeUndefined()
    const manifest = buildScanManifest(input({ capabilities: ["http.probe", "net.portscan"] }))
    expect(manifest.scope.capabilities).toEqual(["http.probe"])
  })

  test("reproduction no longer forces a run to be supervised", () => {
    const manifest = buildScanManifest(input({
      capabilities: ["dns.lookup", "http.probe", "poc.run"],
      mode: "autonomous",
    }))
    expect(manifest.mode).toBe("autonomous")
    expect(manifest.scope.capabilities).toContain("poc.run")
  })

  test("produces a lock the controller will verify against the manifest", () => {
    const manifest = buildScanManifest(input())
    const lock = createScopeLock(manifest, "I own example.com, ticket SEC-1")
    expect(verifyScopeLock(lock, manifest)).toBeUndefined()

    // Widening the scope after locking must invalidate the attestation.
    const widened = { ...manifest, scope: { ...manifest.scope, targets: ["https://example.com/", "https://other.test/"] } }
    expect(verifyScopeLock(lock, widened)).toBeDefined()
  })

  test("gives two scans of the same target distinct identifiers over time", () => {
    const first = engagementId("https://example.com/", new Date("2026-09-08T10:00:00Z"))
    const second = engagementId("https://example.com/", new Date("2026-09-08T10:00:01Z"))
    expect(first).not.toBe(second)
    expect(engagementId("https://example.com/", new Date("2026-09-08T10:00:00Z"))).toBe(first)
  })
})

describe("the launch form", () => {
  test("walks the capability list before leaving the row", () => {
    let state = createLaunchState(input())
    state = moveLaunchSelection(state, 1)
    expect(selectedLaunchField(state)).toBe("capabilities")
    expect(state.capabilityIndex).toBe(0)
    // Walk to the last capability by count rather than by a fixed number of
    // steps, so adding one does not silently move this test onto another row.
    for (let step = 1; step < scanCapabilities.length; step += 1) {
      state = moveLaunchSelection(state, 1)
      expect(selectedLaunchField(state)).toBe("capabilities")
    }
    expect(state.capabilityIndex).toBe(scanCapabilities.length - 1)
    state = moveLaunchSelection(state, 1)
    expect(selectedLaunchField(state)).toBe("sandbox")
  })

  test("toggles a capability off and back on, and says which ones act", () => {
    let state = createLaunchState(input())
    while (selectedLaunchField(state) !== "capabilities") state = moveLaunchSelection(state, 1)
    const poc = scanCapabilities.findIndex((capability) => capability.name === "poc.run")
    while (state.capabilityIndex < poc) state = moveLaunchSelection(state, 1)
    // Everything applicable is on by default now, so the first toggle removes it.
    expect(state.input.capabilities).toContain("poc.run")
    state = toggleCapability(state)
    expect(state.input.capabilities).not.toContain("poc.run")
    state = toggleCapability(state)
    expect(state.input.capabilities).toContain("poc.run")
    // Still worth saying what it does; it just no longer changes the mode.
    expect(state.message).toContain("acts against the live target")
  })

  test("drops a capability the new target cannot support", () => {
    let state = createLaunchState(input({ target: "10.0.0.0/24", capabilities: ["http.probe", "net.portscan"] }))
    state = editLaunchField(state, "target", "https://example.com")
    expect(state.input.capabilities).toEqual(["http.probe"])
  })

  test("reports why a scan cannot start, and clears once it can", () => {
    let state = createLaunchState({ ...defaultScanInput, target: "" })
    expect(launchReadiness(state).ready).toBe(false)
    expect(launchReadiness(state).reason).toContain("Enter an address")
    // An address is the whole requirement: nothing else has to be filled in.
    state = editLaunchField(state, "target", "https://example.com")
    expect(launchReadiness(state)).toEqual({ ready: true })
  })

  test("cycles the choices and knows which fields are typed", () => {
    let state = createLaunchState(input())
    while (selectedLaunchField(state) !== "sandbox") state = moveLaunchSelection(state, 1)
    expect(isLaunchTextField("sandbox")).toBe(false)
    const flipped = adjustLaunch(state, 1)
    expect(flipped.input.sandbox).not.toBe(state.input.sandbox)
    expect(isLaunchTextField("target")).toBe(true)
    expect(isLaunchTextField("attestation")).toBe(true)
  })

  test("strips control characters from typed input", () => {
    const state = editLaunchField(createLaunchState(input()), "attestation", "ticket SEC-1[31m")
    expect(state.input.attestation).toBe("ticket SEC-1[31m")
  })
})

/**
 * One key mapping, two hosts: the standalone launch screen and the Mission
 * view. A key that means something different in either place is a bug.
 */
describe("driving the launch form from the keyboard", () => {
  test("moves, changes, and toggles without leaving the form", () => {
    const state = createLaunchState(input())
    const moved = launchKey(state, "down")
    expect(moved?.kind).toBe("state")
    expect(moved?.kind === "state" && selectedLaunchField(moved.state)).toBe("capabilities")
    let sandbox = state
    while (selectedLaunchField(sandbox) !== "sandbox") sandbox = moveLaunchSelection(sandbox, 1)
    const changed = launchKey(sandbox, "right")
    expect(changed?.kind === "state" && changed.state.input.sandbox).not.toBe(sandbox.input.sandbox)
    const toggled = launchKey(moved?.kind === "state" ? moved.state : state, "space")
    expect(toggled?.kind === "state" && toggled.state.input.capabilities).not.toContain("dns.lookup")
  })

  test("opens the footer editor only on a typed field", () => {
    const state = createLaunchState(input())
    expect(launchKey(state, "return")?.kind).toBe("edit")
    let sandbox = state
    while (selectedLaunchField(sandbox) !== "sandbox") sandbox = moveLaunchSelection(sandbox, 1)
    expect(launchKey(sandbox, "return")).toBeUndefined()
  })

  test("refuses to start without an address, and says so", () => {
    const state = createLaunchState({ ...defaultScanInput, target: "" })
    const refused = launchKey(state, "s")
    expect(refused?.kind).toBe("state")
    expect(refused?.kind === "state" && refused.state.message).toContain("Enter an address")
  })

  test("starts on an address alone, and cancels on escape", () => {
    const state = createLaunchState({ ...defaultScanInput, target: "https://example.com" })
    const started = launchKey(state, "s")
    expect(started?.kind).toBe("start")
    expect(started?.kind === "start" && started.input.target).toBe("https://example.com")
    expect(launchKey(state, "escape")?.kind).toBe("cancel")
    expect(launchKey(state, "q")?.kind).toBe("cancel")
  })

  test("ignores keys that belong to the terminal around it", () => {
    const state = createLaunchState(input())
    // `p` pauses and `r` exports a report on the dashboard; inside the form
    // they must do nothing at all rather than reach the engagement behind it.
    expect(launchKey(state, "p")).toBeUndefined()
    expect(launchKey(state, "r")).toBeUndefined()
    expect(launchKey(state, "a")).toBeUndefined()
  })
})
