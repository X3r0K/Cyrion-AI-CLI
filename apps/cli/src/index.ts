#!/usr/bin/env bun
import { existsSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { assertManifest, type EngagementManifest, type EngagementSnapshot } from "@cyrion/contracts"
import { CyrionController, FixtureRootPlanner, ScopedToolGateway, SQLiteEngagementStore } from "@cyrion/controller"
import { LocalEvidenceStore } from "@cyrion/evidence"
import { renderJsonReport, renderMarkdownReport } from "@cyrion/reporting"
import { FixtureAgentRuntime, IsolatedFixtureToolAdapter, type FixtureScenario } from "@cyrion/runtime-opencode"
import { runTui } from "./tui"

export const CLI_VERSION = "0.1.0-alpha.1"

interface StatusSummary {
  status: EngagementSnapshot["status"]
  scenario?: string
  engagementId: string
  agents: number
  tasks: number
  completedTasks: number
  confirmed: number
  rejected: number
  inconclusive: number
  evidence: number
}

const args = process.argv.slice(2)
const command = args[0] ?? "demo"
const projectRoot = resolveProjectRoot()

try {
  if (args.includes("--help") || args.includes("-h") || command === "help") console.log(usage())
  else if (args.includes("--version") || command === "version") console.log(CLI_VERSION)
  else if (command === "demo") await runDemo()
  else if (command === "status") runStatus()
  else if (command === "report") runReport()
  else throw new Error(`Unknown command: ${command}\n\n${usage()}`)
} catch (error) {
  console.error(`cyrion: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

async function runDemo(): Promise<void> {
  const headless = args.includes("--headless") || !process.stdout.isTTY
  const scenarios: FixtureScenario[] = ["known-positive", "clean", "rejected", "incomplete"]
  const scenario = readFlag("--fixture") ?? "known-positive"
  if (!scenarios.includes(scenario as FixtureScenario)) {
    throw new Error(`Unknown fixture scenario: ${scenario}. Choose ${scenarios.join(", ")}.`)
  }
  const manifestPath = scenario === "known-positive"
    ? join(projectRoot, "fixtures/demo/engagement.json")
    : join(projectRoot, "fixtures/scenarios", `${scenario}.json`)
  const manifest = await Bun.file(manifestPath).json()
  assertManifest(manifest)
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
    new FixtureAgentRuntime({ scenario: scenario as FixtureScenario, evidenceStore }),
    new FixtureRootPlanner(),
    join(projectRoot, "agents"),
    { ...(store ? { store } : {}), toolGateway },
  )

  if (headless) {
    controller.events.subscribe((event) => console.log(JSON.stringify(event)))
    const result = await controller.run()
    console.log(JSON.stringify(statusSummary(result, scenario)))
    controller.close()
    if (result.status !== "completed") process.exitCode = 1
    return
  }

  await runTui(controller, evidenceStore)
  controller.close()
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
    ...(scenario ? { scenario } : {}),
    engagementId: snapshot.manifest.id,
    agents: snapshot.agents.length,
    tasks: snapshot.tasks.length,
    completedTasks: snapshot.tasks.filter((task) => task.status === "completed").length,
    confirmed: snapshot.findings.filter((finding) => finding.status === "confirmed").length,
    rejected: snapshot.findings.filter((finding) => finding.status === "rejected").length,
    inconclusive: snapshot.findings.filter((finding) => finding.status === "inconclusive").length,
    evidence: snapshot.evidence.length,
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
    "  cyrion demo [--headless] [--fixture <scenario>] [--state <sqlite-path>] [--artifacts <directory>]",
    "  cyrion status <engagement-id> --state <sqlite-path> [--json]",
    "  cyrion report <engagement-id> --state <sqlite-path> [--format markdown|json]",
    "  cyrion version",
    "",
    "Fixture scenarios: known-positive, clean, rejected, incomplete",
  ].join("\n")
}
