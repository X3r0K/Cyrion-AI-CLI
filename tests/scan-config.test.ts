import { describe, expect, test } from "bun:test"
import { assertManifest } from "@cyrion/contracts"
import { createScopeLock, evaluateScope, verifyScopeLock } from "@cyrion/scope"
import {
  applicableCapabilities,
  buildScanManifest,
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
  launchReadiness,
  moveLaunchSelection,
  selectedLaunchField,
  toggleCapability,
} from "../apps/cli/src/launch-ui"

function input(overrides: Partial<ScanInput> = {}): ScanInput {
  return {
    ...defaultScanInput,
    target: "https://example.com",
    attestation: "I own example.com, ticket SEC-1",
    ...overrides,
  }
}

describe("configuring a scan", () => {
  test("turns one address into a manifest the controller accepts", () => {
    const manifest = buildScanManifest(input())
    expect(() => assertManifest(manifest)).not.toThrow()
    expect(manifest.scope.targets).toEqual(["https://example.com/"])
    expect(manifest.scope.capabilities).toEqual(["dns.lookup", "http.probe"])
    expect(manifest.id).toMatch(/^ENG-example-com-[a-f0-9]{8}$/)
    // A bare origin has to cover the pages under it, or a site scan sees one page.
    expect(evaluateScope(manifest.scope, "https://example.com/about").allowed).toBe(true)
    expect(evaluateScope(manifest.scope, "https://other.test/").allowed).toBe(false)
  })

  test("assumes https, keeps an explicit path, and refuses embedded credentials", () => {
    expect(normalizeTarget("example.com")).toBe("https://example.com/")
    expect(normalizeTarget("https://example.com/app")).toBe("https://example.com/app")
    expect(normalizeTarget("https://example.com:8443")).toBe("https://example.com:8443/")
    expect(() => buildScanManifest(input({ target: "https://user:pw@example.com" })))
      .toThrow(/credentials/)
  })

  test("refuses to start without authorization, a target, or a capability", () => {
    expect(scanInputError(input({ target: "" }))).toContain("Enter the address")
    expect(scanInputError(input({ attestation: "short" }))).toContain("who authorized")
    expect(scanInputError(input({ capabilities: [] }))).toContain("at least one capability")
    // Cleartext to somebody else's host would put the assessment on the wire.
    expect(scanInputError(input({ target: "http://example.com" }))).toContain("cleartext")
    expect(scanInputError(input({ target: "http://127.0.0.1:8123/" }))).toBeUndefined()
  })

  test("keeps a port scan away from a URL target", () => {
    expect(applicableCapabilities("https://example.com")).not.toContain("net.portscan")
    expect(applicableCapabilities("10.0.0.0/24")).toContain("net.portscan")
    expect(scanInputError(input({ capabilities: ["http.probe", "net.portscan"] })))
      .toContain("needs a host or range target")
  })

  test("makes a reproducing run supervised whatever the form said", () => {
    const manifest = buildScanManifest(input({
      capabilities: ["dns.lookup", "http.probe", "poc.run"],
      mode: "autonomous",
    }))
    expect(manifest.mode).toBe("supervised")
    expect(buildScanManifest(input()).mode).toBe("autonomous")
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
    for (let step = 0; step < 4; step += 1) state = moveLaunchSelection(state, 1)
    // Still on the row, at its last entry.
    expect(selectedLaunchField(state)).toBe("capabilities")
    state = moveLaunchSelection(state, 1)
    expect(selectedLaunchField(state)).toBe("sandbox")
  })

  test("toggles a capability and warns when reproduction is switched on", () => {
    let state = createLaunchState(input())
    while (selectedLaunchField(state) !== "capabilities") state = moveLaunchSelection(state, 1)
    while (state.capabilityIndex < 3) state = moveLaunchSelection(state, 1)
    state = toggleCapability(state)
    expect(state.input.capabilities).toContain("poc.run")
    expect(state.message).toContain("supervised")
    state = toggleCapability(state)
    expect(state.input.capabilities).not.toContain("poc.run")
  })

  test("drops a capability the new target cannot support", () => {
    let state = createLaunchState(input({ target: "10.0.0.0/24", capabilities: ["http.probe", "net.portscan"] }))
    state = editLaunchField(state, "target", "https://example.com")
    expect(state.input.capabilities).toEqual(["http.probe"])
  })

  test("reports why a scan cannot start, and clears once it can", () => {
    let state = createLaunchState({ ...defaultScanInput, target: "", attestation: "" })
    expect(launchReadiness(state).ready).toBe(false)
    state = editLaunchField(state, "target", "https://example.com")
    expect(launchReadiness(state).reason).toContain("who authorized")
    state = editLaunchField(state, "attestation", "Authorized by me, ticket SEC-1")
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
