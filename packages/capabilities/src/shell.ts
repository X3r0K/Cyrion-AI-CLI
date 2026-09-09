import type { ToolExecutionRequest, ToolProgress } from "@cyrion/contracts"
import { evaluateScope } from "@cyrion/scope"
import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "./types"

/**
 * A shell, and a language to write exploits in.
 *
 * Every other capability is a typed adapter: Cyrion builds the argv and the
 * worker chooses only the target. These two are the opposite by design — the
 * agent writes the command, and Cyrion runs it. That is what a real assessment
 * needs, because the interesting half of a pentest is the part nobody wrote an
 * adapter for.
 *
 * **Where the boundary actually is, stated plainly.** The declared `target` is
 * checked against scope here and again in the gateway, but for these two that
 * check is bookkeeping, not containment: a command is free text, and
 * `curl https://elsewhere.test` reaches elsewhere no matter what target the
 * task declared. What genuinely holds a shell to the approved scope is the
 * kernel egress allowlist installed into the container's network namespace,
 * derived from that same scope and defaulting to DROP.
 *
 * So in container mode the scope is enforced, by the kernel, whatever the
 * command says. In local mode there is no such boundary at all — the command
 * runs on the operator's machine as the operator. That is the whole reason
 * container is the default sandbox, and why the runner that actually ran is
 * recorded on every result and in the report.
 *
 * What does not change with the mode: everything is evidence. The command, its
 * exit code, its output, and the code of any exploit written here are captured
 * before the summary is returned, because a finding that cannot be shown to a
 * client is not worth having.
 */

/** Bookkeeping, not containment — see the note above. Cheap, and consistent. */
function checkTarget(capability: string, request: ToolExecutionRequest, context: CapabilityContext): void {
  const decision = evaluateScope(context.scope, request.target)
  if (!decision.allowed) throw new Error(`${capability} refused: ${decision.reason}`)
}

/** Enough for a real chain, bounded so one call cannot become the whole run. */
const MAX_COMMAND_BYTES = 16_384
const MAX_CODE_BYTES = 65_536

export const shellExec: CapabilityAdapter = {
  capability: "shell.exec",
  binary: "sh",

  async execute(
    request: ToolExecutionRequest,
    context: CapabilityContext,
    signal: AbortSignal,
    progress?: ToolProgress,
  ): Promise<CapabilityResult> {
    checkTarget("shell.exec", request, context)
    const command = readText(request.input, "command", MAX_COMMAND_BYTES)
    if (!command) throw new Error("shell.exec needs a command")

    const result = await context.runner.run({
      argv: ["sh", "-c", command],
      timeoutMs: Math.min(request.timeoutMs, 900_000),
      maxOutputBytes: Math.min(request.maxOutputBytes, 2_000_000),
      ...(progress ? { onOutput: (chunk: string) => progress(firstLine(chunk)) } : {}),
    }, signal)

    // Captured before anything is returned, and captured whatever the exit
    // code was: a command that failed is part of the account of what was tried.
    const evidence = await context.evidence.capture({
      engagementId: request.engagementId,
      id: context.nextEvidenceId("E"),
      kind: "log",
      content: [
        `$ ${command}`,
        `exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""} in ${result.durationMs}ms`,
        `runner: ${result.runner}`,
        "",
        result.stdout,
        result.stderr ? `\n--- stderr ---\n${result.stderr}` : "",
      ].join("\n"),
      contentType: "text/plain",
      source: request.agentId,
    })

    return {
      summary: {
        command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr.slice(0, 20_000),
        timedOut: result.timedOut,
        truncated: result.truncated,
        durationMs: result.durationMs,
        runner: result.runner,
      },
      evidence: [evidence],
      outcome: `exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""} · ${result.durationMs}ms`,
    }
  },
}

/**
 * The exploit runtime.
 *
 * A proof of concept is easier to write than to describe, and a language beats
 * a chain of shell quoting for anything with structure in it. The code is
 * passed on argv rather than written to a file, so it works identically in
 * both runners and needs no writable path in a read-only image.
 *
 * The code itself is the artifact. It is stored verbatim, so the bundle a
 * client receives contains the exploit that ran rather than a description of
 * one — which is the difference between a report they can verify and a claim
 * they have to take on trust.
 */
export const pythonExec: CapabilityAdapter = {
  capability: "python.exec",
  binary: "python3",

  async execute(
    request: ToolExecutionRequest,
    context: CapabilityContext,
    signal: AbortSignal,
    progress?: ToolProgress,
  ): Promise<CapabilityResult> {
    checkTarget("python.exec", request, context)
    const code = readText(request.input, "code", MAX_CODE_BYTES)
    if (!code) throw new Error("python.exec needs code")

    const result = await context.runner.run({
      argv: ["python3", "-c", code],
      timeoutMs: Math.min(request.timeoutMs, 900_000),
      maxOutputBytes: Math.min(request.maxOutputBytes, 2_000_000),
      ...(progress ? { onOutput: (chunk: string) => progress(firstLine(chunk)) } : {}),
    }, signal)

    const evidence = await context.evidence.capture({
      engagementId: request.engagementId,
      id: context.nextEvidenceId("E"),
      kind: "poc",
      content: [
        "# Written and run by Cyrion during this engagement.",
        `# exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""} in ${result.durationMs}ms`,
        "",
        code,
        "",
        `# --- stdout ---\n${comment(result.stdout)}`,
        result.stderr ? `# --- stderr ---\n${comment(result.stderr)}` : "",
      ].join("\n"),
      contentType: "text/x-python",
      source: request.agentId,
    })

    return {
      summary: {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr.slice(0, 20_000),
        timedOut: result.timedOut,
        truncated: result.truncated,
        durationMs: result.durationMs,
        runner: result.runner,
      },
      evidence: [evidence],
      outcome: `python exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""} · ${result.durationMs}ms`,
    }
  },
}

/** One bounded string field, refused rather than truncated when it is too long. */
function readText(input: unknown, field: string, limit: number): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const value = (input as Record<string, unknown>)[field]
  if (typeof value !== "string") return undefined
  const clean = value.trim()
  if (!clean) return undefined
  // Truncating would run a command nobody wrote, which is worse than refusing.
  if (Buffer.byteLength(clean, "utf8") > limit) {
    throw new Error(`${field} exceeds ${limit} bytes; split the work across calls`)
  }
  return clean
}

/** Progress is a live transcript line, so it stays short and single-line. */
function firstLine(chunk: string): string {
  return chunk.split("\n").find((line) => line.trim())?.trim().slice(0, 160) ?? ""
}

function comment(value: string): string {
  return value.split("\n").slice(0, 200).map((line) => `# ${line}`).join("\n")
}
