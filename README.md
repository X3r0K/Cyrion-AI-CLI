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

The demo uses deterministic fixture workers and does not require an LLM. Copy
`.env.example` to `.env`, configure an OpenCode provider/model, and run
`bun run apps/cli/src/index.ts providers` to inspect readiness without sending a
model request. See [Installation](docs/INSTALLATION.md) for the exact variables
and the current provider-execution boundary.

Use `bun run demo:headless` in CI or a non-interactive shell. The live terminal
supports `1`–`4` to switch views, arrows or `j`/`k` to select workers, findings,
and evidence, `Enter` to inspect, `i` to focus Root chat, `p` to pause/resume
dispatch, and `q` to quit. If work is still active, `q` cancels the leased
workers before returning control to the shell. Press `?` for the full keyboard
reference.

Exercise the durable supervisor gate with `bun run demo -- --mode supervised`.
Every Root delegation must be approved with `a` or denied with `x` before tasks
are queued. Headless fixture runs require the explicit `--approve-all` flag.

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
separate metadata record. Before accepting a worker result, the controller
requires that record to exist, match the returned reference exactly, and pass
SHA-256 verification.

Persist a run to inspect or export it later:

```bash
bun run demo:headless --fixture known-positive --state .cyrion/community.sqlite
bun apps/cli/src/index.ts status ENG-0042 --state .cyrion/community.sqlite
bun apps/cli/src/index.ts report ENG-0042 --state .cyrion/community.sqlite --format markdown
```

`status --json` produces a stable machine-readable summary. Reports support
`markdown` and `json` and include normalized findings and evidence metadata,
but deliberately omit artifact bodies.

## Packages

- `apps/cli` — Cyrion terminal application.
- `packages/contracts` — public, versioned engagement/task/event contracts.
- `packages/controller` — Root decision loop, scheduler, SQLite state, leases,
  budgets, and the scope-bound tool gateway.
- `packages/evidence` — local artifact persistence, metadata, hashing, and
  integrity verification.
- `packages/reporting` — versioned Markdown and JSON report generation.
- `packages/runtime-opencode` — pinned OpenCode session adapter and fixture runtime.
- `workers` — credential-scrubbed subprocess entrypoints for safe fixture capabilities.
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
See [Installation](docs/INSTALLATION.md) and [Release process](docs/RELEASE.md)
for the distributable bundle and clean-package verification flow.
See [Post-alpha hardening](docs/HARDENING.md) for the subprocess threat model,
failure matrix, and remaining container/egress boundary.
See [Untrusted output boundary](docs/OUTPUT-BOUNDARY.md) for runtime contract,
provenance, and finding-transition enforcement.
See [Evidence admission](docs/EVIDENCE-ADMISSION.md) for canonical metadata,
integrity checks, and recovery-time artifact validation.
See [Supervised execution](docs/SUPERVISION.md) for interactive approval,
headless safeguards, audit events, and restart behavior.
