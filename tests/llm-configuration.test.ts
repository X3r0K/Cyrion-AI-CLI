import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  formatSettings,
  formatSettingsInspector,
  formatSettingsSidebar,
  type SettingsDisplay,
} from "../apps/cli/src/format"
import {
  defaultGeneralSettings,
  generalSettingsError,
  saveGeneralSettings,
  updateGeneralEnvironment,
  type TerminalSettings,
} from "../apps/cli/src/provider-config"
import {
  adjustSetting,
  createSettingsEditor,
  editSetting,
  isTextSettingsField,
  llmEndpointConfigured,
  moveSettingsSelection,
  selectedSettingsField,
} from "../apps/cli/src/settings-ui"

const projectRoot = join(import.meta.dir, "..")
const cli = join(projectRoot, "apps/cli/src/index.ts")

function settings(overrides: Partial<TerminalSettings> = {}): TerminalSettings {
  return { ...defaultGeneralSettings, providerID: "", modelID: "", ...overrides }
}

const display: SettingsDisplay = { environmentPath: "/tmp/.env", providers: [], discovery: "idle" }

function plainText(value: { chunks: Array<{ text: string }> }): string {
  return value.chunks.map((chunk) => chunk.text).join("")
}

/** Pane text wraps to its width, so assertions compare the collapsed line. */
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

