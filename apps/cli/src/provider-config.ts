import { randomUUID } from "node:crypto"
import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises"
import type { ProviderSelection } from "@cyrion/runtime-opencode"

const managedKeys = ["CYRION_PROVIDER_ID", "CYRION_MODEL_ID"] as const

export function updateProviderEnvironment(source: string, selection: ProviderSelection): string {
  const values: Record<(typeof managedKeys)[number], string> = {
    CYRION_PROVIDER_ID: selection.providerID,
    CYRION_MODEL_ID: selection.modelID,
  }
  const seen = new Set<string>()
  const output: string[] = []
  for (const line of source.replaceAll("\r\n", "\n").split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?(CYRION_PROVIDER_ID|CYRION_MODEL_ID)\s*=/)
    const key = match?.[1] as (typeof managedKeys)[number] | undefined
    if (!key) {
      output.push(line)
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    output.push(`${key}=${values[key]}`)
  }
  if (output.at(-1) === "") output.pop()
  if (managedKeys.some((key) => !seen.has(key)) && output.length && output.at(-1) !== "") output.push("")
  for (const key of managedKeys) {
    if (!seen.has(key)) output.push(`${key}=${values[key]}`)
  }
  return `${output.join("\n")}\n`
}

export async function saveProviderSelection(path: string, selection: ProviderSelection): Promise<void> {
  let source = ""
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) throw new Error(`Refusing to update symbolic link: ${path}`)
    if (!metadata.isFile()) throw new Error(`Provider environment path is not a file: ${path}`)
    source = await readFile(path, "utf8")
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }

  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporaryPath, updateProviderEnvironment(source, selection), { mode: 0o600, flag: "wx" })
    await rename(temporaryPath, path)
    await chmod(path, 0o600)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}
