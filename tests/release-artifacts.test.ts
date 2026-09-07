import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { assertCycloneDxBom, createCycloneDxBom } from "../scripts/sbom"

const projectRoot = join(import.meta.dir, "..")
const timestamp = "2026-09-06T00:00:00.000Z"

describe("release provenance artifacts", () => {
  test("builds a deterministic CycloneDX production dependency graph", async () => {
    const first = await createCycloneDxBom(projectRoot, timestamp)
    const second = await createCycloneDxBom(projectRoot, timestamp)
    assertCycloneDxBom(first)

    expect(second).toEqual(first)
    expect(first.metadata.timestamp).toBe(timestamp)
    expect(first.metadata.component).toEqual(expect.objectContaining({
      name: "cyrion-community",
      version: "0.1.0-alpha.2",
      purl: "pkg:npm/cyrion-community@0.1.0-alpha.2",
    }))

    const purls = first.components.map((component) => component.purl)
    expect(purls).toContain("pkg:npm/%40opencode-ai/sdk@1.18.29")
    expect(purls).toContain("pkg:npm/%40opentui/core@0.5.10")
    expect(purls).toContain("pkg:npm/cross-spawn@7.0.6")
    expect(purls).toContain("pkg:npm/%40opentui/core-linux-x64@0.5.10")
    expect(purls).toContain("pkg:npm/typescript@5.9.2")
    expect(purls.some((purl) => purl.includes("%40types"))).toBe(false)

    const root = first.dependencies.find((dependency) => dependency.ref === first.metadata.component["bom-ref"])
    expect(root?.dependsOn).toEqual([
      "pkg:npm/%40opencode-ai/sdk@1.18.29",
      "pkg:npm/%40opentui/core@0.5.10",
    ])
  })

  test("rejects dependency edges that reference absent components", async () => {
    const bom = await createCycloneDxBom(projectRoot, timestamp)
    bom.dependencies[0]!.dependsOn.push("pkg:npm/not-present@1.0.0")
    expect(() => assertCycloneDxBom(bom)).toThrow("Unknown CycloneDX dependency target")
  })
})
