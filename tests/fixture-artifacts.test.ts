import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FIXTURE_EVIDENCE_VERSION } from "@cyrion/runtime-opencode"
import { prepareFixtureArtifacts } from "../apps/cli/src/fixture-artifacts"

describe("fixture artifact directory", () => {
  test("stamps a new directory with the current fixture version", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrion-artifacts-"))
    try {
      const engagement = join(root, "ENG-0042")
      await prepareFixtureArtifacts(engagement, false)
      expect((await readFile(join(engagement, ".fixture-version"), "utf8")).trim())
        .toBe(FIXTURE_EVIDENCE_VERSION)
      await prepareFixtureArtifacts(engagement, false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("replaces artifacts from an earlier fixture version and says which", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrion-artifacts-"))
    try {
      const engagement = join(root, "ENG-0042")
      await prepareFixtureArtifacts(engagement, false)
      await writeFile(join(engagement, ".fixture-version"), "0\n")
      await writeFile(join(engagement, "E-013.json"), "{}")

      const result = await prepareFixtureArtifacts(engagement, false)
      expect(result.replaced).toBe("0")
      expect(await Bun.file(join(engagement, "E-013.json")).exists()).toBe(false)
      expect((await readFile(join(engagement, ".fixture-version"), "utf8")).trim())
        .toBe(FIXTURE_EVIDENCE_VERSION)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("replaces a directory written before stamps existed", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrion-artifacts-"))
    try {
      const engagement = join(root, "ENG-0042")
      await Bun.write(join(engagement, "E-001.json"), "{}")
      const result = await prepareFixtureArtifacts(engagement, false)
      expect(result.replaced).toBe("an earlier release")
      expect(await Bun.file(join(engagement, "E-001.json")).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("leaves a matching directory alone unless --fresh is given", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrion-artifacts-"))
    try {
      const engagement = join(root, "ENG-0042")
      await prepareFixtureArtifacts(engagement, false)
      await writeFile(join(engagement, "E-001.json"), "{}")

      expect((await prepareFixtureArtifacts(engagement, false)).replaced).toBeUndefined()
      expect(await Bun.file(join(engagement, "E-001.json")).exists()).toBe(true)

      await prepareFixtureArtifacts(engagement, true)
      expect(await Bun.file(join(engagement, "E-001.json")).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
