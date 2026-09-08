import { LocalToolRunner } from "./local"
import { spawnBounded } from "./process"
import type { ContainerEngine } from "./container"
import type { SandboxKind, SandboxReport } from "./types"

export interface HostProfile {
  /** From /etc/os-release, used to name the right install command. */
  distribution: string
  distributionId: string
  packageManager: "apt" | "dnf" | "pacman" | "zypper" | "apk" | "brew" | "unknown"
  /** True for distributions that ship the assessment toolchain already. */
  securityDistribution: boolean
  containerEngine?: ContainerEngine
  root: boolean
  nsenter: boolean
}

export async function detectHost(environment: NodeJS.ProcessEnv = process.env): Promise<HostProfile> {
  const release = await Bun.file("/etc/os-release").text().catch(() => "")
  const field = (key: string): string =>
    new RegExp(`^${key}="?([^"\\n]*)"?`, "m").exec(release)?.[1]?.trim() ?? ""
  const id = field("ID").toLowerCase()
  const like = field("ID_LIKE").toLowerCase()
  const platform = process.platform

  const containerEngine: ContainerEngine | undefined = Bun.which("docker")
    ? "docker"
    : Bun.which("podman") ? "podman" : undefined

  return {
    distribution: field("PRETTY_NAME") || (platform === "darwin" ? "macOS" : platform),
    distributionId: id || platform,
    packageManager: packageManagerFor(id, like, platform),
    securityDistribution: ["kali", "parrot", "blackarch", "backbox", "pentoo", "athena"].includes(id),
    ...(containerEngine ? { containerEngine } : {}),
    root: typeof process.getuid === "function" ? process.getuid() === 0 : false,
    nsenter: !!Bun.which("nsenter"),
  }
}

function packageManagerFor(id: string, like: string, platform: string): HostProfile["packageManager"] {
  const haystack = `${id} ${like}`
  if (platform === "darwin") return "brew"
  if (/\b(debian|ubuntu|kali|parrot|mint|pop)\b/.test(haystack)) return "apt"
  if (/\b(fedora|rhel|centos|rocky|alma)\b/.test(haystack)) return "dnf"
  if (/\b(arch|blackarch|manjaro)\b/.test(haystack)) return "pacman"
  if (/\b(suse|opensuse)\b/.test(haystack)) return "zypper"
  if (/\balpine\b/.test(haystack)) return "apk"
  return "unknown"
}

/** Whether a container engine can actually start something, not merely exist on PATH. */
export async function containerEngineReady(engine: ContainerEngine): Promise<{ ready: boolean; detail: string }> {
  const path = Bun.which(engine)
  if (!path) return { ready: false, detail: `${engine} is not installed` }
  const result = await spawnBounded({
    argv: [path, "version", "--format", "{{.Server.Version}}"],
    cwd: "/",
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
    timeoutMs: 15_000,
    maxOutputBytes: 8_192,
    runner: "container",
  }).catch(() => undefined)
  if (!result || result.exitCode !== 0) {
    return { ready: false, detail: `${engine} is installed but its daemon did not answer` }
  }
  return { ready: true, detail: `${engine} ${result.stdout.trim()}` }
}

/** Explains what a mode would give this operator, before anything runs. */
export async function describeSandbox(kind: SandboxKind, host: HostProfile): Promise<SandboxReport> {
  if (kind === "local") {
    const report = new LocalToolRunner({ allowedBinaries: [] }).report()
    return {
      ...report,
      detail: `${report.detail} Host: ${host.distribution}.`
        + (host.securityDistribution ? " Detected a security distribution." : ""),
    }
  }
  const engine = host.containerEngine
  if (!engine) {
    return {
      kind: "container",
      ready: false,
      detail: "No container engine was found. Install Docker or Podman, or use --sandbox local.",
      enforced: [],
      missing: ["container isolation", "kernel egress allowlist"],
    }
  }
  const status = await containerEngineReady(engine)
  const missing: string[] = []
  if (!status.ready) missing.push("container isolation")
  if (!host.nsenter) missing.push("kernel egress allowlist (nsenter is not installed)")
  else if (!host.root) missing.push("kernel egress allowlist (installing it needs root)")
  return {
    kind: "container",
    ready: status.ready && host.nsenter && host.root,
    detail: status.detail,
    enforced: status.ready
      ? [
        "read-only root filesystem with a tmpfs work directory",
        "no host mounts and no engine socket",
        "all Linux capabilities dropped",
        "memory, CPU, and process ceilings",
        ...(host.nsenter && host.root ? ["kernel egress allowlist installed from the host"] : []),
      ]
      : [],
    missing,
  }
}
