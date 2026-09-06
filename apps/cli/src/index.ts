#!/usr/bin/env bun
import { join } from "node:path"
import { assertManifest, type EngagementManifest } from "@cyrion/contracts"
import { CyrionController, FixtureRootPlanner } from "@cyrion/controller"
import { FixtureAgentRuntime } from "@cyrion/runtime-opencode"
import { runTui } from "./tui"

const projectRoot = join(import.meta.dir, "../../..")
const command = process.argv[2] ?? "demo"
const headless = process.argv.includes("--headless") || !process.stdout.isTTY

if (command !== "demo") {
  console.error("Usage: cyrion demo [--headless]")
  process.exit(2)
}

const manifest = await Bun.file(join(projectRoot, "fixtures/demo/engagement.json")).json()
assertManifest(manifest)

const controller = new CyrionController(
  manifest as EngagementManifest,
  new FixtureAgentRuntime(),
  new FixtureRootPlanner(),
  join(projectRoot, "agents"),
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
  process.exit(result.status === "completed" ? 0 : 1)
}

await runTui(controller)
