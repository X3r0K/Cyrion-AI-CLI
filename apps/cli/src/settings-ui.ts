import type { ProviderSummary } from "@cyrion/runtime-opencode"
import type { TerminalSettings } from "./provider-config"

export const settingsFields = ["provider", "model", "defaultPlanner", "defaultMode", "defaultFixture", "colorMode"] as const
export type SettingsField = (typeof settingsFields)[number]

export interface SettingsEditorState {
  draft: TerminalSettings
  saved: TerminalSettings
  selectedIndex: number
}

export function createSettingsEditor(settings: TerminalSettings): SettingsEditorState {
  return { draft: { ...settings }, saved: { ...settings }, selectedIndex: 0 }
}

export function selectedSettingsField(state: SettingsEditorState): SettingsField {
  return settingsFields[state.selectedIndex] ?? "provider"
}

export function moveSettingsSelection(state: SettingsEditorState, delta: -1 | 1): SettingsEditorState {
  const selectedIndex = Math.min(settingsFields.length - 1, Math.max(0, state.selectedIndex + delta))
  return { ...state, selectedIndex }
}

export function adjustSetting(
  state: SettingsEditorState,
  providers: ProviderSummary[],
  delta: -1 | 1,
): SettingsEditorState {
  const field = selectedSettingsField(state)
  const draft = { ...state.draft }
  if (field === "provider") {
    const provider = cycle(providers, draft.providerID, delta)
    if (!provider) return state
    draft.providerID = provider.id
    if (!provider.models.some((model) => model.id === draft.modelID)) draft.modelID = provider.models.at(0)?.id ?? ""
  } else if (field === "model") {
    const models = providers.find((provider) => provider.id === draft.providerID)?.models ?? []
    const model = cycle(models, draft.modelID, delta)
    if (!model) return state
    draft.modelID = model.id
  } else if (field === "defaultPlanner") {
    draft.defaultPlanner = cycleValues(["fixture", "opencode"], draft.defaultPlanner, delta)
  } else if (field === "defaultMode") {
    draft.defaultMode = cycleValues(["autonomous", "supervised"], draft.defaultMode, delta)
  } else if (field === "defaultFixture") {
    draft.defaultFixture = cycleValues(["known-positive", "clean", "rejected", "incomplete"], draft.defaultFixture, delta)
  } else {
    draft.colorMode = cycleValues(["auto", "color", "monochrome"], draft.colorMode, delta)
  }
  return { ...state, draft }
}

export function settingsAreDirty(state: SettingsEditorState): boolean {
  return settingsFields.some((field) => valueForField(state.draft, field) !== valueForField(state.saved, field))
}

export function commitSettingsEditor(state: SettingsEditorState): SettingsEditorState {
  return { ...state, saved: { ...state.draft } }
}

export function revertSettingsEditor(state: SettingsEditorState): SettingsEditorState {
  return { ...state, draft: { ...state.saved } }
}

export function valueForField(settings: TerminalSettings, field: SettingsField): string {
  if (field === "provider") return settings.providerID
  if (field === "model") return settings.modelID
  return settings[field]
}

function cycle<T extends { id: string }>(items: T[], currentID: string, delta: -1 | 1): T | undefined {
  if (!items.length) return undefined
  const current = items.findIndex((item) => item.id === currentID)
  const base = current === -1 ? (delta === 1 ? -1 : 0) : current
  return items[(base + delta + items.length) % items.length]
}

function cycleValues<const T extends string>(items: readonly T[], current: T, delta: -1 | 1): T {
  const index = items.indexOf(current)
  return items[(index + delta + items.length) % items.length] ?? current
}
