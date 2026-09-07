import { createOpencode } from "@opencode-ai/sdk/v2"

export interface ProviderSelection {
  providerID: string
  modelID: string
}

interface CatalogProvider {
  id: string
  name: string
  source: "env" | "config" | "custom" | "api"
  env: string[]
  models: Record<string, { id: string; name: string }>
}

export interface ProviderSummary {
  id: string
  name: string
  source: CatalogProvider["source"]
  modelCount: number
}

export interface SelectedProviderStatus extends ProviderSelection {
  providerAvailable: boolean
  connected: boolean
  modelAvailable: boolean
  requiredEnvironment: string[]
}

export interface ProviderStatus {
  ready: boolean
  opencodeVersion?: string
  selected?: SelectedProviderStatus
  connectedProviders: ProviderSummary[]
  error?: string
}

type Environment = Readonly<Record<string, string | undefined>>

export function readProviderSelection(environment: Environment): ProviderSelection | undefined {
  const providerID = environment.CYRION_PROVIDER_ID?.trim() ?? ""
  const modelID = environment.CYRION_MODEL_ID?.trim() ?? ""
  if (!providerID && !modelID) return undefined
  if (!providerID || !modelID) {
    throw new Error("CYRION_PROVIDER_ID and CYRION_MODEL_ID must be configured together")
  }
  if (!validIdentifier(providerID, 128)) throw new Error("CYRION_PROVIDER_ID contains unsupported characters")
  if (!validIdentifier(modelID, 256)) throw new Error("CYRION_MODEL_ID contains unsupported characters")
  return { providerID, modelID }
}

export function evaluateProviderStatus(
  providers: CatalogProvider[],
  connectedIDs: string[],
  selection: ProviderSelection | undefined,
  opencodeVersion?: string,
): ProviderStatus {
  const connected = new Set(connectedIDs)
  const connectedProviders = providers
    .filter((provider) => connected.has(provider.id))
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      source: provider.source,
      modelCount: Object.keys(provider.models).length,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))

  if (!selection) {
    return { ready: false, ...(opencodeVersion ? { opencodeVersion } : {}), connectedProviders }
  }

  const provider = providers.find((candidate) => candidate.id === selection.providerID)
  const selected: SelectedProviderStatus = {
    ...selection,
    providerAvailable: provider !== undefined,
    connected: connected.has(selection.providerID),
    modelAvailable: provider ? selection.modelID in provider.models : false,
    requiredEnvironment: provider?.env ?? [],
  }
  return {
    ready: selected.providerAvailable && selected.connected && selected.modelAvailable,
    ...(opencodeVersion ? { opencodeVersion } : {}),
    selected,
    connectedProviders,
  }
}

export async function inspectOpenCodeProviders(
  directory: string,
  selection: ProviderSelection | undefined,
): Promise<ProviderStatus> {
  const opencodeVersion = await readOpenCodeVersion()
  let handle: Awaited<ReturnType<typeof createOpencode>> | undefined
  try {
    handle = await createOpencode({ port: 0, timeout: 10_000 })
    const response = await handle.client.provider.list({ directory }, { throwOnError: true })
    if (!response.data) throw new Error("OpenCode returned no provider catalog")
    return evaluateProviderStatus(response.data.all, response.data.connected, selection, opencodeVersion)
  } catch (error) {
    return {
      ready: false,
      ...(opencodeVersion ? { opencodeVersion } : {}),
      ...(selection ? {
        selected: {
          ...selection,
          providerAvailable: false,
          connected: false,
          modelAvailable: false,
          requiredEnvironment: [],
        },
      } : {}),
      connectedProviders: [],
      error: sanitizeProviderDiagnostic(error, Bun.env),
    }
  } finally {
    handle?.server.close()
  }
}

async function readOpenCodeVersion(): Promise<string | undefined> {
  try {
    const process = Bun.spawn(["opencode", "--version"], { stdout: "pipe", stderr: "pipe" })
    const [stdout, exitCode] = await Promise.all([new Response(process.stdout).text(), process.exited])
    return exitCode === 0 ? stdout.trim() || undefined : undefined
  } catch {
    return undefined
  }
}

function validIdentifier(value: string, maxLength: number): boolean {
  return value.length <= maxLength && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
}

export function sanitizeProviderDiagnostic(error: unknown, environment: Environment): string {
  let message = error instanceof Error ? error.message : String(error)
  for (const [name, value] of Object.entries(environment)) {
    if (value && value.length >= 4 && /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)) {
      message = message.replaceAll(value, "[REDACTED]")
    }
  }
  return message
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500)
}
