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

In supervised mode, a valid Root delegation becomes a durable pending approval
instead of entering the task queue. Only the controller can commit an approved
proposal, and it revalidates recovered approvals before applying missing tasks.

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

The community CLI exposes OpenCode first as a guarded Root reviewer. A
deterministic policy planner proposes the next exact transition; the provider
may accept it with a public rationale or stop it, but cannot rewrite tasks,
targets, capabilities, or dependencies. Isolated fixture workers still own all
tool calls and evidence capture. This hybrid boundary exercises real provider
sessions without treating model output as authority or evidence.

Provider prompts advertise no host, file, network, or delegation tools. For
providers that reject `tool_choice: none`, the only advertised compatibility
tool is OpenCode's ephemeral session todo list; it cannot access the assessment
target, repository, host shell, or evidence store.

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

Provider JSON is untrusted after schema generation. Runtime contract checks
reject unknown or malformed fields before persistence, then controller policy
binds accepted observations, evidence, and findings to the exact task, target,
agent, and allowed finding transition. Rejected opaque output is not copied into
the durable event log.

## Evidence boundary

Workers return normalized evidence references rather than embedding artifacts
in controller state. The controller owns the evidence store and passes it into
each runtime. Before merging a result, it resolves every reference to canonical
store metadata, requires an exact metadata match, and verifies the artifact
digest and byte length. Recovery repeats this admission check before trusting a
previously durable completion event.

The local evidence store writes an immutable-intent artifact and a separate
metadata record, both with owner-only file permissions. References use portable
`artifact://` URIs; SHA-256 and byte length allow the controller, reporter, or
operator to detect missing or modified content.

The product terminal receives the same `EvidenceStore` instance as the
controller. Its inspector performs an integrity check before rendering a bounded,
control-character-sanitized preview. Selection and responsive presentation stay
inside `apps/cli`; neither can mutate controller state beyond the explicit
operator message and lifecycle methods.
