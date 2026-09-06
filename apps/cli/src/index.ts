#!/usr/bin/env bun
import { isAbsolute, join, resolve } from "node:path"
import { assertManifest, type EngagementManifest } from "@cyrion/contracts"
import { CyrionController, FixtureRootPlanner, ScopedToolGateway, SQLiteEngagementStore } from "@cyrion/controller"
import { LocalEvidenceStore } from "@cyrion/evidence"
import { FixtureAgentRuntime, FixtureToolAdapter, type FixtureScenario } from "@cyrion/runtime-opencode"
import { runTui } from "./tui"

const projectRoot = join(import.meta.dir, "../../..")
const command = process.argv[2] ?? "demo"
const headless = process.argv.includes("--headless") || !process.stdout.isTTY

if (command !== "demo") {
  console.error("Usage: cyrion demo [--headless] [--fixture <scenario>] [--state <sqlite-path>] [--artifacts <directory>]")
  process.exit(2)
}

const scenarios: FixtureScenario[] = ["known-positive", "clean", "rejected", "incomplete"]
const scenario = readFlag("--fixture") ?? "known-positive"
if (!scenarios.includes(scenario as FixtureScenario)) {
  console.error(`Unknown fixture scenario: ${scenario}. Choose ${scenarios.join(", ")}.`)
  process.exit(2)
}
const manifestPath = scenario === "known-positive"
  ? join(projectRoot, "fixtures/demo/engagement.json")
  : join(projectRoot, "fixtures/scenarios", `${scenario}.json`)
const manifest = await Bun.file(manifestPath).json()
assertManifest(manifest)
const stateArgument = readFlag("--state")
const artifactArgument = readFlag("--artifacts") ?? ".cyrion/artifacts"
const store = stateArgument
  ? new SQLiteEngagementStore(isAbsolute(stateArgument) ? stateArgument : resolve(process.cwd(), stateArgument), manifest.id)
  : undefined
const evidenceStore = new LocalEvidenceStore(
  isAbsolute(artifactArgument) ? artifactArgument : resolve(process.cwd(), artifactArgument),
)
const fixtureAdapter = new FixtureToolAdapter()
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
  console.log(JSON.stringify({
    status: result.status,
    scenario,
    engagementId: result.manifest.id,
    agents: result.agents.length,
    tasks: result.tasks.length,
    confirmed: result.findings.filter((finding) => finding.status === "confirmed").length,
    rejected: result.findings.filter((finding) => finding.status === "rejected").length,
    inconclusive: result.findings.filter((finding) => finding.status === "inconclusive").length,
    evidence: result.evidence.length,
  }))
  controller.close()
  process.exit(result.status === "completed" ? 0 : 1)
}

await runTui(controller)
controller.close()

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith("--")) {
    console.error(`${name} requires a value`)
    process.exit(2)
  }
  return value
}
