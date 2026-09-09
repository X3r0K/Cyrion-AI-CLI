import { readdir, readFile, realpath, stat } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import type { ToolExecutionRequest, ToolProgress } from "@cyrion/contracts"
import { evaluateScope, parseTarget } from "@cyrion/scope"
import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "./types"

/** Ceilings, so a repository with a vendored world cannot stall an engagement. */
const MAX_FILES = 20_000
const MAX_DEPTH = 12
const MAX_MANIFEST_BYTES = 512 * 1024

/** Directories that hold someone else's code, or the build's own output. */
const SKIP_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build", "out", "target",
  ".next", ".nuxt", ".venv", "venv", "__pycache__", ".cache", "coverage", ".terraform",
])

const LANGUAGES: ReadonlyArray<{ language: string; extensions: string[] }> = [
  { language: "TypeScript", extensions: [".ts", ".tsx", ".mts", ".cts"] },
  { language: "JavaScript", extensions: [".js", ".jsx", ".mjs", ".cjs"] },
  { language: "Python", extensions: [".py"] },
  { language: "Go", extensions: [".go"] },
  { language: "Rust", extensions: [".rs"] },
  { language: "Java", extensions: [".java"] },
  { language: "C#", extensions: [".cs"] },
  { language: "Ruby", extensions: [".rb"] },
  { language: "PHP", extensions: [".php"] },
  { language: "C/C++", extensions: [".c", ".h", ".cc", ".cpp", ".hpp"] },
  { language: "Shell", extensions: [".sh", ".bash"] },
  { language: "SQL", extensions: [".sql"] },
]

/** Files that declare what a project depends on, and therefore what it inherits. */
const MANIFESTS = [
  "package.json", "bun.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "requirements.txt", "pyproject.toml", "poetry.lock", "Pipfile.lock",
  "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "Gemfile", "Gemfile.lock",
  "composer.json", "composer.lock", "pom.xml", "build.gradle", "build.gradle.kts",
] as const

/** Where a reader looks first to find out how a service starts. */
const ENTRYPOINTS = [
  "main.go", "main.py", "main.rs", "app.py", "wsgi.py", "asgi.py", "manage.py",
  "index.ts", "index.js", "server.ts", "server.js", "app.ts", "app.js",
  "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "Procfile", "Makefile",
] as const

export interface RepoInventory {
  root: string
  files: number
  bytes: number
  truncated: boolean
  languages: Array<{ language: string; files: number }>
  manifests: string[]
  entrypoints: string[]
  /** Files that configure the environment, which is where secrets tend to leak. */
  configuration: string[]
}

/**
 * Inventories an approved repository: what it is written in, what it depends
 * on, and where it starts.
 *
 * Implemented inside Cyrion rather than shelling out, so a repository target
 * works on a bare machine. It reads directory entries and the names of
 * manifests; it does not read source, because an inventory that quotes a file
 * has started reporting rather than inventorying.
 *
 * Everything it finds is a **static claim**. Nothing here observes a running
 * system, so nothing here can be confirmed — the controller enforces that
 * separately.
 */
