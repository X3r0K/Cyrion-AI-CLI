import { VERSION_FLAGS, versionLine } from "./local"
import { spawnBounded } from "./process"
import { buildEgressRules, describeEgressRules, type EgressPolicy } from "./egress"
import type { BinaryInfo, CommandResult, CommandSpec, SandboxKind, SandboxReport, ToolRunner } from "./types"

export type ContainerEngine = "docker" | "podman"

export interface ContainerRunnerOptions {
  engine: ContainerEngine
  image: string
  engagementId: string
  allowedBinaries: readonly string[]
  network?: string
  memory?: string
  cpus?: string
  pids?: number
  /** Extra Linux capabilities. Empty by default: everything is dropped. */
  addCapabilities?: readonly string[]
  /** Unprivileged by default, so a tool cannot read root-owned files in its own image. */
  user?: string
  egress?: EgressPolicy
  /**
   * Starts the container even when the egress allowlist cannot be installed.
   * The operator is told exactly what is not enforced.
   */
  allowUnfilteredEgress?: boolean
}

const CONTAINER_WORK_DIR = "/work"

/**
 * One long-lived container per engagement, executed into per capability.
 *
 * Hardening is applied at creation (read-only root, tmpfs work directory, all
 * capabilities dropped, no host mounts, resource ceilings) and the egress
 * allowlist is installed from the host into the container's own network
 * namespace, so a worker without NET_ADMIN cannot remove it.
 */
export class ContainerToolRunner implements ToolRunner {
  readonly kind: SandboxKind = "container"
  readonly #options: ContainerRunnerOptions
  readonly #name: string
  readonly #allowed: ReadonlySet<string>
  readonly #cache = new Map<string, BinaryInfo | undefined>()
  #containerIdValue: string | undefined
  #egressApplied = false
  #egressDetail = "not requested"

  constructor(options: ContainerRunnerOptions) {
    this.#options = options
    this.#allowed = new Set(options.allowedBinaries)
    this.#name = `cyrion-${options.engagementId.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}`
  }

  get containerName(): string {
    return this.#name
  }

  get egressApplied(): boolean {
    return this.#egressApplied
  }

