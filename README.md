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

The demo defaults to deterministic fixture planning and workers and does not
require an LLM. Copy `.env.example` to `.env`, configure an OpenCode
provider/model, and run
`bun run apps/cli/src/index.ts providers` to inspect readiness without sending a
model request. See [Installation](docs/INSTALLATION.md) for the exact variables
and provider-execution boundary. After provider readiness passes, use
`cyrion demo --planner opencode` for guarded provider review of each exact Root
transition; isolated fixture workers continue to own tools and evidence.
Add `--workers opencode` to let role-specific provider sessions review each
canonical worker result and write its public summary. This explicitly sends
the task envelope, public result, and bounded previews of verified textual
evidence to the selected provider; use fixture mode when evidence must stay
entirely local:

```bash
cyrion demo --planner opencode --workers opencode
```

Use `bun run apps/cli/src/index.ts providers --select` to choose interactively
from the providers and models OpenCode reports as connected.

Use `bun run demo:headless` in CI or a non-interactive shell. The live terminal
supports `1`–`5` to switch views, arrows or `j`/`k` to select rows, `Enter` to
inspect, `i` to focus Root chat, `r` to export the Markdown report, `p` to
pause/resume dispatch, and `q` to quit.
The fifth view edits provider, Root planner, worker review, and general settings: use
left/right to change a value, `s` to save, `r` to revert, and `d` to refresh
OpenCode discovery. If work is still active, `q` cancels the leased workers
before returning control to the shell. Press `?` for the full keyboard reference.

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
A demo directory left by an earlier release is replaced automatically; `--fresh`
forces a clean run at any time.
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

## Running an assessment

`cyrion engage` runs the real loop against an approved scope: recon, one task
per applicable skill and target, independent validation of every candidate, then
a report — all under the same controller enforcement the fixtures had.

```sh
bun fixtures/lab/server.ts &          # a controlled target with two findable issues
cyrion engage --scope fixtures/lab/engagement.json --sandbox local --headless
```

Findings start as candidates. Only a validator moves one to confirmed, rejected,
or inconclusive, working from the finding record rather than the discovering
worker's transcript, and only with fresh evidence it captured itself. When the
target stops reproducing a candidate, the verdict is `rejected` — a test proves
this by hardening the lab between discovery and validation.

Methodology lives in `skills/*.skill.json`: reviewable units with an objective,
steps, expected evidence, and the false positives that would make the claim
wrong. Each task and finding records the skill that produced it. See
[Running an assessment](docs/ASSESSMENT-WORKFLOW.md).

## Proof, not just a claim

Grant `poc.run` and every candidate is validated by a bounded reproduction whose
bundle is kept: the plan, the exact argv, the pinned addresses, the raw
exchanges, and a `REPRO.md` ending in a shell script that runs anywhere `curl`
does.

```sh
cyrion engage --scope engagement.json --sandbox local        # supervised while poc.run is granted
cyrion replay F-OBJECT-a845c387 --manifest engagement.json   # exits non-zero if it no longer reproduces
```

A proof of concept is a validated plan, never a script a model wrote: reads
only, no request body, no credential headers, at most eight rate-limited steps,
redirects refused, and every step re-checked against the approved scope. The
verdict has three values — `reproduced`, `not-reproduced`, `inconclusive` — and
reproducibility is recorded separately from severity, so a confirmed finding
without a bundle is reported as exactly that. See
[Proof of concept and replay](docs/POC-VALIDATION.md).

## Where capabilities run

Two execution modes, and Cyrion picks a sensible default for your machine:

```sh
cyrion tools                 # what this machine can already do, and how to install the rest
cyrion probe --capability http.probe --target https://app.lab.test --manifest engagement.json
```

**Local mode** runs tools directly on your machine — what a Kali or Parrot user
usually wants, since the toolchain is already installed. It keeps the capability
allowlist, adapter-built argv, a scrubbed environment, a private working
directory, output and time ceilings, and process-group termination; it does not
pretend to give you filesystem or network isolation, and `cyrion tools` says so.

**Container mode** runs one hardened container per engagement: unprivileged,
read-only root, no host mounts, all capabilities dropped, and a default-DROP
egress allowlist installed into the container's own network namespace from the
host — which a process inside, without `NET_ADMIN`, cannot remove. If that
allowlist cannot be installed, Cyrion refuses to start rather than running
unfiltered.

Several capabilities are implemented inside Cyrion and need nothing installed,
so local mode works on a bare machine. For the rest, `cyrion tools` prints the
exact install command for your package manager — and never runs it for you.
See [Where capabilities run](docs/SANDBOX.md).

## Reports and CI gating

One record, six formats — Markdown, JSON, HTML, SARIF, JUnit, and CSV — so the
report a client reads and the dashboard a pipeline gates on cannot disagree:

```sh
cyrion ci --scope engagement.json --fail-on high --formats markdown,html,sarif,junit
```

