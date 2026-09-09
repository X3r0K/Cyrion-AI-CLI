import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scrubbedEnvironment, spawnBounded } from "./process"
import type { BinaryInfo, CommandResult, CommandSpec, SandboxKind, SandboxReport, ToolRunner } from "./types"

/** Tools disagree: nmap takes --version, ffuf takes -V, older Go tools take -version. */
export const VERSION_FLAGS = ["--version", "-version", "-V", "-v"] as const

export interface LocalRunnerOptions {
  /** Binaries this runner may execute. A capability adapter cannot widen it. */
  allowedBinaries: readonly string[]
  /**
   * Lifts the allowlist, for an engagement that granted `shell.exec`.
   *
   * A free-form shell has no fixed binary by definition, so the allowlist stops
   * being the boundary and the sandbox becomes it. In a container that is the
   * image plus the egress rules; here it is the operator's own machine and
   * their own account, which is exactly why container is the default.
   */
  allowAnyBinary?: boolean
  workRoot?: string
}

/**
 * Runs capability processes directly on the operator's machine — the mode a
 * Kali or Parrot user wants, because the toolchain is already installed and
 * already trusted.
 *
 * Every control that does not need a kernel boundary still applies: the binary
 * must be on the allowlist, argv is built by the adapter rather than a model,
 * the environment is scrubbed, the working directory is private and removed,
 * output is bounded, and the process group is killed on timeout. What it cannot
 * give you is filesystem or network isolation from the host; `SandboxReport`
 * says so rather than implying otherwise.
 */
export class LocalToolRunner implements ToolRunner {
  readonly kind: SandboxKind = "local"
  readonly #allowed: ReadonlySet<string>
  readonly #allowAny: boolean
  readonly #workRoot: string
  readonly #cache = new Map<string, BinaryInfo | undefined>()

  constructor(options: LocalRunnerOptions) {
    this.#allowed = new Set(options.allowedBinaries)
    this.#allowAny = options.allowAnyBinary === true
    this.#workRoot = options.workRoot ?? tmpdir()
  }

  async lookup(binary: string): Promise<BinaryInfo | undefined> {
    if (this.#cache.has(binary)) return this.#cache.get(binary)
    const info = await resolveBinary(binary, this.#workRoot)
    this.#cache.set(binary, info)
    return info
  }

  async run(spec: CommandSpec, signal?: AbortSignal): Promise<CommandResult> {
    const [binary, ...rest] = spec.argv
    if (!binary) throw new Error("A command needs a binary")
    if (!this.#allowAny && !this.#allowed.has(binary)) {
      throw new Error(`Binary is not allowed in this engagement: ${binary}`)
    }
    const info = await this.lookup(binary)
    if (!info) throw new Error(`${binary} is not installed on this machine. Run \`cyrion tools\` for install guidance.`)

    const workDirectory = await mkdtemp(join(this.#workRoot, "cyrion-work-"))
    try {
      return await spawnBounded({
        argv: [info.path, ...rest],
        cwd: workDirectory,
        env: scrubbedEnvironment(workDirectory, spec.env),
        timeoutMs: spec.timeoutMs,
        maxOutputBytes: spec.maxOutputBytes,
        runner: this.kind,
        ...(signal ? { signal } : {}),
        ...(spec.onOutput ? { onOutput: spec.onOutput } : {}),
      })
    } finally {
      await rm(workDirectory, { recursive: true, force: true })
    }
  }

  async close(): Promise<void> {}

  report(): SandboxReport {
    return {
      kind: "local",
      ready: true,
      detail: "Capabilities run on this machine with the tools you already have installed.",
      enforced: [
        "capability allowlist",
        "argv built by the adapter, never by a model",
        "scrubbed environment without operator credentials",
        "private working directory, removed after each run",
        "output ceiling and wall-clock timeout",
        "process group terminated on timeout or cancellation",
      ],
      missing: [
        "filesystem isolation from the host",
        "kernel-enforced egress allowlist",
        "protection from a tool that misbehaves with your privileges",
      ],
    }
  }
}

/** Resolves a binary on PATH and asks it for a version, tolerating tools that refuse. */
export async function resolveBinary(binary: string, workRoot: string): Promise<BinaryInfo | undefined> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(binary)) throw new Error(`Unsafe binary name: ${binary}`)
  const path = Bun.which(binary)
  if (!path) return undefined
  for (const flag of VERSION_FLAGS) {
    const probe = await spawnBounded({
      argv: [path, flag],
      cwd: workRoot,
      env: scrubbedEnvironment(workRoot),
      timeoutMs: 5_000,
      maxOutputBytes: 8_192,
      runner: "local",
    }).catch(() => undefined)
    const text = `${probe?.stdout ?? ""}${probe?.stderr ?? ""}`
    const version = versionLine(text)
    if (probe && version) return { name: binary, path, version }
  }
  return { name: binary, path }
}

/** First line that looks like a version. Several tools print a banner first. */
export function versionLine(value: string): string | undefined {
  for (const line of value.split("\n")) {
    const clean = line.trim()
    if (clean && /\d+\.\d+/.test(clean)) return clean.slice(0, 160)
  }
  return undefined
}