export const repoInventory: CapabilityAdapter = {
  capability: "repo.inventory",

  async execute(
    request: ToolExecutionRequest,
    context: CapabilityContext,
    signal: AbortSignal,
    progress?: ToolProgress,
  ): Promise<CapabilityResult> {
    const decision = evaluateScope(context.scope, request.target)
    if (!decision.allowed) throw new Error(`repo.inventory refused: ${decision.reason}`)
    const target = parseTarget(request.target)
    if (target.kind !== "repo") throw new Error("repo.inventory needs a repository target")

    // Symlinks are resolved and re-checked: a link inside an approved root can
    // otherwise point at anything the process can read.
    const root = await realpath(resolve(target.root)).catch(() => resolve(target.root))
    const rootDecision = evaluateScope(context.scope, `repo:${root}`)
    if (!rootDecision.allowed) {
      throw new Error(`repo.inventory refused: ${root} resolves outside the approved scope`)
    }
    const details = await stat(root).catch(() => undefined)
    if (!details?.isDirectory()) throw new Error(`repo.inventory refused: ${root} is not a directory`)

    const inventory = await walk(root, signal, progress)
    const record = { ...inventory }
    const evidence = await context.evidence.capture({
      engagementId: request.engagementId,
      id: context.nextEvidenceId("E"),
      kind: "log",
      content: `${JSON.stringify(record, null, 2)}\n`,
      contentType: "application/json",
      source: request.agentId,
    })

    return {
      summary: {
        root: inventory.root,
        files: inventory.files,
        truncated: inventory.truncated,
        languages: inventory.languages,
        manifests: inventory.manifests,
        entrypoints: inventory.entrypoints,
        configuration: inventory.configuration,
      },
      evidence: [evidence],
      outcome: `${inventory.files} file(s) · ${inventory.languages[0]?.language ?? "no language detected"}`
        + `${inventory.manifests.length ? ` · ${inventory.manifests.length} manifest(s)` : ""}`
        + `${inventory.truncated ? " · truncated" : ""}`,
    }
  },
}

async function walk(root: string, signal: AbortSignal, progress?: ToolProgress): Promise<RepoInventory> {
  const counts = new Map<string, number>()
  const manifests: string[] = []
  const entrypoints: string[] = []
  const configuration: string[] = []
  let files = 0
  let bytes = 0
  let truncated = false
  let lastNote = 0

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (signal.aborted) throw signal.reason
    if (truncated || depth > MAX_DEPTH) return
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (truncated) return
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        // Symlinked directories are not followed: a repository may not walk the
        // walker out of the approved root.
        if (entry.isSymbolicLink()) continue
        await visit(join(directory, entry.name), depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      files += 1
      if (files > MAX_FILES) {
        truncated = true
        return
      }
      const path = join(directory, entry.name)
      const relativePath = relative(root, path).split(sep).join("/")
      const size = await stat(path).then((info) => info.size).catch(() => 0)
      bytes += size

      const extension = entry.name.includes(".") ? entry.name.slice(entry.name.lastIndexOf(".")) : ""
      const language = LANGUAGES.find((entry) => entry.extensions.includes(extension.toLowerCase()))
      if (language) counts.set(language.language, (counts.get(language.language) ?? 0) + 1)
      if ((MANIFESTS as readonly string[]).includes(entry.name)) manifests.push(relativePath)
      if ((ENTRYPOINTS as readonly string[]).includes(entry.name)) entrypoints.push(relativePath)
      if (/^\.env($|\.)|^.*\.(ini|conf|cfg)$|^config\.(json|ya?ml|toml)$/i.test(entry.name)) {
        configuration.push(relativePath)
      }

      const now = Date.now()
      if (progress && now - lastNote > 500) {
        lastNote = now
        progress(`${files} file(s) inventoried`)
      }
    }
  }

  await visit(root, 0)
  return {
    root,
    files: Math.min(files, MAX_FILES),
    bytes,
    truncated,
    languages: [...counts.entries()]
      .map(([language, count]) => ({ language, files: count }))
      .sort((left, right) => right.files - left.files || left.language.localeCompare(right.language)),
    manifests: manifests.sort().slice(0, 64),
    entrypoints: entrypoints.sort().slice(0, 64),
    configuration: configuration.sort().slice(0, 64),
  }
}

/**
 * Known-vulnerable dependencies in an approved repository.
 *
 * Grype reads the manifests the inventory found and reports what they inherit.
 * Its answer is a static claim about a lockfile, not an observation of a
 * running system, so it can never reach `confirmed` on its own.
 */
