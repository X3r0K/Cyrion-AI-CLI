import { describe, expect, test } from "bun:test"
import type { ScopePolicy } from "@cyrion/contracts"
import {
  CapabilityRegistry,
  needsUnboundedRunner,
  parseFfuf,
  parseNuclei,
  parseSqlmapTechniques,
} from "@cyrion/capabilities"
import { MemoryEvidenceStore } from "@cyrion/evidence"
import { LocalToolRunner } from "@cyrion/sandbox"

const scope: ScopePolicy = {
  targets: ["https://app.lab.test/"],
  excluded: [],
  capabilities: ["shell.exec", "python.exec"],
}

function registry(capabilities: string[], allowAnyBinary = true) {
  return new CapabilityRegistry({
    runner: new LocalToolRunner({ allowedBinaries: [], allowAnyBinary }),
    scope: { ...scope, capabilities },
    evidence: new MemoryEvidenceStore(),
    capabilities,
  })
}

function request(capability: string, input: Record<string, unknown>) {
  return {
    engagementId: "ENG-SHELL",
    taskId: "T-1",
    agentId: "web-1",
    capability,
    target: "https://app.lab.test/",
    timeoutMs: 20_000,
    maxOutputBytes: 500_000,
    input,
  }
}

describe("a shell the agent writes into", () => {
  test("runs the command and hands back what it produced", async () => {
    const result = await registry(["shell.exec"]).execute(
      request("shell.exec", { command: "echo cyrion-was-here && exit 0" }),
      new AbortController().signal,
    )
    const summary = result.summary as { stdout: string; exitCode: number; runner: string }
    expect(summary.stdout).toContain("cyrion-was-here")
    expect(summary.exitCode).toBe(0)
    expect(summary.runner).toBe("local")
  })

  test("a command that failed is still the account of what was tried", async () => {
    const result = await registry(["shell.exec"]).execute(
      request("shell.exec", { command: "echo to-stderr 1>&2; exit 7" }),
      new AbortController().signal,
    )
    const summary = result.summary as { exitCode: number; stderr: string }
    // Not an exception: a non-zero exit is information, and the evidence for it
    // is captured exactly as a successful one would be.
    expect(summary.exitCode).toBe(7)
    expect(summary.stderr).toContain("to-stderr")
    expect(result.evidence).toHaveLength(1)
    expect(result.outcome).toContain("exit 7")
  })

  test("the command and its output are evidence before the summary returns", async () => {
    const evidence = new MemoryEvidenceStore()
    const capabilities = ["shell.exec"]
    const registry = new CapabilityRegistry({
      runner: new LocalToolRunner({ allowedBinaries: [], allowAnyBinary: true }),
      scope: { ...scope, capabilities },
      evidence,
      capabilities,
    })
    const result = await registry.execute(
      request("shell.exec", { command: "echo recorded" }),
      new AbortController().signal,
    )
    const stored = new TextDecoder().decode(await evidence.read(result.evidence[0]!))
    expect(stored).toContain("$ echo recorded")
    expect(stored).toContain("recorded")
  })

  test("refuses an empty command, and one too large to have been meant", async () => {
    const shell = registry(["shell.exec"])
    expect(shell.execute(request("shell.exec", {}), new AbortController().signal))
      .rejects.toThrow(/needs a command/)
    // Truncating would run a command nobody wrote.
    expect(shell.execute(
      request("shell.exec", { command: "x".repeat(20_000) }),
      new AbortController().signal,
    )).rejects.toThrow(/exceeds 16384 bytes/)
  })

  test("stays refused when the manifest never granted it", async () => {
    expect(registry(["http.probe"]).execute(
      request("shell.exec", { command: "echo no" }),
      new AbortController().signal,
    )).rejects.toThrow(/shell\.exec/)
  })

  test("cannot run at all when the runner's allowlist still binds", async () => {
    // The lifted allowlist is a decision the caller makes from the granted
    // capabilities, not something the adapter can arrange for itself.
    expect(registry(["shell.exec"], false).execute(
      request("shell.exec", { command: "echo blocked" }),
      new AbortController().signal,
    )).rejects.toThrow(/not allowed in this engagement/)
  })
})

describe("a language to write exploits in", () => {
  test("runs the code and stores it as the artifact it is", async () => {
    const evidence = new MemoryEvidenceStore()
    const capabilities = ["python.exec"]
    const registry = new CapabilityRegistry({
      runner: new LocalToolRunner({ allowedBinaries: [], allowAnyBinary: true }),
      scope: { ...scope, capabilities },
      evidence,
      capabilities,
    })
    const code = "print('owner=' + str(1 + 1))"
    const result = await registry.execute(request("python.exec", { code }), new AbortController().signal)
    const summary = result.summary as { stdout: string; exitCode: number }
    expect(summary.stdout).toContain("owner=2")
    expect(summary.exitCode).toBe(0)

    const stored = new TextDecoder().decode(await evidence.read(result.evidence[0]!))
    // The exploit that ran, not a description of one: a client can re-run this.
    expect(stored).toContain(code)
    expect(result.evidence[0]!.kind).toBe("poc")
  })

  test("a traceback is a result, not a crash", async () => {
    const result = await registry(["python.exec"]).execute(
      request("python.exec", { code: "raise SystemExit(3)" }),
      new AbortController().signal,
    )
    expect((result.summary as { exitCode: number }).exitCode).toBe(3)
  })
})

describe("which capabilities the allowlist cannot bound", () => {
  test("names the two that have no fixed binary", () => {
    expect(needsUnboundedRunner(["http.probe", "net.portscan"])).toBe(false)
    expect(needsUnboundedRunner(["http.probe", "shell.exec"])).toBe(true)
    expect(needsUnboundedRunner(["python.exec"])).toBe(true)
  })
})

describe("reading what the scanners say", () => {
  test("ffuf's report, past the banner some builds print", () => {
    const hits = parseFfuf(`ffuf v2.1.0\n{"results":[
      {"input":{"FUZZ":"admin"},"status":200,"length":1234},
      {"input":{"FUZZ":"backup"},"status":403,"length":9}
    ]}`)
    expect(hits).toHaveLength(2)
    expect(hits[0]).toEqual({ path: "admin", status: 200, length: 1234 })
    expect(parseFfuf("no json here")).toEqual([])
  })

  test("nuclei's JSONL, ignoring anything that is not an object", () => {
    const matches = parseNuclei([
      "[INF] Templates loaded",
      '{"template-id":"tech-detect","info":{"name":"Nginx","severity":"info"},"matched-at":"https://a.test/"}',
      "not json",
      '{"template-id":"CVE-2021-1","info":{"name":"RCE","severity":"critical"},"matched-at":"https://a.test/x"}',
    ].join("\n"))
    expect(matches).toHaveLength(2)
    expect(matches[1]?.severity).toBe("critical")
    expect(matches[1]?.templateId).toBe("CVE-2021-1")
  })

  test("which sqlmap techniques actually worked", () => {
    const techniques = parseSqlmapTechniques([
      "sqlmap identified the following injection point",
      "    Type: boolean-based blind",
      "    Title: AND boolean-based blind - WHERE clause",
      "    Type: time-based blind",
    ].join("\n"))
    expect(techniques).toEqual(["boolean-based blind", "time-based blind"])
    expect(parseSqlmapTechniques("nothing found")).toEqual([])
  })
})
