# CYRION/AI Community

An open-source, local-first terminal orchestrator for authorized security
assessment workflows.

This repository is a clean-room community implementation. It reuses product
concepts and public interfaces, not proprietary Cyrion prompt text, scoring
heuristics, private evaluators, attack recipes, or hosted-platform code.

## Product terminal demo

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
supports `1`–`4` to switch views, arrows or `j`/`k` to select workers, findings,
and evidence, `Enter` to inspect, `i` to focus Root chat, `p` to pause/resume
dispatch, and `q` to quit. If work is still active, `q` cancels the leased
workers before returning control to the shell. Press `?` for the full keyboard
reference.

To exercise durable state and restart-safe task reconciliation, provide a local
SQLite path:

```bash
bun run demo:headless --state .cyrion/community.sqlite
```

Running the same command again loads the completed engagement without
redispatching its tasks. If a process stops while a task is leased, the next run
records a recovery event, invalidates the stale lease, and retries the same task
identity with an incremented attempt number.

The assessment workflow includes four harmless, deterministic scenarios:

```bash
bun run demo:headless --fixture known-positive
bun run demo:headless --fixture clean
bun run demo:headless --fixture rejected
bun run demo:headless --fixture incomplete
```

Evidence and report artifacts are written under `.cyrion/artifacts` by default.
Use `--artifacts <directory>` to select another location. Every artifact has a
separate metadata record and is verified by SHA-256.

## Packages

- `apps/cli` — Cyrion terminal application.
- `packages/contracts` — public, versioned engagement/task/event contracts.
- `packages/controller` — Root decision loop, scheduler, SQLite state, leases,
  budgets, and the scope-bound tool gateway.
- `packages/evidence` — local artifact persistence, metadata, hashing, and
  integrity verification.
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
See [Assessment workflow](docs/ASSESSMENT.md) for fixture outcomes and the
validation gate.
See [Product terminal](docs/TERMINAL.md) for navigation, evidence inspection,
responsive layouts, and `NO_COLOR` behavior.
