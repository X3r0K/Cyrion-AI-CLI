import { describe, expect, test } from "bun:test"
import {
  adjustSetting,
  commitSettingsEditor,
  createSettingsEditor,
  moveSettingsSelection,
  revertSettingsEditor,
  settingsAreDirty,
} from "../apps/cli/src/settings-ui"

const providers = [{
  id: "openai",
  name: "OpenAI",
  source: "env" as const,
  modelCount: 2,
  models: [
    { id: "gpt-a", name: "GPT A" },
    { id: "gpt-b", name: "GPT B" },
  ],
}, {
  id: "opencode",
  name: "OpenCode Zen",
  source: "api" as const,
  modelCount: 1,
  models: [{ id: "zen-a", name: "Zen A" }],
}]

describe("terminal settings editor", () => {
  test("cycles providers and selects a valid model for the new provider", () => {
    let state = createSettingsEditor({
      providerID: "openai",
      modelID: "gpt-b",
      defaultMode: "autonomous",
      defaultFixture: "known-positive",
      colorMode: "auto",
    })
    state = adjustSetting(state, providers, 1)
    expect(state.draft.providerID).toBe("opencode")
    expect(state.draft.modelID).toBe("zen-a")
    expect(settingsAreDirty(state)).toBe(true)
  })

  test("edits general defaults and can revert or commit the draft", () => {
    let state = createSettingsEditor({
      providerID: "openai",
      modelID: "gpt-a",
      defaultMode: "autonomous",
      defaultFixture: "known-positive",
      colorMode: "auto",
    })
    state = moveSettingsSelection(state, 1)
    state = moveSettingsSelection(state, 1)
    state = adjustSetting(state, providers, 1)
    expect(state.draft.defaultMode).toBe("supervised")
    expect(revertSettingsEditor(state).draft.defaultMode).toBe("autonomous")
    state = commitSettingsEditor(state)
    expect(settingsAreDirty(state)).toBe(false)
    expect(state.saved.defaultMode).toBe("supervised")
  })
})
