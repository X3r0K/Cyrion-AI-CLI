import { randomUUID } from "node:crypto"
import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises"
import { readEnvironmentConfig } from "@cyrion/llm"
import type { ProviderSelection } from "@cyrion/runtime-opencode"

const managedKeys = ["CYRION_PROVIDER_ID", "CYRION_MODEL_ID"] as const
const generalKeys = [
  "CYRION_DEFAULT_PLANNER",
  "CYRION_DEFAULT_WORKERS",
  "CYRION_DEFAULT_MODE",
  "CYRION_DEFAULT_FIXTURE",
  "CYRION_COLOR_MODE",
  "CYRION_LLM_KIND",
  "CYRION_LLM_BASE_URL",
  "CYRION_LLM_MODEL",
  "CYRION_LLM_API_KEY_ENV",
] as const

export type DefaultPlanner = "fixture" | "opencode" | "llm" | "llm-author"
export type DefaultWorkers = "fixture" | "opencode" | "llm"
export type DefaultMode = "autonomous" | "supervised"
export type DefaultFixture = "known-positive" | "clean" | "rejected" | "incomplete"
export type ColorMode = "auto" | "color" | "monochrome"
export type LlmKind = "openai-compatible" | "anthropic" | "ollama"

export interface GeneralSettings {
  defaultPlanner: DefaultPlanner
  defaultWorkers: DefaultWorkers
  defaultMode: DefaultMode
  defaultFixture: DefaultFixture
  colorMode: ColorMode
  /**
   * The direct provider endpoint, editable in Settings so an operator who
   * chooses an LLM runtime can finish configuring it without leaving the
   * terminal. A richer setup still belongs in `cyrion.models.json`.
   */
  llmKind: LlmKind
  llmBaseUrl: string
  llmModel: string
  /** Name of the environment variable holding the key; never the key itself. */
  llmApiKeyEnv: string
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
  llmKind: "openai-compatible",
  llmBaseUrl: "",
  llmModel: "",
  llmApiKeyEnv: "",
}

type Environment = Readonly<Record<string, string | undefined>>

export function readGeneralSettings(environment: Environment): GeneralSettings {
  return {
    defaultPlanner: readChoice(
      environment.CYRION_DEFAULT_PLANNER,
      ["fixture", "opencode", "llm", "llm-author"],
      "CYRION_DEFAULT_PLANNER",
      "fixture",
    ),
    defaultWorkers: readChoice(
      environment.CYRION_DEFAULT_WORKERS,
      ["fixture", "opencode", "llm"],
      "CYRION_DEFAULT_WORKERS",
      "fixture",
    ),
    defaultMode: readChoice(environment.CYRION_DEFAULT_MODE, ["autonomous", "supervised"], "CYRION_DEFAULT_MODE", "autonomous"),
    defaultFixture: readChoice(
      environment.CYRION_DEFAULT_FIXTURE,
      ["known-positive", "clean", "rejected", "incomplete"],
      "CYRION_DEFAULT_FIXTURE",
      "known-positive",
    ),
    colorMode: readChoice(environment.CYRION_COLOR_MODE, ["auto", "color", "monochrome"], "CYRION_COLOR_MODE", "auto"),
    llmKind: readChoice(
      environment.CYRION_LLM_KIND,
      ["openai-compatible", "anthropic", "ollama"],
      "CYRION_LLM_KIND",
      "openai-compatible",
    ),
    // Read leniently and validate on save: a malformed value in the file must
    // still open the page that can correct it.
    llmBaseUrl: readText(environment.CYRION_LLM_BASE_URL),
    llmModel: readText(environment.CYRION_LLM_MODEL),
    llmApiKeyEnv: readText(environment.CYRION_LLM_API_KEY_ENV),
  }
}

/** Fields an operator types rather than cycles through. */
export const textSettingsFields = ["llmBaseUrl", "llmModel", "llmApiKeyEnv"] as const
export type TextSettingsField = (typeof textSettingsFields)[number]

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
    CYRION_LLM_KIND: settings.llmBaseUrl ? settings.llmKind : "",
    CYRION_LLM_BASE_URL: settings.llmBaseUrl,
    CYRION_LLM_MODEL: settings.llmModel,
    CYRION_LLM_API_KEY_ENV: settings.llmApiKeyEnv,
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
    // An empty value means "not configured": drop the line rather than leaving
    // a blank assignment behind for the next reader to puzzle over.
    if (values[key]) output.push(`${key}=${values[key]}`)
  }
  const missing = keys.filter((key) => !seen.has(key) && values[key])
  if (output.at(-1) === "") output.pop()
  if (missing.length && output.length && output.at(-1) !== "") output.push("")
  for (const key of missing) output.push(`${key}=${values[key]}`)
  return `${output.join("\n")}\n`
}

export async function saveProviderSelection(path: string, selection: ProviderSelection): Promise<void> {
  await saveEnvironment(path, (source) => updateProviderEnvironment(source, selection))
}

export async function saveGeneralSettings(path: string, settings: TerminalSettings): Promise<void> {
  const error = generalSettingsError(settings)
  if (error) throw new Error(error)
  await saveEnvironment(path, (source) => updateGeneralEnvironment(source, settings))
}

/**
 * Refuses a profile the runtime would later reject.
 *
 * The endpoint is checked with the same validator the provider layer uses, so
 * Settings cannot save a configuration that only fails at launch — which is the
 * trap this page exists to close.
 */
export function generalSettingsError(settings: TerminalSettings): string | undefined {
  if (Boolean(settings.providerID) !== Boolean(settings.modelID)) {
    return "Choose both an LLM provider and model, or leave both unconfigured"
  }
  if ((settings.defaultPlanner === "opencode" || settings.defaultWorkers === "opencode") && !settings.providerID) {
    return "OpenCode planning or workers require an LLM provider and model"
  }
  if (Boolean(settings.llmBaseUrl) !== Boolean(settings.llmModel)) {
    return "Set both the LLM endpoint and the model it serves, or leave both empty"
  }
  if (settings.llmApiKeyEnv && !/^[A-Z][A-Z0-9_]{0,63}$/.test(settings.llmApiKeyEnv)) {
    return "The API key variable must be an environment variable name, such as OPENAI_API_KEY"
  }
  if (settings.llmBaseUrl) {
    try {
      readEnvironmentConfig({
        CYRION_LLM_BASE_URL: settings.llmBaseUrl,
        CYRION_LLM_MODEL: settings.llmModel,
        CYRION_LLM_KIND: settings.llmKind,
        ...(settings.llmApiKeyEnv ? { CYRION_LLM_API_KEY_ENV: settings.llmApiKeyEnv } : {}),
      })
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }
  }
  const usesLlm = settings.defaultPlanner === "llm"
    || settings.defaultPlanner === "llm-author"
    || settings.defaultWorkers === "llm"
  if (usesLlm && !settings.llmBaseUrl) {
    return "LLM planning or workers need an endpoint and a model; set them here or in cyrion.models.json"
  }
  return undefined
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

/** Free text from the environment: bounded and stripped of control characters. */
function readText(value: string | undefined): string {
  return (value ?? "").replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim().slice(0, 512)
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
