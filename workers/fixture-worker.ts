#!/usr/bin/env bun

const maximumInputBytes = 65_536
const allowedCapabilities = new Set(["fixture.read", "fixture.compare"])
const allowedTargets = new Set(["demo.lab.test", "api.demo.lab.test"])

interface FixtureWorkerRequest {
  engagementId: string
  taskId: string
  agentId: string
  capability: string
  target: string
  input?: unknown
}

try {
  const raw = await Bun.stdin.text()
  if (new TextEncoder().encode(raw).byteLength > maximumInputBytes) throw new Error("Worker input budget exceeded")
  const request = JSON.parse(raw) as Partial<FixtureWorkerRequest>
  if (!validIdentity(request.engagementId) || !validIdentity(request.taskId) || !validIdentity(request.agentId)) {
    throw new Error("Worker identity envelope rejected")
  }
  if (!request.capability || !allowedCapabilities.has(request.capability)) throw new Error("Worker capability rejected")
  if (!request.target || !allowedTargets.has(request.target)) throw new Error("Worker target rejected")

  const options = isRecord(request.input) ? request.input : {}
  const delayMs = boundedInteger(options.delayMs, 0, 5_000) ?? 0
  if (delayMs) await Bun.sleep(delayMs)
  const paddingBytes = boundedInteger(options.paddingBytes, 0, 2_000_000) ?? 0

  process.stdout.write(JSON.stringify({
    fixture: "demo",
    target: request.target,
    capability: request.capability,
    accepted: true,
    environmentKeys: Object.keys(Bun.env).sort(),
    ...(paddingBytes ? { padding: "x".repeat(paddingBytes) } : {}),
  }))
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum ? Number(value) : undefined
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
}
