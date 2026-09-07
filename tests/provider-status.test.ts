import { describe, expect, test } from "bun:test"
import {
  evaluateProviderStatus,
  readProviderSelection,
  sanitizeProviderDiagnostic,
} from "@cyrion/runtime-opencode"

const providers = [{
  id: "openai",
  name: "OpenAI",
  source: "env" as const,
  env: ["OPENAI_API_KEY"],
  models: {
    "gpt-test": { id: "gpt-test", name: "GPT Test" },
  },
}]

describe("provider readiness", () => {
  test("requires provider and model IDs together", () => {
    expect(readProviderSelection({})).toBeUndefined()
    expect(() => readProviderSelection({ CYRION_PROVIDER_ID: "openai" })).toThrow(
      "CYRION_PROVIDER_ID and CYRION_MODEL_ID must be configured together",
    )
    expect(readProviderSelection({
      CYRION_PROVIDER_ID: " openai ",
      CYRION_MODEL_ID: " gpt-test ",
    })).toEqual({ providerID: "openai", modelID: "gpt-test" })
  })

  test("reports a selected provider ready only when provider, model, and credential are available", () => {
    const selection = { providerID: "openai", modelID: "gpt-test" }
    const ready = evaluateProviderStatus(providers, ["openai"], selection, "1.18.29")
    expect(ready.ready).toBe(true)
    expect(ready.selected).toEqual(expect.objectContaining({
      providerAvailable: true,
      modelAvailable: true,
      connected: true,
      requiredEnvironment: ["OPENAI_API_KEY"],
    }))

    const missingCredential = evaluateProviderStatus(providers, [], selection)
    expect(missingCredential.ready).toBe(false)
    expect(missingCredential.selected?.connected).toBe(false)
  })

  test("lists connected providers without requiring a Cyrion selection", () => {
    const status = evaluateProviderStatus(providers, ["openai"], undefined)
    expect(status.ready).toBe(false)
    expect(status.connectedProviders).toEqual([{
      id: "openai",
      name: "OpenAI",
      source: "env",
      modelCount: 1,
    }])
  })

  test("removes terminal controls and configured secret values from provider errors", () => {
    const output = sanitizeProviderDiagnostic(
      new Error("\u001b[31mrequest failed for sk-test-secret\u001b[0m\nretry"),
      { OPENAI_API_KEY: "sk-test-secret" },
    )
    expect(output).toBe("request failed for [REDACTED] retry")
  })
})
