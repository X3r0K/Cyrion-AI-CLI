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

  await runTuiSmoke(executable, consumer)

  const statePath = join(sandbox, "state.sqlite")
  const artifactsPath = join(sandbox, "artifacts")
  const demo = await run([
    "bun", executable, "demo", "--headless", "--fixture", "known-positive",
    "--planner", "fixture", "--workers", "fixture", "--mode", "autonomous",
    "--state", statePath, "--artifacts", artifactsPath,
  ], consumer)
  const finalLine = demo.trim().split("\n").at(-1)
  const summary = JSON.parse(finalLine ?? "null") as { status?: string; confirmed?: number }
  if (summary.status !== "completed" || summary.confirmed !== 1) {
    throw new Error("Packed known-positive demo did not produce the expected result")
  }

  const supervised = await run([
    "bun", executable, "demo", "--headless", "--fixture", "clean",
    "--planner", "fixture", "--workers", "fixture", "--mode", "supervised", "--approve-all",
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

async function runTuiSmoke(executable: string, cwd: string): Promise<void> {
  if (process.platform !== "linux") return

  const child = Bun.spawn([
    "script", "--quiet", "--return", "--command",
    `bun ${executable} demo --planner fixture --workers fixture --mode autonomous`, "/dev/null",
  ], {
    cwd,
    stdin: "pipe",
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
  let timedOut = false
  let quitSent = false
  const stdoutPromise = readOutput(child.stdout, (output) => {
    if (quitSent || !output.includes("CYRION/AI")) return
    quitSent = true
    child.stdin.write("q")
    child.stdin.end()
  })
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
  }, 10_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    stdoutPromise,
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timeout)
  if (timedOut || !quitSent || exitCode !== 0 || !stdout.includes("CYRION/AI")) {
    throw new Error(`Packed TUI smoke failed (${exitCode})\n${stderr}${stdout}`)
  }
}

async function readOutput(stream: ReadableStream<Uint8Array>, onOutput: (output: string) => void): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ""
  while (true) {
    const result = await reader.read()
    if (result.done) break
    output += decoder.decode(result.value, { stream: true })
    onOutput(output)
  }
  return output + decoder.decode()
}
