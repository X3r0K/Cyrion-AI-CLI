# Controller and execution

Phase 2 establishes the local lifecycle boundary that sits between Root and all
worker execution.

## Implemented guarantees

- A versioned manifest remains authoritative for targets, capabilities,
  concurrency, delegation depth, task count, agent count, duration, tokens, and
  cost.
- Root decisions are validated before any task is accepted.
- Tasks are deduplicated by ID, canonical key, and a normalized input hash.
- Events have a monotonic sequence and are written before their corresponding
  state transition is exposed.
- SQLite persists the engagement snapshot and append-only event history in WAL
  mode.
- Every dispatch acquires an expiring lease and emits heartbeats while active.
- Startup reconciliation invalidates stale in-process work, requeues the same
  task, and increments its attempt without creating a duplicate agent or task.
- Cancellation requests reach every active runtime worker and are recorded as
  cancellation, not a generic execution failure.
- Tool calls are bound to an engagement, agent, task, target, capability,
  timeout, and maximum output size.
- Tool audit events persist metadata only. Worker input and tool output are not
  copied into the event log.
- OpenCode-reported token and cost use is accumulated and enforced against the
  engagement budget.

## Persistence modes

The default fixture demo uses memory and always starts clean. Pass `--state`
with an explicit database path to enable durable state:

```bash
bun run demo:headless --state .cyrion/community.sqlite
```

The supplied manifest must exactly match the manifest stored for that
engagement ID. This prevents an operator or model from silently widening scope
during resume.

## Current isolation boundary

The gateway is an authorization and resource boundary. Fixture capabilities now
execute in short-lived subprocesses with a private temporary directory, explicit
credential-free environment, bounded output, and abort-driven termination. The
worker independently validates its harmless fixture target and capability.

This is not a container or network sandbox. Real network or shell capabilities
are not included. Before such adapters are enabled, they must use minimal mounts,
process-group cancellation, and egress controls that independently enforce
targets across redirects and DNS changes.

Provider requests may continue briefly after an abort. The controller records
measured usage returned by OpenCode, but a provider-side hard spending limit is
still recommended.
