import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import {
  LocalToolRunner,
  buildEgressRules,
  detectHost,
  describeEgressRules,
  egressFromPins,
  installPlan,
  requirementFor,
  scrubbedEnvironment,
  toolCatalog,
} from "@cyrion/sandbox"
import { pinAddresses } from "@cyrion/scope"

const runner = (binaries: string[]): LocalToolRunner => new LocalToolRunner({ allowedBinaries: binaries })

describe("local tool runner", () => {
  test("runs an allowed binary and returns bounded output", async () => {
    const result = await runner(["echo"]).run({ argv: ["echo", "cyrion"], timeoutMs: 5_000, maxOutputBytes: 1_024 })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe("cyrion")
    expect(result.runner).toBe("local")
    expect(result.truncated).toBe(false)
  })

  test("refuses a binary the engagement never allowed", async () => {
    expect(runner(["echo"]).run({ argv: ["env", "-"], timeoutMs: 1_000, maxOutputBytes: 512 }))
      .rejects.toThrow(/not allowed in this engagement/)
  })

  test("says plainly when a tool is not installed", async () => {
    expect(runner(["definitely-not-a-real-tool"]).run({
      argv: ["definitely-not-a-real-tool"],
      timeoutMs: 1_000,
      maxOutputBytes: 512,
    })).rejects.toThrow(/not installed on this machine/)
  })

  test("truncates output at the ceiling instead of buffering without limit", async () => {
    const result = await runner(["head"]).run({
      argv: ["head", "-c", "100000", "/dev/zero"],
      timeoutMs: 10_000,
      maxOutputBytes: 2_048,
    })
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(2_048)
  })

  test("stops a process that outlives its timeout", async () => {
    const started = performance.now()
    const result = await runner(["sleep"]).run({ argv: ["sleep", "30"], timeoutMs: 700, maxOutputBytes: 512 })
    expect(result.timedOut).toBe(true)
    expect(performance.now() - started).toBeLessThan(10_000)
  })

  test("hands the tool a scrubbed environment, never the operator's", async () => {
    process.env.CYRION_TEST_SECRET = "should-not-be-visible"
    try {
      const result = await runner(["env"]).run({ argv: ["env"], timeoutMs: 5_000, maxOutputBytes: 16_384 })
      expect(result.stdout).not.toContain("should-not-be-visible")
      expect(result.stdout).toContain("CYRION_WORKER=1")
      expect(result.stdout).toContain("LANG=C")
    } finally {
      delete process.env.CYRION_TEST_SECRET
    }
  })

  test("removes the private working directory after the run", async () => {
    const before = (await readdir(tmpdir())).filter((entry) => entry.startsWith("cyrion-work-")).length
    await runner(["echo"]).run({ argv: ["echo", "x"], timeoutMs: 5_000, maxOutputBytes: 512 })
    const after = (await readdir(tmpdir())).filter((entry) => entry.startsWith("cyrion-work-")).length
    expect(after).toBe(before)
  })

  test("reports what it enforces and what it cannot", () => {
    const report = runner([]).report()
    expect(report.kind).toBe("local")
    expect(report.enforced.join(" ")).toContain("scrubbed environment")
    expect(report.missing.join(" ")).toContain("egress")
  })

  test("scrubbed environment carries no credential-shaped values", () => {
    const environment = scrubbedEnvironment("/tmp/work")
    expect(Object.keys(environment).sort()).toEqual([
      "CYRION_WORKER", "HOME", "LANG", "LC_ALL", "NO_COLOR", "PATH", "TMPDIR",
    ])
  })
})

describe("egress allowlist", () => {
  test("starts from deny and admits only pinned destinations", () => {
    const rules = buildEgressRules({
      destinations: [{ address: "10.10.0.5", ports: "80,8000-8100" }, { address: "10.10.0.6" }],
      resolver: "10.10.0.1",
    })
    const text = describeEgressRules(rules)
    expect(rules[0]).toEqual(["iptables", "-P", "OUTPUT", "DROP"])
    expect(text).toContain("-o lo -j ACCEPT")
    expect(text).toContain("-d 10.10.0.1 -p udp --dport 53")
    expect(text).toContain("-d 10.10.0.5 -p tcp --dport 80")
    expect(text).toContain("-d 10.10.0.5 -p tcp --dport 8000:8100")
    expect(text).toContain("-d 10.10.0.6 -j ACCEPT")
    expect(text).not.toContain("0.0.0.0/0 -j ACCEPT")
  })

  test("derives destinations from pins and the ports their scope entry allows", () => {
    const policy = { targets: ["10.10.0.0/24:443"], excluded: [], capabilities: [] }
    const pins = [pinAddresses("app.lab.test", ["10.10.0.5", "10.10.0.6"]), pinAddresses("other.test", ["8.8.8.8"])]
    const egress = egressFromPins(policy, pins)
    // 8.8.8.8 was pinned for a host that is not in scope, so it must not reach the allowlist.
    expect(egress.destinations).toEqual([
      { address: "10.10.0.5", ports: "443" },
      { address: "10.10.0.6", ports: "443" },
    ])
    expect(describeEgressRules(buildEgressRules(egress))).not.toContain("8.8.8.8")
  })
})

describe("host tooling", () => {
  test("maps each capability to the package that provides it", () => {
    expect(requirementFor("net.portscan")?.binary).toBe("nmap")
    expect(requirementFor("http.probe")?.binary).toBe("")
    const plan = installPlan([requirementFor("net.portscan")!, requirementFor("http.crawl")!], "apt")
    expect(plan.command).toBe("sudo apt-get install -y nmap")
    expect(plan.manual.map((tool) => tool.binary)).toEqual(["katana"])
    expect(installPlan([requirementFor("net.portscan")!], "pacman").command).toBe("sudo pacman -S --needed nmap")
    expect(installPlan([], "apt").command).toBe("")
  })

  test("every catalog entry names a purpose and an install route or is built in", () => {
    for (const tool of toolCatalog) {
      expect(tool.purpose.length).toBeGreaterThan(10)
      if (!tool.binary) continue
      const routes = Object.keys(tool.packages).length + (tool.note ? 1 : 0)
      expect(routes).toBeGreaterThan(0)
    }
  })

  test("detects the host well enough to choose a default mode", async () => {
    const host = await detectHost()
    expect(host.distribution.length).toBeGreaterThan(0)
    expect(["apt", "dnf", "pacman", "zypper", "apk", "brew", "unknown"]).toContain(host.packageManager)
    expect(typeof host.root).toBe("boolean")
  })
})
