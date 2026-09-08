import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { FIXTURE_EVIDENCE_VERSION } from "@cyrion/runtime-opencode"

export interface FixtureArtifactResult {
  /** Set when a previous fixture version's artifacts were replaced. */
  replaced?: string
}

/**
 * Prepares the artifact directory for a shipped fixture engagement.
 *
 * Fixture evidence identifiers are deterministic, so artifacts written by an
 * older fixture version collide with new content mid-run. `cyrion demo` only
 * ever runs shipped fixtures, so it owns this directory: a stale version is
 * replaced and reported rather than turned into an error the operator has to
 * work around. `cyrion engage`, which runs an operator's own manifest, never
 * takes this path.
 */
export async function prepareFixtureArtifacts(
  engagementDirectory: string,
  fresh: boolean,
): Promise<FixtureArtifactResult> {
  const stampPath = join(engagementDirectory, ".fixture-version")
  const result: FixtureArtifactResult = {}

  if (fresh) {
    await rm(engagementDirectory, { recursive: true, force: true })
  } else if (existsSync(engagementDirectory)) {
    const stamp = (await readFile(stampPath, "utf8").catch(() => "")).trim()
    if (stamp !== FIXTURE_EVIDENCE_VERSION) {
      await rm(engagementDirectory, { recursive: true, force: true })
      result.replaced = stamp || "an earlier release"
    }
  }

  await mkdir(engagementDirectory, { recursive: true, mode: 0o700 })
  await writeFile(stampPath, `${FIXTURE_EVIDENCE_VERSION}\n`, { mode: 0o600 })
  return result
}
