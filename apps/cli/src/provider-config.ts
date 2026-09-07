import { randomUUID } from "node:crypto"
import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises"
import type { ProviderSelection } from "@cyrion/runtime-opencode"

const managedKeys = ["CYRION_PROVIDER_ID", "CYRION_MODEL_ID"] as const
const generalKeys = [
  "CYRION_DEFAULT_PLANNER",
  "CYRION_DEFAULT_WORKERS",
  "CYRION_DEFAULT_MODE",
  "CYRION_DEFAULT_FIXTURE",
  "CYRION_COLOR_MODE",
] as const

export type DefaultPlanner = "fixture" | "opencode"
export type DefaultWorkers = "fixture" | "opencode"
export type DefaultMode = "autonomous" | "supervised"
export type DefaultFixture = "known-positive" | "clean" | "rejected" | "incomplete"
export type ColorMode = "auto" | "color" | "monochrome"

export interface GeneralSettings {
  defaultPlanner: DefaultPlanner
  defaultWorkers: DefaultWorkers
  defaultMode: DefaultMode
  defaultFixture: DefaultFixture
  colorMode: ColorMode
}

export interface TerminalSettings extends GeneralSettings {
  providerID: string
  modelID: string
}

export const defaultGeneralSettings: GeneralSettings = {
  defaultPlanner: "fixture",
  defaultWorkers: "fixture",
  defaultMode: "autonomous",
  defaultFixture: "known-positive",
  colorMode: "auto",
}

type Environment = Readonly<Record<string, string | undefined>>

export function readGeneralSettings(environment: Environment): GeneralSettings {
  return {
    defaultPlanner: readChoice(environment.CYRION_DEFAULT_PLANNER, ["fixture", "opencode"], "CYRION_DEFAULT_PLANNER", "fixture"),
    defaultWorkers: readChoice(environment.CYRION_DEFAULT_WORKERS, ["fixture", "opencode"], "CYRION_DEFAULT_WORKERS", "fixture"),
    defaultMode: readChoice(environment.CYRION_DEFAULT_MODE, ["autonomous", "supervised"], "CYRION_DEFAULT_MODE", "autonomous"),
    defaultFixture: readChoice(
      environment.CYRION_DEFAULT_FIXTURE,
      ["known-positive", "clean", "rejected", "incomplete"],
      "CYRION_DEFAULT_FIXTURE",
      "known-positive",
    ),
    colorMode: readChoice(environment.CYRION_COLOR_MODE, ["auto", "color", "monochrome"], "CYRION_COLOR_MODE", "auto"),
  }
}

export function updateProviderEnvironment(source: string, selection: ProviderSelection): string {
  return updateEnvironment(source, managedKeys, {
    CYRION_PROVIDER_ID: selection.providerID,
    CYRION_MODEL_ID: selection.modelID,
  })
}

export function updateGeneralEnvironment(source: string, settings: TerminalSettings): string {
  return updateEnvironment(source, [...managedKeys, ...generalKeys], {
    CYRION_PROVIDER_ID: settings.providerID,
    CYRION_MODEL_ID: settings.modelID,
    CYRION_DEFAULT_PLANNER: settings.defaultPlanner,
    CYRION_DEFAULT_WORKERS: settings.defaultWorkers,
    CYRION_DEFAULT_MODE: settings.defaultMode,
    CYRION_DEFAULT_FIXTURE: settings.defaultFixture,
    CYRION_COLOR_MODE: settings.colorMode,
  })
}

function updateEnvironment<K extends string>(source: string, keys: readonly K[], values: Record<K, string>): string {
  const seen = new Set<string>()
  const output: string[] = []
  for (const line of source.replaceAll("\r\n", "\n").split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/)
    const key = match?.[1] as K | undefined
    if (!key || !keys.includes(key)) {
      output.push(line)
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    output.push(`${key}=${values[key]}`)
  }
  if (output.at(-1) === "") output.pop()
  if (keys.some((key) => !seen.has(key)) && output.length && output.at(-1) !== "") output.push("")
  for (const key of keys) {
    if (!seen.has(key)) output.push(`${key}=${values[key]}`)
  }
  return `${output.join("\n")}\n`
}

export async function saveProviderSelection(path: string, selection: ProviderSelection): Promise<void> {
  await saveEnvironment(path, (source) => updateProviderEnvironment(source, selection))
}

export async function saveGeneralSettings(path: string, settings: TerminalSettings): Promise<void> {
  if (Boolean(settings.providerID) !== Boolean(settings.modelID)) {
    throw new Error("Choose both an LLM provider and model, or leave both unconfigured")
  }
  if ((settings.defaultPlanner === "opencode" || settings.defaultWorkers === "opencode") && !settings.providerID) {
    throw new Error("OpenCode planning or workers require an LLM provider and model")
  }
  await saveEnvironment(path, (source) => updateGeneralEnvironment(source, settings))
}

async function saveEnvironment(path: string, update: (source: string) => string): Promise<void> {
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
    await writeFile(temporaryPath, update(source), { mode: 0o600, flag: "wx" })
    await rename(temporaryPath, path)
    await chmod(path, 0o600)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function readChoice<const T extends string>(
  value: string | undefined,
  choices: readonly T[],
  name: string,
  fallback: T,
): T {
  const normalized = value?.trim()
  if (!normalized) return fallback
  if (choices.includes(normalized as T)) return normalized as T
  throw new Error(`${name} must be one of: ${choices.join(", ")}`)
}
