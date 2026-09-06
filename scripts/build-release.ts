import { chmod, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"

const projectRoot = join(import.meta.dir, "..")
const outputDirectory = join(projectRoot, "dist")
const outputPath = join(outputDirectory, "cyrion.js")

await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })

const result = await Bun.build({
  entrypoints: [join(projectRoot, "apps/cli/src/index.ts")],
  outdir: outputDirectory,
  naming: "cyrion.js",
  target: "bun",
  format: "esm",
  external: [
    "@opentui/core-darwin-x64",
    "@opentui/core-darwin-arm64",
    "@opentui/core-linux-arm64",
    "@opentui/core-linux-arm64-musl",
    "@opentui/core-win32-x64",
    "@opentui/core-win32-arm64",
  ],
  sourcemap: "external",
  minify: false,
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  throw new Error("Release bundle failed")
}

await chmod(outputPath, 0o755)
console.log(`Built ${outputPath}`)
