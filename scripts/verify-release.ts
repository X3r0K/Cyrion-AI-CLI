import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

const projectRoot = join(import.meta.dir, "..")
const sandbox = await mkdtemp(join(tmpdir(), "cyrion-release-"))
const installCache = join(sandbox, "bun-cache")
const processTemp = join(sandbox, "tmp")

try {
  await mkdir(installCache, { mode: 0o700 })
  await mkdir(processTemp, { mode: 0o700 })
  await run(["npm", "pack", "--ignore-scripts", "--silent", "--pack-destination", sandbox], projectRoot)
  const filename = (await readdir(sandbox)).find((entry) => entry.endsWith(".tgz"))
  if (!filename) throw new Error("npm pack did not return a package filename")
  const tarball = join(sandbox, filename)
  const checksum = createHash("sha256").update(new Uint8Array(await Bun.file(tarball).arrayBuffer())).digest("hex")
  const listing = await run(["tar", "-tzf", tarball], projectRoot)
  const forbidden = listing.split("\n").find((entry) =>
    (entry.includes("/.env") && entry !== "package/.env.example")
    || entry.includes("/.cyrion/")
    || entry.endsWith(".sqlite")
    || entry.startsWith("package/references/")
    || entry.startsWith("package/.git/")
  )
  if (forbidden) throw new Error(`Forbidden release entry: ${forbidden}`)
  await run(["tar", "-xzf", tarball, "-C", sandbox], projectRoot)

  const packageRoot = join(sandbox, "package")
  await stat(join(packageRoot, "dist/cyrion.js"))
  await stat(join(packageRoot, "agents/root/system.md"))
  await stat(join(packageRoot, "fixtures/manifest.json"))
  await stat(join(packageRoot, "workers/fixture-worker.ts"))
  await stat(join(packageRoot, ".env.example"))

  const packageMetadata = await Bun.file(join(packageRoot, "package.json")).json() as { name?: string; version?: string }
  if (!packageMetadata.name || !packageMetadata.version) throw new Error("Packed package identity is missing")
  const consumer = join(sandbox, "consumer")
  await mkdir(consumer, { mode: 0o700 })
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    private: true,
    dependencies: { [packageMetadata.name]: `file:${tarball}` },
  }))
  await run(["bun", "install", "--ignore-scripts"], consumer)
  const installedRoot = join(consumer, "node_modules", packageMetadata.name)
  const executable = join(installedRoot, "dist/cyrion.js")
  await stat(executable)

  const version = (await run(["bun", executable, "version"], consumer)).trim()
  if (version !== packageMetadata.version) {
    throw new Error(`Packed CLI version ${version} does not match package version ${packageMetadata.version ?? "missing"}`)
  }

  const statePath = join(sandbox, "state.sqlite")
  const artifactsPath = join(sandbox, "artifacts")
  const demo = await run([
    "bun", executable, "demo", "--headless", "--fixture", "known-positive",
    "--state", statePath, "--artifacts", artifactsPath,
  ], consumer)
  const finalLine = demo.trim().split("\n").at(-1)
  const summary = JSON.parse(finalLine ?? "null") as { status?: string; confirmed?: number }
  if (summary.status !== "completed" || summary.confirmed !== 1) {
    throw new Error("Packed known-positive demo did not produce the expected result")
  }

  const supervised = await run([
    "bun", executable, "demo", "--headless", "--fixture", "clean",
    "--mode", "supervised", "--approve-all",
    "--state", join(sandbox, "supervised.sqlite"),
    "--artifacts", join(sandbox, "supervised-artifacts"),
  ], consumer)
  const supervisedLines = supervised.trim().split("\n")
  const supervisedSummary = JSON.parse(supervisedLines.at(-1) ?? "null") as { status?: string }
  if (
    supervisedSummary.status !== "completed"
    || !supervisedLines.some((line) => line.includes('"type":"root.decision.awaiting_approval"'))
    || !supervisedLines.some((line) => line.includes('"type":"root.decision.approved"'))
  ) {
    throw new Error("Packed supervised demo did not exercise the approval gate")
  }

  const status = await run(["bun", executable, "status", "ENG-0042", "--state", statePath, "--json"], consumer)
  const statusResult = JSON.parse(status) as { status?: string; evidence?: number }
  if (statusResult.status !== "completed" || statusResult.evidence !== 6) {
    throw new Error("Packed status command did not read durable state")
  }

  const report = await run([
    "bun", executable, "report", "ENG-0042", "--state", statePath, "--format", "markdown",
  ], consumer)
  if (!report.includes("## Evidence index") || !report.includes("**CONFIRMED**")) {
    throw new Error("Packed report command did not render the expected report")
  }

  console.log(`Release package verified: ${filename} (sha256 ${checksum})`)
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

async function run(command: string[], cwd: string): Promise<string> {
  const process = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      BUN_INSTALL_CACHE_DIR: installCache,
      NPM_CONFIG_CACHE: join(sandbox, "npm-cache"),
      TEMP: processTemp,
      TMP: processTemp,
      TMPDIR: processTemp,
    },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode})\n${stderr}${stdout}`)
  }
  return stdout
}
