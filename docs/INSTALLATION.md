# Installation

Cyrion Community currently requires Bun 1.3.12 or newer and is tested first on
Linux. macOS uses the same Bun package; Windows support is through WSL2 for the
public alpha.

## Run from source

```bash
git clone https://github.com/X3r0K/Cyrion-AI-CLI.git
cd Cyrion-AI-CLI
bun install --frozen-lockfile
bun run check
bun run demo
```

## LLM provider readiness

The fixture demo is intentionally runnable without an LLM. To prepare an
OpenCode provider, create a local environment file and fill both Cyrion IDs:

```bash
cp .env.example .env
opencode models <provider>
```

Set `CYRION_PROVIDER_ID`, `CYRION_MODEL_ID`, and the selected provider's API-key
environment variable in `.env`. As an alternative to an API-key variable, run
`opencode auth login`; OpenCode keeps that credential outside this repository.
Never commit `.env`.

The terminal Settings view can also persist the provider, model, default Root
planner, worker review, controller mode, demo scenario, and color profile. CLI
`--planner`, `--workers`, `--mode`, and `--fixture` flags override their saved
defaults for a single launch.

Check discovery without making a model request:

```bash
bun run apps/cli/src/index.ts providers
bun run apps/cli/src/index.ts providers --check
```

Choose from connected providers and their available models inside the CLI. The
picker updates only `CYRION_PROVIDER_ID` and `CYRION_MODEL_ID`; it does not read,
display, or rewrite provider credentials:

```bash
bun run apps/cli/src/index.ts providers --select
```

The first command explains missing configuration; `--check` also exits nonzero
until the selected provider, model, and credential are available. To make real
model requests for bounded Root review, run:

```bash
cyrion demo --planner opencode --workers opencode
```

OpenCode may accept or stop each exact controller-generated transition and may
replace only its rationale. It cannot invent task IDs, targets, capabilities,
or dependencies. Role-specific OpenCode sessions may also review canonical
worker outputs and append only labeled public review summaries. When worker
review is enabled, Cyrion sends the task envelope, canonical public result, and
small previews of hash-verified textual evidence to the selected provider.
Preview disclosure is capped at 32 artifacts, 4 KiB each, and 12 KiB total;
binary, invalid, mismatched, inaccessible, unknown-size, and greater-than-1-MiB
source artifacts remain metadata-only.
Treat this as an external data transfer and use fixture workers when evidence
must remain entirely local. Tool execution, findings, evidence, provenance,
verdicts, and report content remain deterministic and isolated. This is not a
live network assessment adapter. Model requests may incur provider charges.

The packaged demo manifests allow three minutes so slower local or free models
can finish their reviews while the controller continues lease heartbeats. The
deadline remains enforced; production manifests should set an explicit limit
appropriate to their provider and authorization window.

## Build the distributable CLI

```bash
bun run build
bun dist/cyrion.js version
bun dist/cyrion.js demo --headless --fixture known-positive
```

The bundle keeps its fixture manifests and public agent definitions beside the
installed package. It does not embed credentials, local `.env` files, SQLite
state, or `.cyrion` artifacts.

For local command discovery, build and link the package with Bun:

```bash
bun run build
bun link
cyrion help
```

## Durable run and report

```bash
cyrion demo --headless --fixture known-positive \
  --state .cyrion/community.sqlite \
  --artifacts .cyrion/artifacts

cyrion status ENG-0042 --state .cyrion/community.sqlite
cyrion report ENG-0042 --state .cyrion/community.sqlite --format markdown
```

The report command emits to standard output so operators can explicitly choose
the destination and overwrite behavior with normal shell redirection.

## Supervised fixture run

Interactive runs use `a` and `x` to approve or deny each Root delegation:

```bash
cyrion demo --mode supervised
```

Non-interactive fixture automation must acknowledge automatic approval:

```bash
cyrion demo --headless --mode supervised --approve-all
```