export const repoDeps: CapabilityAdapter = {
  capability: "repo.deps",
  binary: "grype",

  async execute(
    request: ToolExecutionRequest,
    context: CapabilityContext,
    signal: AbortSignal,
  ): Promise<CapabilityResult> {
    const decision = evaluateScope(context.scope, request.target)
    if (!decision.allowed) throw new Error(`repo.deps refused: ${decision.reason}`)
    const target = parseTarget(request.target)
    if (target.kind !== "repo") throw new Error("repo.deps needs a repository target")
    const root = await realpath(resolve(target.root)).catch(() => resolve(target.root))

    const result = await context.runner.run({
      argv: ["grype", `dir:${root}`, "--output", "json", "--quiet"],
      timeoutMs: Math.min(request.timeoutMs, 300_000),
      maxOutputBytes: Math.min(request.maxOutputBytes, 4_000_000),
    }, signal)
    if (result.timedOut) throw new Error(`repo.deps timed out after ${request.timeoutMs}ms`)
    if (result.exitCode !== 0 && !result.stdout.trim().startsWith("{")) {
      throw new Error(`grype exited ${result.exitCode}: ${result.stderr.trim().slice(0, 300) || "no diagnostic"}`)
    }

    const matches = parseGrypeMatches(result.stdout)
    const evidence = await context.evidence.capture({
      engagementId: request.engagementId,
      id: context.nextEvidenceId("E"),
      kind: "log",
      content: `${result.argv.join(" ")}\n\n${result.stdout}`,
      contentType: "application/json",
      source: request.agentId,
    })
    const bySeverity = countSeverities(matches)
    return {
      summary: {
        root,
        vulnerable: matches.length,
        bySeverity,
        matches: matches.slice(0, 200),
        truncated: result.truncated,
        runner: result.runner,
      },
      evidence: [evidence],
      outcome: `${matches.length} vulnerable dependency match(es)`
        + `${bySeverity.critical || bySeverity.high ? ` · ${bySeverity.critical} critical, ${bySeverity.high} high` : ""}`,
    }
  },
}

export interface DependencyMatch {
  id: string
  severity: string
  package: string
  version: string
  fixedIn?: string
}

/** Grype's JSON is stable across versions in the fields that matter here. */
export function parseGrypeMatches(output: string): DependencyMatch[] {
  let payload: unknown
  try {
    payload = JSON.parse(output)
  } catch {
    return []
  }
  const matches = (payload as { matches?: unknown }).matches
  if (!Array.isArray(matches)) return []
  const parsed: DependencyMatch[] = []
  for (const entry of matches.slice(0, 2_000)) {
    const vulnerability = (entry as { vulnerability?: Record<string, unknown> }).vulnerability
    const artifact = (entry as { artifact?: Record<string, unknown> }).artifact
    const id = text(vulnerability?.id)
    const name = text(artifact?.name)
    if (!id || !name) continue
    const fix = (vulnerability?.fix ?? {}) as { versions?: unknown }
    const fixed = Array.isArray(fix.versions) ? text(fix.versions[0]) : undefined
    parsed.push({
      id,
      severity: (text(vulnerability?.severity) ?? "unknown").toLowerCase(),
      package: name,
      version: text(artifact?.version) ?? "unknown",
      ...(fixed ? { fixedIn: fixed } : {}),
    })
  }
  return parsed
}

