import { describe, expect, test } from "bun:test"
import {
  DEFAULT_ENGAGEMENT_LIMITS,
  manifestContractError,
  type EngagementLimits,
  type EngagementManifest,
  type TaskSpec,
  type ToolAdapter,
  type ToolExecutionRequest,
} from "@cyrion/contracts"
import { ScopedToolGateway, TargetLimiter, limitKeyFor } from "@cyrion/controller"

const limits: EngagementLimits = {
  minRequestGapMs: 40,
  maxConcurrentPerTarget: 2,
  maxRequestsPerTarget: 8,
  maxQueueWaitMs: 2_000,
}

function manifest(overrides: Partial<EngagementManifest> = {}): EngagementManifest {
  return {
    id: "ENG-LIMITS",
    name: "Pacing",
    objective: "Assess the approved fixture surface without overwhelming it.",
    profile: "web-api",
    mode: "autonomous",
    scope: {
      targets: ["demo.lab.test", "api.demo.lab.test", "https://app.lab.test/orders", "https://app.lab.test/invoices"],
      excluded: [],
      capabilities: ["fixture.read"],
    },
    budgets: {
      maxConcurrentAgents: 8,
      maxAgents: 12,
      maxDepth: 2,
      maxTasks: 40,
      maxDurationMs: 180_000,
      maxTokens: 50_000,
      maxCostUsd: 1,
    },
    limits,
    ...overrides,
  }
}

/** Reports the highest number of calls it ever saw running at once. */
class ConcurrencyProbe implements ToolAdapter {
  inFlight = 0
  peak = 0
  readonly starts: number[] = []
  constructor(private readonly holdMs = 20) {}
  async execute(_request: ToolExecutionRequest): Promise<unknown> {
    this.starts.push(Date.now())
    this.inFlight += 1
    this.peak = Math.max(this.peak, this.inFlight)
    try {
      await new Promise((resolve) => setTimeout(resolve, this.holdMs))
      return { ok: true }
    } finally {
      this.inFlight -= 1
    }
  }
}

function task(id: string, target: string): TaskSpec {
  return {
    id,
    key: id.toLowerCase(),
    role: "recon",
    objective: "Probe the approved surface.",
    target,
    capabilities: ["fixture.read"],
    dependencies: [],
    depth: 0,
    expectedOutput: "inventory",
  }
}

function bind(gateway: ScopedToolGateway, agentId: string, spec: TaskSpec) {
  return gateway.bind({
    engagementId: "ENG-LIMITS",
    agentId,
    task: spec,
    emit: () => {},
  })
}

function invoke(gateway: ScopedToolGateway, agentId: string, spec: TaskSpec) {
  return bind(gateway, agentId, spec).execute({
    capability: "fixture.read",
    target: spec.target,
    timeoutMs: 5_000,
    maxOutputBytes: 10_000,
    input: {},
  })
}

describe("what a limit is counted against", () => {
  test("two paths on one origin are one host", () => {
    expect(limitKeyFor("https://app.lab.test/orders")).toBe(limitKeyFor("https://app.lab.test/invoices"))
  })

  test("a bare host and a URL on it are one host", () => {
    expect(limitKeyFor("https://demo.lab.test/a")).toBe(limitKeyFor("demo.lab.test"))
  })

  test("different hosts are counted apart", () => {
    expect(limitKeyFor("demo.lab.test")).not.toBe(limitKeyFor("api.demo.lab.test"))
  })

  test("a repository reaches no host and is left unpaced", () => {
    expect(limitKeyFor("repo:./services/api")).toBeUndefined()
  })
})

