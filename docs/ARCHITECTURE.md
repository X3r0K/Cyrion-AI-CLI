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
                          persisted event first
                                   |
                 +-----------------+-----------------+
                 |                 |                 |
              worker           worker           validator
              session          session           session
                 |                 |                 |
                 +------ structured results --------+
                                   |
                           evidence + report
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
