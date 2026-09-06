import { createHash } from "node:crypto"
import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

const projectRoot = join(import.meta.dir, "..")
const sandbox = await mkdtemp(join(tmpdir(), "cyrion-release-"))

try {
  await run(["npm", "pack", "--ignore-scripts", "--silent", "--pack-destination", sandbox], projectRoot)
  const filename = (await readdir(sandbox)).find((entry) => entry.endsWith(".tgz"))
  if (!filename) throw new Error("npm pack did not return a package filename")
  const tarball = join(sandbox, filename)
  const checksum = createHash("sha256").update(await Bun.file(tarball).arrayBuffer()).digest("hex")
  const listing = await run(["tar", "-tzf", tarball], projectRoot)
  const forbidden = listing.split("\n").find((entry) =>
    entry.includes("/.env")
    || entry.includes("/.cyrion/")
    || entry.endsWith(".sqlite")
    || entry.startsWith("package/references/")
    || entry.startsWith("package/.git/")
  )
  if (forbidden) throw new Error(`Forbidden release entry: ${forbidden}`)
  await run(["tar", "-xzf", tarball, "-C", sandbox], projectRoot)

  const packageRoot = join(sandbox, "package")
  const executable = join(packageRoot, "dist/cyrion.js")
  await stat(executable)
  await stat(join(packageRoot, "agents/root/system.md"))
  await stat(join(packageRoot, "fixtures/manifest.json"))

  const packageMetadata = await Bun.file(join(packageRoot, "package.json")).json() as { version?: string }
  const version = (await run(["bun", executable, "version"], sandbox)).trim()
  if (!packageMetadata.version || version !== packageMetadata.version) {
    throw new Error(`Packed CLI version ${version} does not match package version ${packageMetadata.version ?? "missing"}`)
  }

  const statePath = join(sandbox, "state.sqlite")
  const artifactsPath = join(sandbox, "artifacts")
  const demo = await run([
    "bun", executable, "demo", "--headless", "--fixture", "known-positive",
    "--state", statePath, "--artifacts", artifactsPath,
  ], sandbox)
  const finalLine = demo.trim().split("\n").at(-1)
  const summary = JSON.parse(finalLine ?? "null") as { status?: string; confirmed?: number }
  if (summary.status !== "completed" || summary.confirmed !== 1) {
    throw new Error("Packed known-positive demo did not produce the expected result")
  }

  const status = await run(["bun", executable, "status", "ENG-0042", "--state", statePath, "--json"], sandbox)
  const statusResult = JSON.parse(status) as { status?: string; evidence?: number }
  if (statusResult.status !== "completed" || statusResult.evidence !== 6) {
    throw new Error("Packed status command did not read durable state")
  }

  const report = await run([
    "bun", executable, "report", "ENG-0042", "--state", statePath, "--format", "markdown",
  ], sandbox)
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
    env: { ...Bun.env, NPM_CONFIG_CACHE: join(sandbox, "npm-cache") },
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
