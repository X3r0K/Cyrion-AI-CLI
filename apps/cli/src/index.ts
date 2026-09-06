#!/usr/bin/env bun
import { isAbsolute, join, resolve } from "node:path"
import { assertManifest, type EngagementManifest } from "@cyrion/contracts"
import { CyrionController, FixtureRootPlanner, ScopedToolGateway, SQLiteEngagementStore } from "@cyrion/controller"
import { FixtureAgentRuntime, FixtureToolAdapter } from "@cyrion/runtime-opencode"
import { runTui } from "./tui"

const projectRoot = join(import.meta.dir, "../../..")
const command = process.argv[2] ?? "demo"
const headless = process.argv.includes("--headless") || !process.stdout.isTTY

if (command !== "demo") {
  console.error("Usage: cyrion demo [--headless] [--state <sqlite-path>]")
  process.exit(2)
}

const manifest = await Bun.file(join(projectRoot, "fixtures/demo/engagement.json")).json()
assertManifest(manifest)
const stateFlag = process.argv.indexOf("--state")
const stateArgument = stateFlag >= 0 ? process.argv[stateFlag + 1] : undefined
if (stateFlag >= 0 && (!stateArgument || stateArgument.startsWith("--"))) {
  console.error("--state requires a SQLite file path")
  process.exit(2)
}
const store = stateArgument
  ? new SQLiteEngagementStore(isAbsolute(stateArgument) ? stateArgument : resolve(process.cwd(), stateArgument), manifest.id)
  : undefined
const fixtureAdapter = new FixtureToolAdapter()
const toolGateway = new ScopedToolGateway(manifest, {
  "fixture.read": fixtureAdapter,
  "fixture.compare": fixtureAdapter,
})

const controller = new CyrionController(
  manifest as EngagementManifest,
  new FixtureAgentRuntime(),
  new FixtureRootPlanner(),
  join(projectRoot, "agents"),
  { ...(store ? { store } : {}), toolGateway },
)

if (headless) {
  controller.events.subscribe((event) => console.log(JSON.stringify(event)))
  const result = await controller.run()
  console.log(JSON.stringify({
    status: result.status,
    engagementId: result.manifest.id,
    agents: result.agents.length,
    tasks: result.tasks.length,
    confirmed: result.findings.filter((finding) => finding.status === "confirmed").length,
    evidence: result.evidence.length,
  }))
  controller.close()
  process.exit(result.status === "completed" ? 0 : 1)
}

await runTui(controller)
controller.close()
