import { createHash } from "node:crypto"
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { assertCycloneDxBom, createCycloneDxBom } from "./sbom"

const projectRoot = join(import.meta.dir, "..")
const outputDirectory = join(projectRoot, "release")

await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true, mode: 0o755 })
await run(["npm", "pack", "--ignore-scripts", "--silent", "--pack-destination", outputDirectory], projectRoot)

const tarball = (await readdir(outputDirectory)).find((entry) => entry.endsWith(".tgz"))
if (!tarball) throw new Error("npm pack did not produce a release tarball")

const packageMetadata = await Bun.file(join(projectRoot, "package.json")).json() as { name: string; version: string }
const sbomName = `${packageMetadata.name}-${packageMetadata.version}.cdx.json`
const bom = await createCycloneDxBom(projectRoot)
assertCycloneDxBom(bom)
await writeFile(join(outputDirectory, sbomName), `${JSON.stringify(bom, null, 2)}\n`, { mode: 0o644 })

// The worker image record travels with the release: an operator comparing their
// numbers with the published ones can see which image produced them.
const workerManifestName = "worker-manifest.json"
await Bun.write(
  join(outputDirectory, workerManifestName),
  await Bun.file(join(projectRoot, "containers", workerManifestName)).text(),
)

const artifactNames = [tarball, sbomName, workerManifestName].sort()
const checksums = await Promise.all(artifactNames.map(async (name) => {
  const bytes = new Uint8Array(await Bun.file(join(outputDirectory, name)).arrayBuffer())
  return `${createHash("sha256").update(bytes).digest("hex")}  ${name}`
}))
await writeFile(join(outputDirectory, "SHA256SUMS"), `${checksums.join("\n")}\n`, { mode: 0o644 })

console.log(`Release artifacts created in ${outputDirectory}`)
for (const name of [...artifactNames, "SHA256SUMS"]) console.log(`- ${name}`)

async function run(command: string[], cwd: string): Promise<void> {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", env: Bun.env })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed (${exitCode})\n${stderr}${stdout}`)
}