The gate counts confirmed findings only; reports are written before the exit
code is decided. Every report states the scope hash and attestation, the skills
that produced each finding, budgets granted against consumed, and
reproducibility recorded separately from severity. See
[Reports and CI gating](docs/REPORTING.md).

## MCP, in both directions

```sh
cyrion mcp serve --state .cyrion/engagement.sqlite --engagement ENG-1042
cyrion mcp list --manifest engagement.json
```

As a server, Cyrion exposes an engagement to another agent read-only —
`start_engagement` is refused at the protocol level, and artifact text is
withheld when it no longer matches its digest. As a client, `mcp.json` declares
approved servers with an explicit tool allowlist mapped to capability names the
manifest must already grant. See [MCP, in both directions](docs/MCP.md).

## Targets and scope

Scope is enforced by the controller, not by prompt text. Targets are typed
expressions — hosts, CIDR ranges with ports, URLs with path prefixes, and
repository roots — and exclusions always win:

```sh
cyrion scope check --manifest engagement.json --target 10.10.0.9
cyrion scope lock  --manifest engagement.json --attest "Authorized by …, ticket SEC-1042"
cyrion demo --scope-lock scope.lock
```

A lock binds an operator attestation to one exact scope; the controller refuses
to start when the scope has since changed. Redirect and DNS-pinning checks live
in the same engine, so a rebinding answer or an out-of-scope hop is refused
rather than followed. See [Targets and scope](docs/SCOPE.md).

## Model providers

Provider access is not tied to one vendor or one SDK. Point Cyrion at a hosted
API or at a model served on your own hardware:

```sh
export CYRION_LLM_BASE_URL=http://127.0.0.1:11434
export CYRION_LLM_MODEL=qwen3:14b
export CYRION_LLM_KIND=ollama
bun run apps/cli/src/index.ts models --check
bun run apps/cli/src/index.ts demo --planner llm --workers llm
```

Nothing needs to be configured before Cyrion starts. Launch it, press **5** for
Settings, and fill in the endpoint URL, model, and — for a hosted API — the name
of the variable holding your key. A saved runtime that is missing or unreachable
never blocks the terminal: Cyrion runs the deterministic runtime, says why, and
leaves the page that fixes it one keystroke away.

`--planner llm` lets the provider review each controller-generated transition;
`--planner llm-author` lets it propose transitions, which the controller still
validates field by field before dispatch. Local inference reports zero cost, and
token, time, and task budgets apply either way. See [Models](docs/MODELS.md) for
endpoint kinds, role routing, the structured-output ladder, and readiness
checks.

## Packages

- `apps/cli` — Cyrion terminal application.
- `packages/contracts` — public, versioned engagement/task/event contracts.
- `packages/controller` — Root decision loop, scheduler, SQLite state, leases,
  budgets, and the scope-bound tool gateway.
- `packages/evidence` — local artifact persistence, metadata, hashing,
  integrity verification, and bounded provider previews.
- `packages/llm` — provider-agnostic model clients, role routing, structured
  output, and guarded reviewers.
- `packages/scope` — typed target expressions, the scope decision engine,
  DNS pinning, redirect policy, and the operator scope lock.
- `packages/sandbox` — local and container execution, host and tool detection,
  and the container egress allowlist.
- `packages/capabilities` — typed capability adapters that build argv, enforce
  scope, and capture hashed evidence.
- `packages/skills` — the methodology format, loader, and applicability rules.
- `packages/assessment` — the skill-driven planner and the capability-backed
  workers.
- `packages/reporting` — one versioned report record rendered as Markdown, JSON,
  HTML, SARIF, JUnit, and CSV, with reproducibility recorded apart from severity
  and a gate for CI.
- `packages/mcp` — JSON-RPC transport, the read-only engagement server, and the
  allowlisted client for operator-approved MCP servers.
- `packages/runtime-opencode` — pinned OpenCode session adapter and fixture runtime.
- `workers` — credential-scrubbed subprocess entrypoints for safe fixture capabilities.
- `agents` — intentionally concise public role prompts.
- `fixtures` — non-destructive, deterministic demo engagements.

See [Architecture](docs/ARCHITECTURE.md) and the
[Community boundary](docs/COMMUNITY_BOUNDARY.md).

## Safety

Only assess systems you own or are explicitly authorized to test. The
controller—not a model prompt—enforces target scope, capability grants,
concurrency, depth, and budgets. Real capabilities run only where the manifest
grants them, in the sandbox you chose; `poc.run` is off unless it is granted and
supervised unless you opt out in as many words.

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
See [Proof of concept and replay](docs/POC-VALIDATION.md) for the PoC contract,
bundle format, verdicts, and `cyrion replay`.

See [Supervised execution](docs/SUPERVISION.md) for interactive approval,
headless safeguards, audit events, and restart behavior.
