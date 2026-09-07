import { describe, expect, test } from "bun:test"
import { chmod, lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { saveProviderSelection, updateProviderEnvironment } from "../apps/cli/src/provider-config"

describe("provider selection persistence", () => {
  test("updates only Cyrion provider lines and preserves credentials", () => {
    const source = [
      "# local configuration",
      "CYRION_PROVIDER_ID=old-provider",
      "OPENAI_API_KEY=keep-this-value",
      "export CYRION_MODEL_ID=old-model",
      "CYRION_MODEL_ID=duplicate-model",
      "",
    ].join("\n")
    const updated = updateProviderEnvironment(source, { providerID: "opencode", modelID: "test-model" })
    expect(updated).toContain("CYRION_PROVIDER_ID=opencode")
    expect(updated).toContain("CYRION_MODEL_ID=test-model")
    expect(updated).toContain("OPENAI_API_KEY=keep-this-value")
    expect(updated.match(/CYRION_MODEL_ID=/g)).toHaveLength(1)
  })

  test("writes an owner-only environment file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyrion-provider-config-"))
    const path = join(directory, ".env")
    await writeFile(path, "UNRELATED=value\n", { mode: 0o644 })
    await saveProviderSelection(path, { providerID: "openai", modelID: "gpt-test" })
    expect(await readFile(path, "utf8")).toBe([
      "UNRELATED=value",
      "",
      "CYRION_PROVIDER_ID=openai",
      "CYRION_MODEL_ID=gpt-test",
      "",
    ].join("\n"))
    expect((await lstat(path)).mode & 0o777).toBe(0o600)
  })

  test("refuses to replace a symbolic-link environment path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyrion-provider-link-"))
    const target = join(directory, "target")
    const path = join(directory, ".env")
    await writeFile(target, "SAFE=value\n")
    await chmod(target, 0o600)
    await symlink(target, path)
    expect(saveProviderSelection(path, { providerID: "openai", modelID: "gpt-test" }))
      .rejects.toThrow("Refusing to update symbolic link")
    expect(await readFile(target, "utf8")).toBe("SAFE=value\n")
  })
})
