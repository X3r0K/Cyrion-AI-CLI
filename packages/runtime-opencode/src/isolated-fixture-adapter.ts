import { mkdtemp, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { tmpdir } from "node:os"
import type { ToolAdapter, ToolExecutionRequest } from "@cyrion/contracts"

const fixtureCapabilities = new Set(["fixture.read", "fixture.compare"])

export class IsolatedFixtureToolAdapter implements ToolAdapter {
  readonly #entrypoint: string
  readonly #targets: ReadonlySet<string>

  constructor(entrypoint: string, targets: readonly string[]) {
    this.#entrypoint = resolve(entrypoint)
    this.#targets = new Set(targets)
  }

  async execute(request: ToolExecutionRequest, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw signal.reason
    if (!fixtureCapabilities.has(request.capability)) throw new Error("Fixture worker capability rejected")
    if (!this.#targets.has(request.target)) throw new Error("Fixture worker target rejected")

    const workDirectory = await mkdtemp(`${tmpdir()}/cyrion-fixture-worker-`)
    const payload = JSON.stringify({
      engagementId: request.engagementId,
      taskId: request.taskId,
      agentId: request.agentId,
      capability: request.capability,
      target: request.target,
      input: request.input,
    })
    const child = Bun.spawn({
      cmd: [process.execPath, this.#entrypoint],
      cwd: workDirectory,
      env: {
        LANG: "C",
        NO_COLOR: "1",
        TMPDIR: workDirectory,
        CYRION_WORKER_KIND: "fixture",
      },
      stdin: new Blob([payload]),
      stdout: "pipe",
      stderr: "pipe",
    })
    const abort = (): void => child.kill("SIGTERM")
    signal.addEventListener("abort", abort, { once: true })

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        readLimited(child.stdout, request.maxOutputBytes, abort),
        readLimited(child.stderr, 8_192, abort),
        child.exited,
      ])
      if (signal.aborted) throw signal.reason
      if (exitCode !== 0) {
        throw new Error(`Fixture worker failed (${exitCode}): ${safeDiagnostic(stderr) || "no diagnostic"}`)
      }
      try {
        return JSON.parse(decode(stdout)) as unknown
      } catch {
        throw new Error("Fixture worker returned invalid JSON")
      }
    } catch (error) {
      abort()
      await child.exited.catch(() => undefined)
      if (signal.aborted) throw signal.reason
      throw error
    } finally {
      signal.removeEventListener("abort", abort)
      await rm(workDirectory, { recursive: true, force: true })
    }
  }
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  terminate: () => void,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) {
        terminate()
        throw new Error("Fixture worker output budget exceeded")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).trim()
}

function safeDiagnostic(bytes: Uint8Array): string {
  return decode(bytes).replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
}
