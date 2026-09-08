import type { CommandResult, SandboxKind } from "./types"

export interface SpawnOptions {
  argv: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  maxOutputBytes: number
  runner: SandboxKind
  signal?: AbortSignal
}

/**
 * Runs one process with a hard timeout, bounded output, and no shell. The whole
 * process group is terminated on timeout or cancellation, so a tool that forks
 * cannot outlive its task.
 */
export async function spawnBounded(options: SpawnOptions): Promise<CommandResult> {
  const started = performance.now()
  const child = Bun.spawn({
    cmd: options.argv,
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  let timedOut = false
  const terminate = (): void => {
    try {
      // Negative PID targets the group, so children die with the parent.
      process.kill(-child.pid, "SIGKILL")
    } catch {
      child.kill("SIGKILL")
    }
  }
  const timer = setTimeout(() => {
    timedOut = true
    terminate()
  }, options.timeoutMs)
  const onAbort = (): void => terminate()
  options.signal?.addEventListener("abort", onAbort, { once: true })

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(child.stdout, options.maxOutputBytes),
      readBounded(child.stderr, Math.min(options.maxOutputBytes, 64 * 1024)),
      child.exited,
    ])
    return {
      argv: options.argv,
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      truncated: stdout.truncated || stderr.truncated,
      runner: options.runner,
      timedOut,
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onAbort)
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  let truncated = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (length + value.byteLength > limit) {
        chunks.push(value.slice(0, Math.max(0, limit - length)))
        length = limit
        truncated = true
        await reader.cancel().catch(() => undefined)
        break
      }
      chunks.push(value)
      length += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(merged), truncated }
}

/** Minimal environment for a tool: no credentials, no operator settings. */
export function scrubbedEnvironment(workDirectory: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: workDirectory,
    TMPDIR: workDirectory,
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    CYRION_WORKER: "1",
    ...extra,
  }
}