  async start(): Promise<void> {
    if (this.#containerIdValue) return
    const { engine, image } = this.#options
    const user = this.#options.user ?? "1000:1000"
    const [uid = "1000", gid = "1000"] = user.split(":")
    const argv = [
      engine, "run", "--detach", "--name", this.#name,
      "--network", this.#options.network ?? "cyrion-sandbox",
      "--read-only",
      "--user", user,
      "--tmpfs", `${CONTAINER_WORK_DIR}:rw,noexec,nosuid,size=256m,uid=${uid},gid=${gid}`,
      "--tmpfs", `/tmp:rw,noexec,nosuid,size=64m,uid=${uid},gid=${gid}`,
      "--env", `HOME=${CONTAINER_WORK_DIR}`,
      "--cap-drop", "ALL",
      ...(this.#options.addCapabilities ?? []).flatMap((capability) => ["--cap-add", capability]),
      "--security-opt", "no-new-privileges",
      "--memory", this.#options.memory ?? "2g",
      "--cpus", this.#options.cpus ?? "1",
      "--pids-limit", String(this.#options.pids ?? 256),
      "--workdir", CONTAINER_WORK_DIR,
      "--label", "cyrion.engagement=" + this.#options.engagementId,
      image, "sleep", "infinity",
    ]
    const result = await this.#engine(argv, 120_000)
    if (result.exitCode !== 0) {
      throw new Error(`Could not start the sandbox container: ${diagnostic(result)}`)
    }
    this.#containerIdValue = result.stdout.trim()
    await this.#applyEgress()
  }

  async lookup(binary: string): Promise<BinaryInfo | undefined> {
    if (this.#cache.has(binary)) return this.#cache.get(binary)
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(binary)) throw new Error(`Unsafe binary name: ${binary}`)
    await this.start()
    // No shell: asking the binary itself for a version proves it is executable,
    // and the engine says plainly when it is not present.
    let info: BinaryInfo | undefined
    for (const flag of VERSION_FLAGS) {
      const probe = await this.#exec([binary, flag], 15_000)
      const output = `${probe.stdout}${probe.stderr}`.trim()
      if (isMissingBinary(probe.exitCode, output)) break
      const version = versionLine(output)
      info = { name: binary, path: binary, ...(version ? { version } : {}) }
      if (version) break
    }
    this.#cache.set(binary, info)
    return info
  }

  async run(spec: CommandSpec, signal?: AbortSignal): Promise<CommandResult> {
    const [binary] = spec.argv
    if (!binary) throw new Error("A command needs a binary")
    if (!this.#allowed.has(binary)) throw new Error(`Binary is not allowed in this engagement: ${binary}`)
    await this.start()
    const info = await this.lookup(binary)
    if (!info) throw new Error(`${binary} is not present in ${this.#options.image}`)
    return this.#exec(spec.argv, spec.timeoutMs, spec.maxOutputBytes, spec.env, signal)
  }

  async close(): Promise<void> {
    if (!this.#containerIdValue) return
    await this.#engine([this.#options.engine, "rm", "--force", this.#name], 30_000).catch(() => undefined)
    this.#containerIdValue = undefined
  }

  report(): SandboxReport {
    return {
      kind: "container",
      ready: !!this.#containerIdValue,
      detail: `${this.#options.engine} container ${this.#name} from ${this.#options.image}`,
      enforced: [
        "capability allowlist and adapter-built argv",
        "read-only root filesystem with a tmpfs work directory",
        "no host mounts and no container engine socket",
        "all Linux capabilities dropped, no new privileges",
        "memory, CPU, and process ceilings",
        ...(this.#egressApplied ? ["kernel egress allowlist installed from the host"] : []),
      ],
      missing: this.#egressApplied ? [] : [`kernel egress allowlist (${this.#egressDetail})`],
    }
  }

  /**
   * Installs the allowlist into the container's network namespace from the
   * host. Requires nsenter and root; without them the operator is told what is
   * unenforced instead of being left to assume it worked.
   */
  async #applyEgress(): Promise<void> {
    const policy = this.#options.egress
    if (!policy) {
      this.#egressDetail = "no pinned destinations were supplied"
      if (!this.#options.allowUnfilteredEgress) {
        await this.close()
        throw new Error(
          "Refusing to run with unfiltered egress. Supply pinned destinations, or pass allowUnfilteredEgress "
          + "to accept that the container may reach any network this host can.",
        )
      }
      return
    }
    const pid = await this.#containerPid()
    if (!pid) {
      this.#egressDetail = "the container process id could not be read"
    } else if (!Bun.which("nsenter")) {
      this.#egressDetail = "nsenter is not installed on this host"
    } else {
      const rules = buildEgressRules(policy)
      for (const rule of rules) {
        const applied = await this.#engine(["nsenter", "-t", String(pid), "-n", ...rule], 15_000)
        if (applied.exitCode !== 0) {
          this.#egressDetail = `iptables refused a rule: ${diagnostic(applied)}`
          break
        }
        this.#egressApplied = true
      }
      if (this.#egressApplied) {
        this.#egressDetail = `${rules.length} rules installed`
        return
      }
    }
    if (!this.#options.allowUnfilteredEgress) {
      await this.close()
      throw new Error(
        `Refusing to run without a kernel egress allowlist: ${this.#egressDetail}.\n`
        + `Run as root with nsenter available, or accept the risk explicitly.\n`
        + `Rules that would have been installed:\n${describeEgressRules(buildEgressRules(policy))}`,
      )
    }
  }

  async #containerPid(): Promise<number | undefined> {
    const result = await this.#engine(
      [this.#options.engine, "inspect", "-f", "{{.State.Pid}}", this.#name],
      15_000,
    )
    const pid = Number(result.stdout.trim())
    return result.exitCode === 0 && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  }

  async #exec(
    argv: string[],
    timeoutMs: number,
    maxOutputBytes = 1_000_000,
    env: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    const environment = Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`])
    const result = await this.#engine(
      [this.#options.engine, "exec", "--workdir", CONTAINER_WORK_DIR, ...environment, this.#name, ...argv],
      timeoutMs,
      maxOutputBytes,
      signal,
    )
    return { ...result, argv, runner: this.kind }
  }

  async #engine(
    argv: string[],
    timeoutMs: number,
    maxOutputBytes = 1_000_000,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    return spawnBounded({
      argv,
      cwd: "/",
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
      timeoutMs,
      maxOutputBytes,
      runner: "container",
      ...(signal ? { signal } : {}),
    })
  }
}

/** The engine reports an absent binary as 126/127 with a recognizable message. */
function isMissingBinary(exitCode: number, output: string): boolean {
  if (exitCode !== 126 && exitCode !== 127) return false
  return /executable file not found|no such file or directory|not found/i.test(output)
}

function diagnostic(result: CommandResult): string {
  return `${result.stderr || result.stdout}`.trim().slice(0, 400) || `exit ${result.exitCode}`
}