describe("pacing one host", () => {
  test("holds requests to the stated gap", async () => {
    const limiter = new TargetLimiter(limits)
    const started = Date.now()
    for (let index = 0; index < 3; index += 1) {
      const lease = await limiter.acquire("demo.lab.test")
      lease.release()
    }
    // Three requests, two gaps between them.
    expect(Date.now() - started).toBeGreaterThanOrEqual(limits.minRequestGapMs * 2)
  })

  test("does not pace one host behind another", async () => {
    const limiter = new TargetLimiter({ ...limits, minRequestGapMs: 200 })
    const started = Date.now()
    await Promise.all([
      limiter.acquire("demo.lab.test").then((lease) => lease.release()),
      limiter.acquire("api.demo.lab.test").then((lease) => lease.release()),
    ])
    expect(Date.now() - started).toBeLessThan(200)
  })

  test("counts a repository target against nothing", async () => {
    const limiter = new TargetLimiter({ ...limits, minRequestGapMs: 500, maxRequestsPerTarget: 1 })
    const started = Date.now()
    for (let index = 0; index < 4; index += 1) {
      const lease = await limiter.acquire("repo:./services/api")
      lease.release()
    }
    expect(Date.now() - started).toBeLessThan(500)
  })

  test("refuses a host that has spent its request ceiling, and names the limit", async () => {
    const limiter = new TargetLimiter({ ...limits, minRequestGapMs: 0, maxRequestsPerTarget: 2 })
    for (let index = 0; index < 2; index += 1) {
      const lease = await limiter.acquire("demo.lab.test")
      lease.release()
    }
    await expect(limiter.acquire("demo.lab.test")).rejects.toThrow(/maxRequestsPerTarget/)
  })

  test("refuses rather than queueing for longer than the operator allowed", async () => {
    const limiter = new TargetLimiter({
      minRequestGapMs: 0,
      maxConcurrentPerTarget: 1,
      maxRequestsPerTarget: 100,
      maxQueueWaitMs: 30,
    })
    const held = await limiter.acquire("demo.lab.test")
    await expect(limiter.acquire("demo.lab.test")).rejects.toThrow(/maxConcurrentPerTarget/)
    held.release()
  })

  test("a released slot is handed to the next caller in turn", async () => {
    const limiter = new TargetLimiter({ ...limits, minRequestGapMs: 0, maxConcurrentPerTarget: 1 })
    const order: string[] = []
    const first = await limiter.acquire("demo.lab.test")
    const second = limiter.acquire("demo.lab.test").then((lease) => {
      order.push("second")
      lease.release()
    })
    const third = limiter.acquire("demo.lab.test").then((lease) => {
      order.push("third")
      lease.release()
    })
    first.release()
    await Promise.all([second, third])
    expect(order).toEqual(["second", "third"])
  })
})

