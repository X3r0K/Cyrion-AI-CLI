import type { HostProfile } from "./detect"

export type PackageManager = HostProfile["packageManager"]

export interface ToolRequirement {
  /** Cyrion capability this tool backs. */
  capability: string
  /** Empty when the capability is implemented in Cyrion itself. */
  binary: string
  purpose: string
  /** Package name per manager. Absent means the tool is not packaged there. */
  packages: Partial<Record<PackageManager, string>>
  /** Present in the Cyrion worker image. */
  inImage: boolean
  /** How to get it when no package exists. */
  note?: string
  optional?: boolean
}

/**
 * What each capability needs on the machine that will run it.
 *
 * Capabilities with an empty `binary` are implemented inside Cyrion, so they
 * work on any host with nothing installed — which is what makes `--sandbox
 * local` useful before an operator installs a toolchain at all.
 */
export const toolCatalog: readonly ToolRequirement[] = [
  {
    capability: "http.probe",
    binary: "",
    purpose: "Status, headers, and technology hints for an approved URL",
    packages: {},
    inImage: true,
  },
  {
    capability: "http.request",
    binary: "",
    purpose: "One typed request and response, captured as evidence",
    packages: {},
    inImage: true,
  },
  {
    capability: "dns.lookup",
    binary: "",
    purpose: "Resolve an approved host and pin its addresses",
    packages: {},
    inImage: true,
  },
  {
    capability: "repo.inventory",
    binary: "",
    purpose: "Languages, entry points, and routes in an approved repository",
    packages: {},
    inImage: true,
  },
  {
    capability: "net.portscan",
    binary: "nmap",
    purpose: "Port and service discovery inside an approved range",
    packages: { apt: "nmap", dnf: "nmap", pacman: "nmap", zypper: "nmap", apk: "nmap", brew: "nmap" },
    inImage: true,
  },
  {
    capability: "net.tls",
    binary: "openssl",
    purpose: "Certificate and protocol inventory for an approved endpoint",
    packages: { apt: "openssl", dnf: "openssl", pacman: "openssl", zypper: "openssl", apk: "openssl", brew: "openssl" },
    inImage: true,
  },
  {
    capability: "poc.run",
    binary: "curl",
    purpose: "Replay a bounded proof of concept against an approved URL and bundle the result",
    packages: { apt: "curl", dnf: "curl", pacman: "curl", zypper: "curl", apk: "curl", brew: "curl" },
    inImage: true,
  },
  {
    capability: "web.fuzz",
    binary: "ffuf",
    purpose: "Bounded content discovery against an approved URL",
    packages: { apt: "ffuf", pacman: "ffuf", brew: "ffuf" },
    inImage: true,
    note: "On Debian or Ubuntu: go install github.com/ffuf/ffuf/v2@latest",
    optional: true,
  },
  {
    capability: "http.crawl",
    binary: "katana",
    purpose: "Endpoint discovery within an approved origin",
    packages: { brew: "katana" },
    inImage: true,
    note: "go install github.com/projectdiscovery/katana/cmd/katana@latest",
    optional: true,
  },
  {
    capability: "dns.enum",
    binary: "dnsx",
    purpose: "Resolve and enumerate approved DNS records",
    packages: { brew: "dnsx" },
    inImage: true,
    note: "go install github.com/projectdiscovery/dnsx/cmd/dnsx@latest",
    optional: true,
  },
  {
    capability: "repo.scan",
    binary: "semgrep",
    purpose: "Static analysis over an approved repository with public rules",
    packages: { apt: "semgrep", brew: "semgrep" },
    inImage: true,
    note: "pipx install semgrep",
    optional: true,
  },
  {
    capability: "repo.deps",
    binary: "grype",
    purpose: "Known-vulnerable dependencies in an approved repository",
    packages: { brew: "grype" },
    inImage: true,
    note: "https://github.com/anchore/grype#installation",
    optional: true,
  },
]

export function requirementFor(capability: string): ToolRequirement | undefined {
  return toolCatalog.find((tool) => tool.capability === capability)
}

/** Distinct binaries a set of capabilities needs, ignoring built-in ones. */
export function binariesFor(capabilities: readonly string[]): string[] {
  return [...new Set(
    capabilities
      .map((capability) => requirementFor(capability)?.binary)
      .filter((binary): binary is string => !!binary),
  )]
}

export interface InstallPlan {
  manager: PackageManager
  /** Ready to paste. Empty when nothing is missing. */
  command: string
  packaged: ToolRequirement[]
  /** Missing tools this manager cannot install; each carries its own note. */
  manual: ToolRequirement[]
}

export function installPlan(missing: readonly ToolRequirement[], manager: PackageManager): InstallPlan {
  const packaged = missing.filter((tool) => tool.packages[manager])
  const manual = missing.filter((tool) => !tool.packages[manager])
  const names = [...new Set(packaged.map((tool) => tool.packages[manager]!))].sort()
  return { manager, command: names.length ? `${installPrefix(manager)} ${names.join(" ")}` : "", packaged, manual }
}

function installPrefix(manager: PackageManager): string {
  if (manager === "apt") return "sudo apt-get install -y"
  if (manager === "dnf") return "sudo dnf install -y"
  if (manager === "pacman") return "sudo pacman -S --needed"
  if (manager === "zypper") return "sudo zypper install -y"
  if (manager === "apk") return "sudo apk add"
  if (manager === "brew") return "brew install"
  return "install"
}
