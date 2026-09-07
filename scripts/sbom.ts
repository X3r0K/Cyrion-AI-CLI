import { access, readFile } from "node:fs/promises"
import { dirname, join, parse } from "node:path"

interface PackageManifest {
  name: string
  version: string
  description?: string
  license?: string
  repository?: string | { url?: string }
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

interface CycloneDxComponent {
  type: "application" | "library"
  name: string
  version: string
  group?: string
  description?: string
  licenses?: Array<{ license: { name: string } }>
  purl: string
  "bom-ref": string
  externalReferences?: Array<{ type: "vcs"; url: string }>
}

interface CycloneDxDependency {
  ref: string
  dependsOn: string[]
}

export interface CycloneDxBom {
  bomFormat: "CycloneDX"
  specVersion: "1.6"
  version: 1
  metadata: {
    timestamp: string
    tools: { components: CycloneDxComponent[] }
    component: CycloneDxComponent
  }
  components: CycloneDxComponent[]
  dependencies: CycloneDxDependency[]
}

export async function createCycloneDxBom(
  projectRoot: string,
  timestamp = new Date().toISOString(),
): Promise<CycloneDxBom> {
  const rootManifest = await readManifest(join(projectRoot, "package.json"))
  const rootComponent = componentFor(rootManifest, "application")
  const components = new Map<string, CycloneDxComponent>()
  const graph = new Map<string, Set<string>>()

  const visit = async (name: string, importer: string, optional: boolean): Promise<string | undefined> => {
    let entry: string
    try {
      entry = Bun.resolveSync(name, importer)
    } catch (error) {
      if (optional) return undefined
      throw new Error(`Unable to resolve production dependency ${name}`, { cause: error })
    }
    const located = await locateManifest(name, entry)
    const component = componentFor(located.manifest, "library")
    const reference = component["bom-ref"]
    if (components.has(reference)) return reference
    components.set(reference, component)
    graph.set(reference, new Set())

    const dependencyNames = new Set([
      ...Object.keys(located.manifest.dependencies ?? {}),
      ...Object.keys(located.manifest.optionalDependencies ?? {}),
      ...Object.keys(located.manifest.peerDependencies ?? {}),
    ])
    for (const dependencyName of [...dependencyNames].sort()) {
      const dependencyOptional = dependencyName in (located.manifest.optionalDependencies ?? {})
        || located.manifest.peerDependenciesMeta?.[dependencyName]?.optional === true
      const child = await visit(dependencyName, entry, dependencyOptional)
      if (child) graph.get(reference)!.add(child)
    }
    return reference
  }

  const rootDependencies = new Set<string>()
  for (const name of Object.keys(rootManifest.dependencies ?? {}).sort()) {
    const reference = await visit(name, projectRoot, false)
    if (reference) rootDependencies.add(reference)
  }
  graph.set(rootComponent["bom-ref"], rootDependencies)

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      timestamp,
      tools: {
        components: [{
          type: "application",
          name: "Bun",
          version: Bun.version,
          purl: `pkg:generic/bun@${Bun.version}`,
          "bom-ref": `pkg:generic/bun@${Bun.version}`,
        }],
      },
      component: rootComponent,
    },
    components: [...components.values()].sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"])),
    dependencies: [...graph.entries()]
      .map(([ref, dependsOn]) => ({ ref, dependsOn: [...dependsOn].sort() }))
      .sort((left, right) => left.ref.localeCompare(right.ref)),
  }
}

export function assertCycloneDxBom(value: unknown): asserts value is CycloneDxBom {
  if (!isRecord(value) || value.bomFormat !== "CycloneDX" || value.specVersion !== "1.6" || value.version !== 1) {
    throw new Error("Invalid CycloneDX document header")
  }
  if (!isRecord(value.metadata) || !isRecord(value.metadata.component)) {
    throw new Error("CycloneDX metadata component is missing")
  }
  if (!Array.isArray(value.components) || !Array.isArray(value.dependencies)) {
    throw new Error("CycloneDX components or dependency graph is missing")
  }
  const references = new Set<string>()
  for (const component of [value.metadata.component, ...value.components]) {
    if (!isRecord(component) || typeof component["bom-ref"] !== "string" || typeof component.purl !== "string") {
      throw new Error("CycloneDX component has no package reference")
    }
    if (references.has(component["bom-ref"])) throw new Error(`Duplicate CycloneDX component ${component["bom-ref"]}`)
    references.add(component["bom-ref"])
  }
  for (const dependency of value.dependencies) {
    if (!isRecord(dependency) || typeof dependency.ref !== "string" || !Array.isArray(dependency.dependsOn)) {
      throw new Error("Invalid CycloneDX dependency record")
    }
    if (!references.has(dependency.ref)) throw new Error(`Unknown CycloneDX dependency source ${dependency.ref}`)
    for (const reference of dependency.dependsOn) {
      if (typeof reference !== "string" || !references.has(reference)) {
        throw new Error(`Unknown CycloneDX dependency target ${String(reference)}`)
      }
    }
  }
}

async function locateManifest(name: string, entry: string): Promise<{ manifest: PackageManifest; path: string }> {
  let directory = dirname(entry)
  while (true) {
    const path = join(directory, "package.json")
    try {
      await access(path)
      const manifest = await readManifest(path)
      if (manifest.name === name) return { manifest, path }
    } catch {
      // Continue toward the filesystem root until the owning package is found.
    }
    const parent = dirname(directory)
    if (parent === directory || directory === parse(directory).root) break
    directory = parent
  }
  throw new Error(`Unable to locate package metadata for ${name}`)
}

async function readManifest(path: string): Promise<PackageManifest> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"))
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.version !== "string") {
    throw new Error(`Invalid package manifest: ${path}`)
  }
  return value as unknown as PackageManifest
}

function componentFor(manifest: PackageManifest, type: CycloneDxComponent["type"]): CycloneDxComponent {
  const purl = npmPurl(manifest.name, manifest.version)
  const slash = manifest.name.startsWith("@") ? manifest.name.indexOf("/") : -1
  const group = slash > 0 ? manifest.name.slice(0, slash) : undefined
  const name = slash > 0 ? manifest.name.slice(slash + 1) : manifest.name
  const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url
  return {
    type,
    name,
    version: manifest.version,
    ...(group ? { group } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.license ? { licenses: [{ license: { name: manifest.license } }] } : {}),
    purl,
    "bom-ref": purl,
    ...(repository ? { externalReferences: [{ type: "vcs", url: normalizeRepository(repository) }] } : {}),
  }
}

function npmPurl(name: string, version: string): string {
  if (name.startsWith("@")) {
    const [namespace, packageName] = name.split("/")
    return `pkg:npm/${encodeURIComponent(namespace!)}/${encodeURIComponent(packageName!)}@${encodeURIComponent(version)}`
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`
}

function normalizeRepository(value: string): string {
  return value.replace(/^git\+/, "").replace(/\.git$/, "")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
