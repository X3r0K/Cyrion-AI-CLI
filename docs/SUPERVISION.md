# Supervised execution

An engagement with `mode: "supervised"` requires an explicit operator decision
before every Root delegation enters the task queue. Root still proposes the
work, and the controller validates scope, capabilities, budgets, task identity,
dependencies, and output type before presenting it for approval.

## Interactive terminal

Run a fixture in supervised mode:

```bash
cyrion demo --mode supervised
```

The Mission view displays Root's rationale and each proposed task, target, role,
and capability set. Press `a` to approve the complete delegation or `x` to deny
it. Approval never grants a new capability or bypasses controller policy.
Denial records the decision and cancels the engagement without dispatching the
proposed workers.

## Headless runs

Headless supervised execution refuses to wait on an unavailable terminal. CI or
scripted fixture evaluation must opt in explicitly:

```bash
cyrion demo --headless --mode supervised --approve-all
```

`--approve-all` still emits a separate request and approval event for every
delegation. It is intended for deterministic fixture evaluation, not as a
substitute for human review of future live capabilities.

## Durability and audit

Pending and approved delegations are stored with the engagement snapshot.
Restart reconciliation revalidates the stored decision and its task identities
before queueing any missing task. A crash after approval cannot create a second
task with the same identity.

The audit trail uses:

- `root.decision.awaiting_approval`
- `root.decision.approved`
- `root.decision.denied`

Only contract-valid, policy-valid proposals reach the approval gate. Approval
records contain bounded public task metadata and never contain credentials,
tool input, tool output, or hidden provider reasoning.