export function countSeverities(matches: readonly DependencyMatch[]): Record<string, number> {
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0 }
  for (const match of matches) {
    const key = match.severity in counts ? match.severity : "unknown"
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/**
 * Static analysis over an approved repository with public rulesets.
 *
 * `--config auto` is deliberately not used: it fetches rules from the network
 * mid-engagement, which would put an unreviewed ruleset inside the run. The
 * registry ruleset is named explicitly so a report can say which rules produced
 * a claim.
 */
export const repoScan: CapabilityAdapter = {
  capability: "repo.scan",
  binary: "semgrep",

  async execute(
    request: ToolExecutionRequest,
    context: CapabilityContext,
    signal: AbortSignal,
  ): Promise<CapabilityResult> {
    const decision = evaluateScope(context.scope, request.target)
    if (!decision.allowed) throw new Error(`repo.scan refused: ${decision.reason}`)
    const target = parseTarget(request.target)
    if (target.kind !== "repo") throw new Error("repo.scan needs a repository target")
    const root = await realpath(resolve(target.root)).catch(() => resolve(target.root))

    const input = (request.input ?? {}) as { ruleset?: unknown }
    const ruleset = typeof input.ruleset === "string" ? input.ruleset : "p/ci"
    if (!/^p\/[a-z0-9-]{1,64}$/.test(ruleset)) {
      throw new Error("repo.scan accepts a registry ruleset such as p/ci or p/security-audit")
    }

    const result = await context.runner.run({
      argv: [
        "semgrep", "scan",
        "--config", ruleset,
        "--json",
        "--quiet",
        "--metrics", "off",
        "--timeout", "30",
        root,
      ],
      timeoutMs: Math.min(request.timeoutMs, 600_000),
      maxOutputBytes: Math.min(request.maxOutputBytes, 4_000_000),
    }, signal)
    if (result.timedOut) throw new Error(`repo.scan timed out after ${request.timeoutMs}ms`)
    if (result.exitCode !== 0 && !result.stdout.trim().startsWith("{")) {
      throw new Error(`semgrep exited ${result.exitCode}: ${result.stderr.trim().slice(0, 300) || "no diagnostic"}`)
    }

    const results = parseSemgrepResults(result.stdout, root)
    const evidence = await context.evidence.capture({
      engagementId: request.engagementId,
      id: context.nextEvidenceId("E"),
      kind: "log",
      content: `${result.argv.join(" ")}\n\n${result.stdout}`,
      contentType: "application/json",
      source: request.agentId,
    })
    return {
      summary: {
        root,
        ruleset,
        results: results.length,
        rules: [...new Set(results.map((entry) => entry.ruleId))].slice(0, 100),
        findings: results.slice(0, 200),
        truncated: result.truncated,
        runner: result.runner,
      },
      evidence: [evidence],
      outcome: `${results.length} static result(s) from ${ruleset}`,
    }
  },
}

export interface StaticResult {
  ruleId: string
  path: string
  line: number
  severity: string
  message: string
}

/** Semgrep's JSON, reduced to what a report can carry without quoting source. */
export function parseSemgrepResults(output: string, root: string): StaticResult[] {
  let payload: unknown
  try {
    payload = JSON.parse(output)
  } catch {
    return []
  }
  const results = (payload as { results?: unknown }).results
  if (!Array.isArray(results)) return []
  const parsed: StaticResult[] = []
  for (const entry of results.slice(0, 2_000)) {
    const record = entry as Record<string, unknown>
    const extra = (record.extra ?? {}) as Record<string, unknown>
    const start = (record.start ?? {}) as { line?: unknown }
    const ruleId = text(record.check_id)
    const path = text(record.path)
    if (!ruleId || !path) continue
    parsed.push({
      ruleId,
      path: relative(root, path).split(sep).join("/") || path,
      line: Number.isSafeInteger(start.line) ? Number(start.line) : 0,
      severity: (text(extra.severity) ?? "info").toLowerCase(),
      // The message describes the rule, not the matched source: a report must
      // not carry a repository's own code out of it by accident.
      message: (text(extra.message) ?? ruleId).slice(0, 500),
    })
  }
  return parsed
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const clean = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim()
  return clean || undefined
}

/** Reads a manifest's declared name, for a readable inventory. */
export async function manifestName(root: string, manifest: string): Promise<string | undefined> {
  if (!manifest.endsWith("package.json")) return undefined
  const raw = await readFile(join(root, manifest), "utf8").catch(() => undefined)
  if (!raw || raw.length > MAX_MANIFEST_BYTES) return undefined
  try {
    return text((JSON.parse(raw) as { name?: unknown }).name)
  } catch {
    return undefined
  }
}
