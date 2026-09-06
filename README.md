# CYRION/AI Community

An open-source, local-first terminal orchestrator for authorized security
assessment workflows.

This repository is a clean-room community implementation. It reuses product
concepts and public interfaces, not proprietary Cyrion prompt text, scoring
heuristics, private evaluators, attack recipes, or hosted-platform code.

## Foundation demo

The first slice proves the complete control loop with harmless fixture data:

1. Root emits a typed delegation decision.
2. Recon runs first.
3. Web and API workers run concurrently in separate sessions.
4. A validator independently checks a candidate with fresh fixture evidence.
5. A reporter produces a local artifact.
6. Every state change is preceded by an append-only event.

```bash
bun install
bun run demo
```

Use `bun run demo:headless` in CI or a non-interactive shell. The live terminal
supports `1`–`4` to switch views, `p` to pause/resume dispatch, and `q` to quit.
If work is still active, `q` cancels the leased workers before returning control
to the shell.

To exercise durable state and restart-safe task reconciliation, provide a local
SQLite path:

```bash
bun run demo:headless --state .cyrion/community.sqlite
```

Running the same command again loads the completed engagement without
redispatching its tasks. If a process stops while a task is leased, the next run
records a recovery event, invalidates the stale lease, and retries the same task
identity with an incremented attempt number.

## Packages

- `apps/cli` — Cyrion terminal application.
- `packages/contracts` — public, versioned engagement/task/event contracts.
- `packages/controller` — Root decision loop, scheduler, SQLite state, leases,
  budgets, and the scope-bound tool gateway.
- `packages/runtime-opencode` — pinned OpenCode session adapter and fixture runtime.
- `agents` — intentionally concise public role prompts.
- `fixtures` — non-destructive, deterministic demo engagements.

See [Architecture](docs/ARCHITECTURE.md) and the
[Community boundary](docs/COMMUNITY_BOUNDARY.md).

## Safety

Only assess systems you own or are explicitly authorized to test. The
controller—not a model prompt—enforces target scope, capability grants,
concurrency, depth, and budgets. This alpha ships fixture workers only; real
network tooling requires an isolated worker adapter and explicit scope policy.

See [Controller and execution](docs/CONTROLLER.md) for the durable-state and
tool-gateway guarantees and their current limitations.
