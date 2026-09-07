#!/usr/bin/env bun
import { existsSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { assertManifest, type EngagementManifest, type EngagementSnapshot } from "@cyrion/contracts"
import { CyrionController, FixtureRootPlanner, ScopedToolGateway, SQLiteEngagementStore } from "@cyrion/controller"
import { LocalEvidenceStore } from "@cyrion/evidence"
import { renderJsonReport, renderMarkdownReport } from "@cyrion/reporting"
import {
  FixtureAgentRuntime,
  IsolatedFixtureToolAdapter,
  inspectOpenCodeProviders,
  readProviderSelection,
  type FixtureScenario,
  type ProviderStatus,
} from "@cyrion/runtime-opencode"
import { runTui } from "./tui"
import { readGeneralSettings, saveProviderSelection } from "./provider-config"

export const CLI_VERSION = "0.1.0-alpha.1"

interface StatusSummary {
  status: EngagementSnapshot["status"]
  mode: EngagementManifest["mode"]
  scenario?: string
  engagementId: string
  agents: number
  tasks: number
  completedTasks: number
  confirmed: number
  rejected: number
  inconclusive: number
  evidence: number
  approval?: "pending" | "approved"
}

const args = process.argv.slice(2)
const command = args[0] ?? "demo"
const projectRoot = resolveProjectRoot()

try {
  if (args.includes("--help") || args.includes("-h") || command === "help") console.log(usage())
  else if (args.includes("--version") || command === "version") console.log(CLI_VERSION)
  else if (command === "providers") await runProviders()
  else if (command === "demo") await runDemo()
  else if (command === "status") runStatus()
  else if (command === "report") runReport()
  else throw new Error(`Unknown command: ${command}\n\n${usage()}`)
} catch (error) {
  console.error(`cyrion: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

async function runDemo(): Promise<void> {
  const settings = readGeneralSettings(Bun.env)
  const provider = readProviderSelection(Bun.env)
  const headless = args.includes("--headless") || !process.stdout.isTTY
  const scenarios: FixtureScenario[] = ["known-positive", "clean", "rejected", "incomplete"]
  const scenario = readFlag("--fixture") ?? settings.defaultFixture
  if (!scenarios.includes(scenario as FixtureScenario)) {
    throw new Error(`Unknown fixture scenario: ${scenario}. Choose ${scenarios.join(", ")}.`)
  }
  const manifestPath = scenario === "known-positive"
    ? join(projectRoot, "fixtures/demo/engagement.json")
    : join(projectRoot, "fixtures/scenarios", `${scenario}.json`)
  const manifest = await Bun.file(manifestPath).json()
  assertManifest(manifest)
  const mode = readFlag("--mode") ?? settings.defaultMode
  if (mode && mode !== "autonomous" && mode !== "supervised") {
    throw new Error("--mode must be autonomous or supervised")
  }
  manifest.mode = mode === "supervised" ? "supervised" : "autonomous"
  const autoApprove = args.includes("--approve-all")
  if (headless && manifest.mode === "supervised" && !autoApprove) {
    throw new Error("Headless supervised mode requires --approve-all; interactive approval needs a TTY")
  }
  const stateArgument = readFlag("--state")
  const artifactArgument = readFlag("--artifacts") ?? ".cyrion/artifacts"
  const store = stateArgument
    ? new SQLiteEngagementStore(absolute(stateArgument), manifest.id)
    : undefined
  const evidenceStore = new LocalEvidenceStore(absolute(artifactArgument))
  const fixtureAdapter = new IsolatedFixtureToolAdapter(
    join(projectRoot, "workers/fixture-worker.ts"),
    manifest.scope.targets,
  )
  const toolGateway = new ScopedToolGateway(manifest, {
    "fixture.read": fixtureAdapter,
    "fixture.compare": fixtureAdapter,
  })
  const controller = new CyrionController(
    manifest as EngagementManifest,
    new FixtureAgentRuntime({ scenario: scenario as FixtureScenario }),
    new FixtureRootPlanner(),
    join(projectRoot, "agents"),
    { ...(store ? { store } : {}), toolGateway, autoApprove, evidenceStore },
  )

  if (headless) {
    controller.events.subscribe((event) => console.log(JSON.stringify(event)))
    const result = await controller.run()
    console.log(JSON.stringify(statusSummary(result, scenario)))
    controller.close()
    if (result.status !== "completed") process.exitCode = 1
    return
  }

  await runTui(controller, evidenceStore, {
    mode: "fixture",
    ...(provider ? { provider: `${provider.providerID}/${provider.modelID} (CONFIGURED)` } : {}),
  })
  controller.close()
}

async function runProviders(): Promise<void> {
  if (args.includes("--select") && args.includes("--json")) {
    throw new Error("--select cannot be combined with --json")
  }
  const selection = readProviderSelection(Bun.env)
  const status = await inspectOpenCodeProviders(process.cwd(), selection)
  if (args.includes("--select")) {
    await selectProvider(status)
    return
  }
  if (args.includes("--json")) console.log(JSON.stringify(status))
  else console.log(formatProviderStatus(status))
  if (args.includes("--check") && !status.ready) process.exitCode = 1
}

async function selectProvider(status: ProviderStatus): Promise<void> {
  if (status.error) throw new Error(`Provider discovery failed: ${status.error}`)
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Provider selection requires an interactive terminal")
  }
  if (!status.connectedProviders.length) {
    throw new Error("No connected providers. Run `opencode auth login`, then retry.")
  }

  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const provider = await promptChoice(
      terminal,
      "provider",
      status.connectedProviders,
      status.selected?.providerID,
      (item) => `${item.name} / ${item.id} / ${item.modelCount} models`,
    )
    if (!provider.models.length) throw new Error(`Connected provider ${provider.id} has no available models`)
    const model = await promptChoice(
      terminal,
      "model",
      provider.models,
      status.selected?.providerID === provider.id ? status.selected.modelID : undefined,
      (item) => item.name === item.id ? item.id : `${item.name} / ${item.id}`,
    )
    const path = join(process.cwd(), ".env")
    await saveProviderSelection(path, { providerID: provider.id, modelID: model.id })
    console.log(`\nSelected ${provider.id}/${model.id}`)
    console.log(`Saved provider/model selection to ${path}`)
    console.log("Credential remains managed by OpenCode or your environment.")
  } finally {
    terminal.close()
  }
}

async function promptChoice<T extends { id: string }>(
  terminal: ReturnType<typeof createInterface>,
  label: string,
  choices: T[],
  selectedID: string | undefined,
  format: (choice: T) => string,
): Promise<T> {
  const defaultIndex = Math.max(0, choices.findIndex((choice) => choice.id === selectedID))
  console.log(`\nConnected ${label}s:`)
  for (const [index, choice] of choices.entries()) {
    const marker = index === defaultIndex ? "◆" : "◇"
    console.log(`  ${marker} [${index + 1}] ${format(choice)}`)
  }
  while (true) {
    const answer = (await terminal.question(`Choose ${label} [${defaultIndex + 1}]: `)).trim()
    const index = answer ? Number(answer) - 1 : defaultIndex
    const choice = Number.isInteger(index) ? choices[index] : undefined
    if (choice) return choice
    console.log(`Enter a number from 1 to ${choices.length}.`)
  }
}

function formatProviderStatus(status: ProviderStatus): string {
  const selected = status.selected
  const connected = status.connectedProviders.length
    ? status.connectedProviders.map((provider) => `${provider.id} (${provider.modelCount} models)`).join(", ")
    : "none"
  return [
    "CYRION/AI  PROVIDER READINESS",
    `OpenCode     ${status.opencodeVersion ?? "NOT FOUND"}`,
    `selection    ${selected ? `${selected.providerID}/${selected.modelID}` : "NOT CONFIGURED"}`,
    `connected    ${connected}`,
    `provider     ${selected ? readinessLabel(selected.providerAvailable) : "-"}`,
    `model        ${selected ? readinessLabel(selected.modelAvailable) : "-"}`,
    `credential   ${selected ? readinessLabel(selected.connected) : "-"}`,
    `ready        ${status.ready ? "YES" : "NO"}`,
    ...(selected?.requiredEnvironment.length
      ? [`accepted env ${selected.requiredEnvironment.join(", ")}`]
      : []),
    ...(status.error ? [`error        ${status.error}`, "next         run `opencode upgrade`, then retry"] : []),
    ...(!selected ? ["next         set CYRION_PROVIDER_ID and CYRION_MODEL_ID in .env"] : []),
  ].join("\n")
}

function readinessLabel(value: boolean): string {
  return value ? "OK" : "MISSING"
}

function runStatus(): void {
  const { snapshot, close } = readDurableSnapshot()
  const json = args.includes("--json")
  if (json) {
    console.log(JSON.stringify(statusSummary(snapshot)))
  } else {
    const summary = statusSummary(snapshot)
    console.log([
      `CYRION/AI  ${terminalSafe(summary.engagementId)}`,
      `status       ${summary.status.toUpperCase()}`,
      `mode         ${summary.mode.toUpperCase()}`,
      ...(summary.approval ? [`approval     ${summary.approval.toUpperCase()}`] : []),
      `target       ${terminalSafe(snapshot.manifest.scope.targets.join(", "))}`,
      `tasks        ${summary.completedTasks}/${summary.tasks} completed`,
      `findings     ${summary.confirmed} confirmed / ${summary.rejected} rejected / ${summary.inconclusive} inconclusive`,
      `evidence     ${summary.evidence} artifacts`,
    ].join("\n"))
  }
  close()
}

function runReport(): void {
  const format = readFlag("--format") ?? "markdown"
  if (format !== "markdown" && format !== "json") {
    throw new Error("--format must be markdown or json")
  }
  const { snapshot, close } = readDurableSnapshot()
  process.stdout.write(format === "json" ? renderJsonReport(snapshot) : renderMarkdownReport(snapshot))
  close()
}

function readDurableSnapshot(): { snapshot: EngagementSnapshot; close: () => void } {
  const engagementId = args[1]
  if (!engagementId || engagementId.startsWith("-")) {
    throw new Error(`${command} requires an engagement ID`)
  }
  const stateArgument = readFlag("--state")
  if (!stateArgument) throw new Error(`${command} requires --state <sqlite-path>`)
  const databasePath = absolute(stateArgument)
  if (!existsSync(databasePath)) throw new Error(`State database not found: ${databasePath}`)
  const store = new SQLiteEngagementStore(databasePath, engagementId)
  const snapshot = store.loadSnapshot()
  if (!snapshot) {
    store.close()
    throw new Error(`Engagement not found in state database: ${engagementId}`)
  }
  return { snapshot, close: () => store.close() }
}

function statusSummary(snapshot: EngagementSnapshot, scenario?: string): StatusSummary {
  return {
    status: snapshot.status,
    mode: snapshot.manifest.mode,
    ...(scenario ? { scenario } : {}),
    engagementId: snapshot.manifest.id,
    agents: snapshot.agents.length,
    tasks: snapshot.tasks.length,
    completedTasks: snapshot.tasks.filter((task) => task.status === "completed").length,
    confirmed: snapshot.findings.filter((finding) => finding.status === "confirmed").length,
    rejected: snapshot.findings.filter((finding) => finding.status === "rejected").length,
    inconclusive: snapshot.findings.filter((finding) => finding.status === "inconclusive").length,
    evidence: snapshot.evidence.length,
    ...(snapshot.pendingApproval ? { approval: snapshot.pendingApproval.status } : {}),
  }
}

function readFlag(name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

function terminalSafe(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
}

function resolveProjectRoot(): string {
  const candidates = [
    join(import.meta.dir, "../../.."),
    join(import.meta.dir, ".."),
  ]
  const root = candidates.find((candidate) =>
    existsSync(join(candidate, "agents")) && existsSync(join(candidate, "fixtures"))
  )
  if (!root) throw new Error("Cyrion runtime assets were not found beside the CLI")
  return root
}

function usage(): string {
  return [
    `CYRION/AI Community ${CLI_VERSION}`,
    "",
    "Usage:",
    "  cyrion demo [--headless] [--fixture <scenario>] [--mode autonomous|supervised] [--approve-all]",
    "              [--state <sqlite-path>] [--artifacts <directory>]",
    "  cyrion providers [--json] [--check] [--select]",
    "  cyrion status <engagement-id> --state <sqlite-path> [--json]",
    "  cyrion report <engagement-id> --state <sqlite-path> [--format markdown|json]",
    "  cyrion version",
    "",
    "Fixture scenarios: known-positive, clean, rejected, incomplete",
    "Headless supervised runs require --approve-all.",
  ].join("\n")
}
