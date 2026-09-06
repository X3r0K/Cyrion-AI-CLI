import type {
  EngagementManifest,
  TaskSpec,
  ToolAdapter,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolGateway,
  ToolInvocation,
} from "@cyrion/contracts"

export type ToolEventSink = (
  type: "tool.request.accepted" | "tool.request.completed" | "tool.request.rejected",
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

export class ScopedToolGateway {
  readonly #manifest: EngagementManifest
  readonly #adapters: Readonly<Record<string, ToolAdapter>>

  constructor(manifest: EngagementManifest, adapters: Readonly<Record<string, ToolAdapter>>) {
    this.#manifest = structuredClone(manifest)
    this.#adapters = adapters
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
    binding.emit(
      "tool.request.accepted",
      { capability: request.capability, target: request.target, timeoutMs: request.timeoutMs },
      binding.agentId,
      binding.task.id,
    )

    const started = performance.now()
    const adapter = this.#adapters[request.capability]!
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error("Tool request timed out")), request.timeoutMs)
    try {
      const output = await Promise.race([
        adapter.execute(request, controller.signal),
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
        { capability: request.capability, target: request.target, durationMs: result.durationMs, outputBytes },
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
    }
  }

  #validate(binding: Binding, invocation: ToolInvocation): string | undefined {
    if (binding.engagementId !== this.#manifest.id) return "Tool engagement does not match manifest"
    if (invocation.target !== binding.task.target) return `Tool target does not match assigned task: ${invocation.target}`
    if (!this.#manifest.scope.targets.includes(invocation.target) || this.#manifest.scope.excluded.includes(invocation.target)) {
      return `Tool target is outside the approved scope: ${invocation.target}`
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