describe("configuring an LLM from the terminal", () => {
  test("edits the endpoint as typed text, bounded and stripped of control characters", () => {
    let state = createSettingsEditor(settings())
    while (selectedSettingsField(state) !== "llmBaseUrl") state = moveSettingsSelection(state, 1)
    expect(isTextSettingsField(selectedSettingsField(state))).toBe(true)

    // A typed field never cycles: the caller opens the editor instead.
    expect(adjustSetting(state, [], 1)).toBe(state)

    state = editSetting(state, "llmBaseUrl", "  http://127.0.0.1:11434  ")
    expect(state.draft.llmBaseUrl).toBe("http://127.0.0.1:11434")
    expect(llmEndpointConfigured(state.draft)).toBe(false)
    state = editSetting(state, "llmModel", "qwen3:14b")
    expect(llmEndpointConfigured(state.draft)).toBe(true)
    expect(editSetting(state, "llmModel", "x".repeat(600)).draft.llmModel).toHaveLength(512)
  })

  test("cycles the endpoint kind through the shapes the provider layer implements", () => {
    let state = createSettingsEditor(settings())
    while (selectedSettingsField(state) !== "llmKind") state = moveSettingsSelection(state, 1)
    state = adjustSetting(state, [], 1)
    expect(state.draft.llmKind).toBe("anthropic")
    state = adjustSetting(state, [], 1)
    expect(state.draft.llmKind).toBe("ollama")
    state = adjustSetting(state, [], 1)
    expect(state.draft.llmKind).toBe("openai-compatible")
  })

  test("refuses a profile the runtime would reject at launch", () => {
    expect(generalSettingsError(settings({ llmBaseUrl: "http://127.0.0.1:11434" })))
      .toContain("Set both the LLM endpoint and the model")
    // The same validator the provider layer uses, so Settings cannot save a
    // configuration that only fails on the next launch.
    expect(generalSettingsError(settings({ llmBaseUrl: "http://models.example.test", llmModel: "m" })))
      .toContain("cleartext")
    expect(generalSettingsError(settings({ llmBaseUrl: "not-a-url", llmModel: "m" })))
      .toContain("not a valid URL")
    expect(generalSettingsError(settings({ llmBaseUrl: "http://127.0.0.1:11434", llmModel: "m", llmApiKeyEnv: "my key" })))
      .toContain("environment variable name")
    expect(generalSettingsError(settings({ defaultPlanner: "llm" })))
      .toContain("LLM planning or workers need an endpoint and a model")
    expect(generalSettingsError(settings({
      defaultPlanner: "llm",
      defaultWorkers: "llm",
      llmBaseUrl: "http://127.0.0.1:11434",
      llmModel: "qwen3:14b",
    }))).toBeUndefined()
  })

  test("writes the endpoint to the owner-only file and removes it when cleared", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyrion-llm-config-"))
    const path = join(directory, ".env")
    try {
      await saveGeneralSettings(path, settings({
        defaultPlanner: "llm",
        llmBaseUrl: "http://127.0.0.1:11434",
        llmModel: "qwen3:14b",
        llmApiKeyEnv: "OPENAI_API_KEY",
        llmKind: "ollama",
      }))
      const written = await readFile(path, "utf8")
      expect(written).toContain("CYRION_LLM_BASE_URL=http://127.0.0.1:11434")
      expect(written).toContain("CYRION_LLM_MODEL=qwen3:14b")
      expect(written).toContain("CYRION_LLM_KIND=ollama")
      // The variable name is stored; the key itself never is.
      expect(written).toContain("CYRION_LLM_API_KEY_ENV=OPENAI_API_KEY")
      expect(written).not.toContain("sk-")

      await saveGeneralSettings(path, settings())
      const cleared = await readFile(path, "utf8")
      expect(cleared).not.toContain("CYRION_LLM_BASE_URL")
      expect(cleared).not.toContain("CYRION_LLM_MODEL=")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("keeps unrelated variables and never writes an empty assignment", () => {
    const updated = updateGeneralEnvironment("OPENAI_API_KEY=keep-private\n", settings({ colorMode: "color" }))
    expect(updated).toContain("OPENAI_API_KEY=keep-private")
    expect(updated).toContain("CYRION_COLOR_MODE=color")
    expect(updated).not.toMatch(/^CYRION_[A-Z_]+=$/m)
  })

  test("shows the endpoint on the settings page and its readiness in the inspector", () => {
    let state = createSettingsEditor(settings({ llmBaseUrl: "http://127.0.0.1:11434", llmModel: "qwen3:14b" }))
    const page = plainText(formatSettings(state, display, 80))
    expect(page).toContain("LLM endpoint URL")
    expect(page).toContain("http://127.0.0.1:11434")

    while (selectedSettingsField(state) !== "llmBaseUrl") state = moveSettingsSelection(state, 1)
    expect(plainText(formatSettingsInspector(state, display, 44))).toContain("READY")
    const incomplete = createSettingsEditor(settings())
    let atUrl = incomplete
    while (selectedSettingsField(atUrl) !== "llmBaseUrl") atUrl = moveSettingsSelection(atUrl, 1)
    const inspector = plainText(formatSettingsInspector(atUrl, display, 44))
    expect(inspector).toContain("INCOMPLETE")
    expect(inspector).toContain("NOT CONFIGURED")
  })

  test("keeps the reason a runtime was downgraded visible where it can be fixed", () => {
    const sidebar = plainText(formatSettingsSidebar(
      createSettingsEditor(settings()),
      display,
      {
        mode: "fixture",
        planner: "fixture",
        workers: "fixture",
        notice: "LLM planning is off because no model endpoint is configured.",
      },
      44,
    ))
    expect(sidebar).toContain("RUNTIME NOTICE")
    expect(collapse(sidebar)).toContain("no model endpoint is configured")
  })
})

describe("starting without a model", () => {
  /** A clean environment: no repository `.env`, no project model file. */
  async function runCli(extraEnv: Record<string, string>, extraArgs: string[]) {
    const directory = await mkdtemp(join(tmpdir(), "cyrion-launch-"))
    try {
      const run = Bun.spawnSync({
        cmd: ["bun", "run", cli, "demo", "--headless", "--fixture", "clean",
          "--artifacts", join(directory, "artifacts"), ...extraArgs],
        cwd: directory,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? directory, ...extraEnv },
      })
      return {
        exitCode: run.exitCode,
        stdout: new TextDecoder().decode(run.stdout),
        stderr: new TextDecoder().decode(run.stderr),
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  test("runs with the deterministic runtime when a saved default cannot be satisfied", async () => {
    const run = await runCli({ CYRION_DEFAULT_PLANNER: "llm", CYRION_DEFAULT_WORKERS: "llm" }, [])
    expect(run.stderr).toContain("no model endpoint is configured")
    expect(run.stderr).toContain("configure it in Settings")
    expect(run.exitCode).toBe(0)

    // The summary states what actually ran, rather than what was configured.
    const summary = JSON.parse(run.stdout.trim().split("\n").at(-1)!) as { planner: string; workers: string; status: string }
    expect(summary.status).toBe("completed")
    expect(summary.planner).toBe("fixture")
    expect(summary.workers).toBe("fixture")
  }, 60_000)

  test("still refuses a runtime the operator named on the command line", async () => {
    const run = await runCli({}, ["--planner", "llm"])
    expect(run.stderr).toContain("The LLM runtime is not ready")
    expect(run.stderr).toContain("CYRION_LLM_BASE_URL")
    expect(run.exitCode).toBe(1)
  }, 60_000)

  test("reports an unconfigured endpoint as a state, and fails only under --check", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyrion-models-"))
    try {
      const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? directory }
      const status = Bun.spawnSync({ cmd: ["bun", "run", cli, "models"], cwd: directory, env })
      expect(new TextDecoder().decode(status.stdout)).toContain("NOT CONFIGURED")
      expect(status.exitCode).toBe(0)

      const checked = Bun.spawnSync({ cmd: ["bun", "run", cli, "models", "--check"], cwd: directory, env })
      expect(checked.exitCode).toBe(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("provider review of a real engagement", () => {
  async function engage(extraEnv: Record<string, string>, extraArgs: string[]) {
    const directory = await mkdtemp(join(tmpdir(), "cyrion-engage-llm-"))
    try {
      const manifestPath = join(directory, "engagement.json")
      await Bun.write(manifestPath, JSON.stringify({
        id: "ENG-REVIEW",
        name: "Review fixture",
        objective: "Check that provider review is optional, not required.",
        profile: "web-api",
        mode: "autonomous",
        // A target nothing listens on: the run must reach its planner either way.
        scope: { targets: ["http://127.0.0.1:1/"], excluded: [], capabilities: ["http.probe"] },
        budgets: {
          maxConcurrentAgents: 1, maxAgents: 6, maxDepth: 3, maxTasks: 6,
          maxDurationMs: 30_000, maxTokens: 1_000, maxCostUsd: 1,
        },
      }))
      const run = Bun.spawnSync({
        cmd: ["bun", "run", join(projectRoot, "apps/cli/src/index.ts"), "engage",
          "--scope", manifestPath, "--headless", "--sandbox", "local",
          "--artifacts", join(directory, "artifacts"), ...extraArgs],
        cwd: directory,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? directory, ...extraEnv },
      })
      return {
        exitCode: run.exitCode,
        stdout: new TextDecoder().decode(run.stdout),
        stderr: new TextDecoder().decode(run.stderr),
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  test("an unreachable saved default degrades to the deterministic runtime, not to a stopped scan", async () => {
    const run = await engage({ CYRION_DEFAULT_PLANNER: "llm", CYRION_DEFAULT_WORKERS: "llm" }, [])
    expect(run.stderr).toContain("Provider review is off")
    expect(run.stderr).toContain("The engagement still runs")

    // The scan itself still ran, and the summary states what actually planned it.
    const summary = JSON.parse(run.stdout.trim().split("\n").at(-1)!) as { planner: string; workers: string }
    expect(summary.planner).toBe("assessment")
    expect(summary.workers).toBe("capability")
  }, 90_000)

  test("a review mode named on the command line is refused rather than downgraded", async () => {
    const run = await engage({}, ["--planner", "llm"])
    expect(run.stderr).toContain("The LLM runtime is not ready")
    expect(run.exitCode).toBe(1)
  }, 90_000)

  test("rejects a review mode that belongs to the fixture demo", async () => {
    const run = await engage({}, ["--planner", "fixture-only"])
    expect(run.stderr).toContain("--planner must be assessment, llm, or llm-author")
    expect(run.exitCode).toBe(1)
  }, 90_000)
})
