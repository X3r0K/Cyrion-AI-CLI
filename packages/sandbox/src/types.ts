/**
 * Where a capability's process runs.
 *
 * `container` isolates by construction. `local` runs on the operator's own
 * machine, which is what a Kali or Parrot user usually wants; it keeps every
 * control that does not depend on a kernel boundary and says plainly which
 * ones it loses.
 */
export type SandboxKind = "local" | "container"

export interface BinaryInfo {
  name: string
  path: string
  version?: string
}

export interface CommandSpec {
  /** Built by a capability adapter from validated input. Never a shell string. */
  argv: string[]
  timeoutMs: number
  maxOutputBytes: number
  /** Added on top of a scrubbed base environment; the operator's env is never inherited. */
  env?: Record<string, string>
  /** Receives stdout as it arrives, for tools that take minutes to answer. */
  onOutput?: (chunk: string) => void
}

export interface CommandResult {
  argv: string[]
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  truncated: boolean
  runner: SandboxKind
  timedOut: boolean
}

export interface ToolRunner {
  readonly kind: SandboxKind
  /** Resolves a binary and its version, or undefined when it is not installed. */
  lookup(binary: string): Promise<BinaryInfo | undefined>
  run(spec: CommandSpec, signal?: AbortSignal): Promise<CommandResult>
  close(): Promise<void>
}

export interface SandboxReport {
  kind: SandboxKind
  ready: boolean
  detail: string
  /** Controls in force, and the ones this mode cannot provide. */
  enforced: string[]
  missing: string[]
}
