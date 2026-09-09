import { describe, expect, test } from "bun:test"
import type { EngagementSnapshot, TaskRecord } from "@cyrion/contracts"
import { activeCount, delegationTree, shortTarget, treeDepth, treePrefix } from "../apps/cli/src/delegation"
import { formatSwarm } from "../apps/cli/src/format"

function task(over: Partial<TaskRecord>): TaskRecord {
  return {
    id: "T-1", key: "k", role: "web", objective: "Assess it.", target: "https://app.lab.test/",
    capabilities: ["http.probe"], dependencies: [], depth: 1, expectedOutput: "assessment",
    status: "completed", inputHash: "h", attempt: 1, agentId: "web-1", ...over,
  } as TaskRecord
}

/** Root delegates recon and web; web spawns injection; injection spawns authz. */
function graph(): EngagementSnapshot {
  const tasks: TaskRecord[] = [
    task({ id: "T-RECON", key: "recon", role: "recon", expectedOutput: "inventory", agentId: "recon-1" }),
    task({ id: "T-WEB", key: "web", role: "web", agentId: "web-1", status: "running" }),
    task({
      id: "T-INJ", key: "inj", role: "injection", parentTaskId: "T-WEB", depth: 2,
      agentId: "inj-1", status: "running", target: "https://app.lab.test/login",
    }),
    task({
      id: "T-AUTHZ", key: "authz", role: "authz", parentTaskId: "T-INJ", depth: 3,
      agentId: "authz-1", status: "queued",
    }),
    task({ id: "T-VAL", key: "val", role: "validator", expectedOutput: "validation", agentId: "val-1" }),
  ]
  return {
    manifest: { id: "ENG-T", scope: { targets: [], excluded: [], capabilities: [] } },
    status: "running",
    agents: [
      { id: "root-agent", role: "root", name: "root-agent", status: "running" },
      { id: "recon-1", role: "recon", name: "recon-01", status: "completed" },
      { id: "web-1", role: "web", name: "web-01", status: "running" },
      { id: "inj-1", role: "injection", name: "injection-01", status: "running" },
      { id: "authz-1", role: "authz", name: "authz-01", status: "queued" },
      { id: "val-1", role: "validator", name: "validator-01", status: "completed" },
    ],
    tasks,
    observations: [],
    findings: [{ id: "F-1", discoveredBy: "recon-1" }],
    evidence: [],
    events: [{
      type: "tool.request.accepted", taskId: "T-INJ", sequence: 1,
      payload: { capability: "sqli.test", target: "https://app.lab.test/login?id=1" },
    }],
    budgetUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  } as unknown as EngagementSnapshot
}

describe("who asked for whom", () => {
  const nodes = delegationTree(graph())

  test("nests a spawned task under the task that asked for it", () => {
    const byId = Object.fromEntries(nodes.map((node) => [node.taskId, node]))
    expect(byId["T-RECON"]?.depth).toBe(1)
    expect(byId["T-WEB"]?.depth).toBe(1)
    // The whole point: a specialist sits under its parent, not in a flat roster
    // where the connection has to be reconstructed from identifiers.
    expect(byId["T-INJ"]?.depth).toBe(2)
    expect(byId["T-AUTHZ"]?.depth).toBe(3)
    expect(byId["T-INJ"]?.spawned).toBe(true)
    expect(byId["T-RECON"]?.spawned).toBe(false)
  })

  test("draws depth-first, so a child follows its parent immediately", () => {
    const order = nodes.map((node) => node.taskId)
    expect(order.indexOf("T-INJ")).toBe(order.indexOf("T-WEB") + 1)
    expect(order.indexOf("T-AUTHZ")).toBe(order.indexOf("T-INJ") + 1)
  })

  test("carries the vertical rule only through ancestors that continue", () => {
    const byId = Object.fromEntries(nodes.map((node) => [node.taskId, node]))
    // T-WEB is not the last root (T-VAL follows), so its subtree keeps a rule.
    expect(treePrefix(byId["T-INJ"]!)).toBe("│  └─")
    expect(treePrefix(byId["T-AUTHZ"]!)).toBe("│     └─")
    // The last root has nothing below it to connect to.
    expect(treePrefix(byId["T-VAL"]!)).toBe("└─")
  })

  test("counts what is running and how deep the graph reached", () => {
    expect(activeCount(nodes)).toBe(2)
    expect(treeDepth(nodes)).toBe(3)
  })
})

describe("what each agent is doing", () => {
  const nodes = delegationTree(graph())
  const byId = Object.fromEntries(nodes.map((node) => [node.taskId, node]))

  test("a running agent shows its current tool call, not its objective", () => {
    // "What is it doing to my site right now" is the question a live view answers.
    expect(byId["T-INJ"]?.activity).toBe("sqli.test /login?id=1")
  })

  test("a finished agent shows what it produced", () => {
    expect(byId["T-RECON"]?.activity).toBe("1 finding")
    expect(byId["T-VAL"]?.activity).toBe("done")
    expect(byId["T-AUTHZ"]?.activity).toBe("queued")
  })

  test("a target reads as the path an operator recognizes", () => {
    expect(shortTarget("https://app.lab.test/api/objects/42")).toBe("/api/objects/42")
    expect(shortTarget("https://app.lab.test/")).toBe("app.lab.test")
    expect(shortTarget("not a url")).toBe("not a url")
  })
})

describe("the tree on screen", () => {
  const plain = (value: { chunks: Array<{ text: string }> }): string =>
    value.chunks.map((chunk) => chunk.text).join("")

  test("stays inside its pane at 84, 100 and 168 columns", () => {
    for (const terminal of [84, 100, 168]) {
      // The side pane is roughly a third of the terminal.
      const width = Math.max(24, Math.floor(terminal / 3))
      const lines = plain(formatSwarm(graph(), "T-INJ", width)).split("\n")
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(width)
    }
  })

  test("drops the depth label rather than overrunning a narrow pane", () => {
    // The depth is the least important of the three counts, so it is what
    // gives way when the footer will not fit.
    expect(plain(formatSwarm(graph(), "T-INJ", 28))).not.toContain("depth 3")
    expect(plain(formatSwarm(graph(), "T-INJ", 40))).toContain("depth 3")
  })

  test("shows the branch, the roles and the depth reached", () => {
    const output = plain(formatSwarm(graph(), "T-INJ", 40))
    expect(output).toContain("injection")
    expect(output).toContain("authz")
    expect(output).toContain("└─")
    expect(output).toContain("│")
    expect(output).toContain("depth 3")
    expect(output).toMatch(/2 active {2}\/ {2}5 agents/)
  })
})
