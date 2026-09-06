# Architecture

```text
operator + manifest
        |
        v
  Root planner session ---- typed RootDecision
        |                          |
        |                    policy validation
        |                          |
        +-------------------- controller
                                   |
                          durable event first
                                   |
                 +-----------------+-----------------+
                 |                 |                 |
              worker           worker           validator
              session          session           session
                 |                 |                 |
                 +------ structured results --------+
                                   |
                    local evidence + report
```

The Root is an orchestration role. It proposes actions but cannot directly
spawn processes or widen scope. The controller accepts or rejects each typed
decision, owns concurrency and lifecycle, and records an event before applying
state.

## Prompt boundaries

Each model call is assembled from three explicit layers:

1. **System prompt** — stable role, authority limits, tool protocol, and result
   contract. Public and intentionally short.
2. **Context envelope** — controller-generated identity, engagement ID, exact
   scope, granted capabilities, budget remainder, and evidence references.
3. **User/task prompt** — the operator objective or one bounded delegated task.

Target content, retrieved documents, worker messages, and evidence are data;
they never become system instructions. A child receives a scoped summary, not
the Root's entire transcript. Provider credentials are never inserted into any
prompt.

## Runtime boundary

OpenCode supplies independent sessions, provider access, streaming, and
cancellation. Cyrion owns the task graph, leases, validation gates, and durable
event model. This avoids two schedulers competing for worker lifecycle.

## Controller state

The controller can use either an in-memory store for disposable demos or a
SQLite store for resumable engagements. SQLite uses one local writer, WAL mode,
monotonic per-engagement event sequences, and a materialized snapshot. Tasks
carry a stable input hash, attempt number, and expiring lease. Recovery requeues
an interrupted task under the same identity before asking Root for more work.

Every runtime receives a task-bound tool gateway. The gateway rejects target or
capability changes, invalid timeouts, excessive output budgets, and unregistered
adapters before execution. Audit events contain request metadata, never opaque
worker input or tool output.

Provider-reported token and cost usage is accumulated into the engagement and
checked against the manifest. The remaining budget passed to each worker is
calculated from measured use and elapsed wall time.

## Evidence boundary

Workers return normalized evidence references rather than embedding artifacts
in controller state. The local evidence store writes an immutable-intent
artifact and a separate metadata record, both with owner-only file permissions.
References use portable `artifact://` URIs; SHA-256 and byte length allow the
controller, reporter, or operator to detect missing or modified content.
