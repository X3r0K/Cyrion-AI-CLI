import { evaluateScope } from "@cyrion/scope"
import { DEFAULT_ENGAGEMENT_LIMITS, type EngagementManifest } from "@cyrion/contracts"
import type {
  TaskSpec,
  ToolAdapter,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolGateway,
  ToolInvocation,
} from "@cyrion/contracts"
import { TargetLimiter } from "./target-limits"

/** At most one progress note per interval, per tool call. */
const PROGRESS_INTERVAL_MS = 1_000

export type ToolEventSink = (
  type: "tool.request.accepted" | "tool.request.completed" | "tool.request.rejected" | "tool.request.progress",
  payload: unknown,
  agentId: string,
  taskId: string,
) => void

interface Binding {
  engagementId: string
  agentId: string
  task: TaskSpec
  emit: ToolEventSink
}

/**
 * The adapter's one-line account of what came back.
 *
 * Target-derived text, so it is capped and stripped of anything that could
 * drive a terminal or corrupt a log line. Anything longer or stranger than a
 * short phrase is dropped rather than truncated into something misleading.
 */
export function outcomeOf(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined
  const value = (output as { outcome?: unknown }).outcome
  if (typeof value !== "string") return undefined
  const clean = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim()
  return clean ? clean.slice(0, 200) : undefined
}

export class ScopedToolGateway {
  readonly #manifest: EngagementManifest
  readonly #adapters: Readonly<Record<string, ToolAdapter>>
  /**
   * One limiter for the whole engagement.
   *
   * Per-worker pacing would not be pacing at all: the host feels the sum of
   * every agent, so the count has to be kept where every agent passes, which is
   * here. This is also the only place a capability can be called from, so no
   * adapter can reach a target by a route that skips it.
   */
  readonly #limiter: TargetLimiter

  constructor(manifest: EngagementManifest, adapters: Readonly<Record<string, ToolAdapter>>) {
    this.#manifest = structuredClone(manifest)
    this.#adapters = adapters
    this.#limiter = new TargetLimiter(manifest.limits ?? DEFAULT_ENGAGEMENT_LIMITS)
  }

  /** Pacing in force, so `cyrion status` and the report can state it. */
  get limits() {
    return this.#limiter.limits
  }

  bind(binding: Binding): ToolGateway {
    return {
      execute: <T>(invocation: ToolInvocation) => this.#execute<T>(binding, invocation),
    }
  }

  async #execute<T>(binding: Binding, invocation: ToolInvocation): Promise<ToolExecutionResult<T>> {
    const rejection = this.#validate(binding, invocation)
    if (rejection) {
      binding.emit("tool.request.rejected", {
        reason: rejection,
        capability: invocation.capability,
        target: invocation.target,
        timeoutMs: invocation.timeoutMs,
        maxOutputBytes: invocation.maxOutputBytes,
      }, binding.agentId, binding.task.id)
      throw new Error(rejection)
    }

    const request: ToolExecutionRequest = {
      ...structuredClone(invocation),
      engagementId: binding.engagementId,
      taskId: binding.task.id,
      agentId: binding.agentId,
    }

    // Held here, after the request is known to be legitimate and before it is
    // announced as accepted. A call refused by the pace never happened as far
    // as the target is concerned, so it is recorded as a rejection rather than
    // as an accepted call that failed.
    let lease
    try {
      lease = await this.#limiter.acquire(request.target)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      binding.emit(
        "tool.request.rejected",
        { reason, capability: request.capability, target: request.target },
        binding.agentId,
        binding.task.id,
      )
      throw error
    }

    binding.emit(
      "tool.request.accepted",
      {
        capability: request.capability,
        target: request.target,
        timeoutMs: request.timeoutMs,
        // Why a run is slower than the tool timings suggest. Without this the
        // operator sees idle time with nothing accounting for it.
        ...(lease.waitedMs > 0 ? { waitedMs: lease.waitedMs } : {}),
      },
      binding.agentId,
      binding.task.id,
    )

    // The clock starts once the call is actually allowed to leave. Charging a
    // tool for time it spent queued behind the pacer would make a timeout mean
    // two different things and would fail slow-but-healthy work first.
    const started = performance.now()
    const adapter = this.#adapters[request.capability]!
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error("Tool request timed out")), request.timeoutMs)
    try {
      // Progress is throttled and bounded here rather than at the adapter, so a
      // chatty tool cannot flood the durable log however it is written.
      let lastNote = 0
      const progress = (note: string): void => {
        const now = Date.now()
        if (now - lastNote < PROGRESS_INTERVAL_MS) return
        const clean = note.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim().slice(0, 200)
        if (!clean) return
        lastNote = now
        binding.emit(
          "tool.request.progress",
          { capability: request.capability, target: request.target, note: clean },
          binding.agentId,
          binding.task.id,
        )
      }
      const output = await Promise.race([
        adapter.execute(request, controller.signal, progress),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })
        }),
      ])
      const outputBytes = new TextEncoder().encode(JSON.stringify(output) ?? "null").byteLength
      if (outputBytes > request.maxOutputBytes) throw new Error("Tool output budget exceeded")
      const result: ToolExecutionResult<T> = {
        output: output as T,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        outputBytes,
      }
      binding.emit(
        "tool.request.completed",
        {
          capability: request.capability,
          target: request.target,
          durationMs: result.durationMs,
          outputBytes,
          // What the target actually returned, so the live transcript can show
          // the exchange. It is derived from a response, so it is bounded and
          // stripped here before it reaches a durable event.
          ...(outcomeOf(output) ? { outcome: outcomeOf(output) } : {}),
        },
        binding.agentId,
        binding.task.id,
      )
      return result
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      binding.emit(
        "tool.request.rejected",
        { capability: request.capability, target: request.target, reason },
        binding.agentId,
        binding.task.id,
      )
      throw error
    } finally {
      clearTimeout(timeout)
      lease.release()
    }
  }

  #validate(binding: Binding, invocation: ToolInvocation): string | undefined {
    if (binding.engagementId !== this.#manifest.id) return "Tool engagement does not match manifest"
    if (invocation.target !== binding.task.target) return `Tool target does not match assigned task: ${invocation.target}`
    const decision = evaluateScope(this.#manifest.scope, invocation.target)
    if (!decision.allowed) {
      return `Tool target is outside the approved scope: ${invocation.target} (${decision.reason})`
    }
    if (!binding.task.capabilities.includes(invocation.capability)) {
      return `Tool capability is not assigned to this task: ${invocation.capability}`
    }
    if (!this.#manifest.scope.capabilities.includes(invocation.capability)) {
      return `Tool capability is not granted by the manifest: ${invocation.capability}`
    }
    if (!Number.isInteger(invocation.timeoutMs) || invocation.timeoutMs < 1 || invocation.timeoutMs > 60_000) {
      return "Tool timeout must be between 1 and 60000 milliseconds"
    }
    if (!Number.isInteger(invocation.maxOutputBytes) || invocation.maxOutputBytes < 1 || invocation.maxOutputBytes > 1_000_000) {
      return "Tool output budget must be between 1 and 1000000 bytes"
    }
    if (!this.#adapters[invocation.capability]) return `No adapter is registered for ${invocation.capability}`
    return undefined
  }
}
