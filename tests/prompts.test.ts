import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const projectRoot = join(import.meta.dir, "..")

describe("public prompt boundary", () => {
  test("keeps stable role prompts concise and excludes provider credentials", async () => {
    for (const role of ["root", "recon", "web", "api", "validator", "reporter"]) {
      const prompt = await Bun.file(join(projectRoot, "agents", role, "system.md")).text()
      expect(prompt.length).toBeLessThan(1600)
      expect(prompt).not.toMatch(/API[_ -]?KEY|Bearer\s+[A-Za-z0-9]/i)
      expect(prompt).not.toMatch(/BEGIN (RSA|OPENSSH) PRIVATE KEY/i)
    }
  })
})