describe("the swarm the budgets do not catch", () => {
  test("holds every agent to one host's concurrency cap", async () => {
    const probe = new ConcurrencyProbe()
    const gateway = new ScopedToolGateway(manifest(), { "fixture.read": probe })
    // Six agents, each inside every engagement budget, all aimed at one host.
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        invoke(gateway, `AGENT-${index}`, task(`T-${index}`, "demo.lab.test")),
      ),
    )
    expect(probe.peak).toBeLessThanOrEqual(limits.maxConcurrentPerTarget)
    expect(probe.starts).toHaveLength(6)
  })

  test("a planner naming more paths does not buy more of one host", async () => {
    const probe = new ConcurrencyProbe()
    const gateway = new ScopedToolGateway(manifest(), { "fixture.read": probe })
    await Promise.all([
      invoke(gateway, "AGENT-A", task("T-A", "https://app.lab.test/orders")),
      invoke(gateway, "AGENT-B", task("T-B", "https://app.lab.test/invoices")),
      invoke(gateway, "AGENT-C", task("T-C", "https://app.lab.test/orders")),
      invoke(gateway, "AGENT-D", task("T-D", "https://app.lab.test/invoices")),
    ])
    expect(probe.peak).toBeLessThanOrEqual(limits.maxConcurrentPerTarget)
  })

  test("records the wait so the operator can account for the time", async () => {
    const events: { type: string; payload: Record<string, unknown> }[] = []
    const gateway = new ScopedToolGateway(manifest(), { "fixture.read": new ConcurrencyProbe(5) })
    const spec = task("T-WAIT", "demo.lab.test")
    const emit = (type: string, payload: unknown): void => {
      events.push({ type, payload: payload as Record<string, unknown> })
    }
    const first = gateway.bind({ engagementId: "ENG-LIMITS", agentId: "AGENT-1", task: spec, emit })
    const second = gateway.bind({ engagementId: "ENG-LIMITS", agentId: "AGENT-2", task: spec, emit })
    const call = { capability: "fixture.read", target: spec.target, timeoutMs: 5_000, maxOutputBytes: 10_000, input: {} }
    await first.execute(call)
    await second.execute(call)
    const accepted = events.filter((event) => event.type === "tool.request.accepted")
    expect(accepted).toHaveLength(2)
    expect(accepted[1]?.payload.waitedMs).toBeGreaterThan(0)
  })

  test("frees the slot when the tool fails", async () => {
    let calls = 0
    const failing: ToolAdapter = {
      async execute(): Promise<unknown> {
        calls += 1
        throw new Error("tool blew up")
      },
    }
    const gateway = new ScopedToolGateway(manifest(), { "fixture.read": failing })
    const spec = task("T-FAIL", "demo.lab.test")
    // More failures than the concurrency cap. A slot leaked by a throwing tool
    // would hold the third call until the queue wait expired and refuse it for
    // the wrong reason, rather than letting it reach the adapter at all.
    for (let index = 0; index < 4; index += 1) {
      await expect(invoke(gateway, `AGENT-${index}`, spec)).rejects.toThrow(/tool blew up/)
    }
    expect(calls).toBe(4)
  })

  test("refuses a call past the host ceiling and records it as a rejection", async () => {
    const events: { type: string; payload: Record<string, unknown> }[] = []
    const value = manifest({ limits: { ...limits, minRequestGapMs: 0, maxRequestsPerTarget: 1 } })
    const gateway = new ScopedToolGateway(value, { "fixture.read": new ConcurrencyProbe(1) })
    const spec = task("T-CEIL", "demo.lab.test")
    const emit = (type: string, payload: unknown): void => {
      events.push({ type, payload: payload as Record<string, unknown> })
    }
    const gate = gateway.bind({ engagementId: "ENG-LIMITS", agentId: "AGENT-1", task: spec, emit })
    const call = { capability: "fixture.read", target: spec.target, timeoutMs: 5_000, maxOutputBytes: 10_000, input: {} }
    await gate.execute(call)
    await expect(gate.execute(call)).rejects.toThrow(/maxRequestsPerTarget/)
    const rejected = events.filter((event) => event.type === "tool.request.rejected")
    expect(rejected).toHaveLength(1)
    expect(String(rejected[0]?.payload.reason)).toMatch(/demo\.lab\.test/)
  })
})

describe("limits in the manifest", () => {
  test("a manifest that states none is paced by the default", () => {
    const value = manifest()
    delete value.limits
    expect(manifestContractError(value)).toBeUndefined()
    const gateway = new ScopedToolGateway(value, {})
    expect(gateway.limits).toEqual(DEFAULT_ENGAGEMENT_LIMITS)
  })

  test("the default is a pace, not a formality", () => {
    expect(DEFAULT_ENGAGEMENT_LIMITS.minRequestGapMs).toBeGreaterThan(0)
    expect(DEFAULT_ENGAGEMENT_LIMITS.maxConcurrentPerTarget).toBeLessThanOrEqual(8)
  })

  test("refuses a partial limits block rather than filling in the rest", () => {
    const value = manifest({ limits: { minRequestGapMs: 10 } as unknown as EngagementLimits })
    expect(manifestContractError(value)).toMatch(/maxConcurrentPerTarget is required/)
  })

  test("refuses a concurrency cap wide enough to be meaningless", () => {
    const value = manifest({ limits: { ...limits, maxConcurrentPerTarget: 500 } })
    expect(manifestContractError(value)).toMatch(/maxConcurrentPerTarget cannot exceed 64/)
  })

  test("refuses a negative gap", () => {
    const value = manifest({ limits: { ...limits, minRequestGapMs: -1 } })
    expect(manifestContractError(value)).toMatch(/minRequestGapMs/)
  })

  test("refuses an unknown pacing field", () => {
    const value = manifest({ limits: { ...limits, burst: 10 } as unknown as EngagementLimits })
    expect(manifestContractError(value)).toMatch(/unexpected field burst/)
  })
})
