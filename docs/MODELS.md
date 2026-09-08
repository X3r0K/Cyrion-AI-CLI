# Model providers

Cyrion talks to models through one small interface, so a hosted API and a model
served on your own hardware are configured the same way and enforce the same
limits. Nothing in the controller changes when the provider does.

## Configuring from the terminal

You do not need any of this before Cyrion will start. Launch it, press **5** for
Settings, and fill in the endpoint:

| Setting | Example |
| --- | --- |
| LLM endpoint kind | `OPENAI COMPATIBLE`, `ANTHROPIC`, or `OLLAMA` (← →) |
| LLM endpoint URL | `http://127.0.0.1:11434` (Enter to type, Enter to apply) |
| LLM model | `qwen3:14b` |
| LLM key variable | `OPENAI_API_KEY` — the variable's **name**, never the key |

`s` saves to `.env` in the working directory, owner-readable only, and the
defaults apply on the next launch. Settings validates with the same rules the
provider layer uses, so it refuses a configuration that would only fail later —
a malformed URL, a half-filled endpoint, or cleartext to a remote host.

If a saved default names a runtime that is not ready, Cyrion **still starts**.
It runs the deterministic runtime, says why in the footer and in the Settings
sidebar, and leaves the page that fixes it one keystroke away. Naming the
runtime explicitly (`--planner llm`) is different: that is a request for this
run, and it fails loudly rather than quietly running something else.

## Choosing a configuration source

Three sources are consulted, in order. The first one that resolves wins.

| Source | When to use |
| --- | --- |
| `--models <path>` or `CYRION_MODELS_CONFIG` | Explicit file, usually in CI |
| `CYRION_LLM_BASE_URL` + `CYRION_LLM_MODEL` | A single endpoint, typically a local server; this is what Settings writes |
| `cyrion.models.json` in the working directory | A project that pins its own roles |

The shorthand binds every non-embedding role to one model:

```sh
export CYRION_LLM_BASE_URL=http://127.0.0.1:11434
export CYRION_LLM_MODEL=qwen3:14b
export CYRION_LLM_KIND=ollama          # openai-compatible (default), anthropic, ollama
cyrion models --check
```

## Endpoints

| Kind | Speaks to |
| --- | --- |
| `openai-compatible` | OpenAI, OpenRouter, DeepSeek, Groq, Together, xAI, vLLM, llama.cpp, LM Studio, and Ollama's `/v1` path |
| `anthropic` | The Anthropic Messages API |
| `ollama` | Ollama's native API, which takes a JSON Schema directly |

`kind` is the **wire protocol, not the vendor**. DeepSeek, OpenRouter, Groq,
Together, xAI, vLLM, llama.cpp, and LM Studio are all `openai-compatible`;
there is no `deepseek` kind, and naming one is refused with that explanation.

`apiKeyEnv` is the **name of an environment variable**, never the key:

```jsonc
{
  "id": "deepseek",
  "kind": "openai-compatible",
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKeyEnv": "DEEPSEEK_API_KEY"        // the NAME; the key lives in .env
}
```

Pasting the key itself is refused, and the message says to rotate it — a
credential in a config file is far easier to commit than one in an environment.
Keep secrets in `.env`, which is gitignored, along with `cyrion.models.json`.

Credentials are read from the environment variable named by `apiKeyEnv` and are
never written to a config file, an event, a report, or an error message. An
endpoint that would send engagement data over plaintext HTTP to a non-loopback
host is refused unless it sets `allowInsecure`.

### Local servers

**Ollama** — `ollama serve`, then `ollama pull qwen3:14b`. Use the `ollama`
kind: its `format` parameter takes the JSON Schema and constrains decoding
rather than asking the model to behave.

**vLLM** — `vllm serve <model> --served-model-name cyrion-planner` exposes an
OpenAI-compatible API on `http://127.0.0.1:8000/v1`. Structured output works
through `response_format`; older builds are covered by the `guided_json` rung
below.

**Hosted OpenAI-compatible APIs** — one endpoint, the vendor's own base URL,
and the name of the variable holding the key. Ask the API which models it
serves rather than guessing: `cyrion models` prints the catalog it reports, and
a role bound to a name that is not in it shows as `NOT LISTED`.

Local inference reports zero cost. Token and time budgets still apply, and the
engagement still stops when it exceeds them.

## Roles

Each role binds to one endpoint and model. Copy `cyrion.models.example.json` to
`cyrion.models.json` and edit it.

| Role | Used for | Guidance |
| --- | --- | --- |
| `planner` | Root decisions and their review | Strongest reasoning; smallest output |
| `worker` | Reviewing canonical worker results | Volume work, mid-tier is fine |
| `validator` | Reviewing validation results | Prefer a different model from `worker`, so a second family checks the first |
| `reporter` | Reviewing report tasks | Long context, cheap |
| `embedding` | Local retrieval (reserved) | Local by default |

`pricing` is optional. Without it a run reports zero cost rather than an
invented one; with it, cost is accumulated per call and enforced against
`budgets.maxCostUsd`.

## Structured output

Every decision and review is schema-constrained. Because endpoints disagree on
how to do that, the client walks a ladder and remembers the first rung that
works for that endpoint and model:

1. `response_format: json_schema` — strict schema support
2. `guided_json` — constrained decoding on vLLM builds without `json_schema`
3. a single forced tool call — providers whose schema support lives in tools
4. `response_format: json_object` plus the schema in the prompt
5. strict-JSON text with the schema in the prompt

A rung counts as working only when the object it returns satisfies the caller's
own contract, not merely when it parses. This matters on hosted APIs: many
ignore an unknown constraint such as `guided_json` while honouring the
`json_object` sent alongside it, so a rung that constrains nothing can look
successful and then return a well-formed answer to a different question. An
off-schema reply costs one rung, and the ladder keeps descending.

The exception is a model-authored plan (`--planner llm-author`). That is judged
by the controller, not by the transport: a malformed plan is recorded as
`root.decision.rejected` rather than retried away, because a model proposing
something invalid is an event the engagement record has to keep.

Unstructured text is never accepted as a decision. If no rung produces a
conforming object, the call fails and the controller records the failure.

Run `cyrion models --probe` to discover and print the working rung. The probe
sends one tiny request per role, so it costs tokens on a hosted endpoint. Treat
the reported rung as the first that *worked*, not proof of what the server
enforces — a permissive endpoint may land on a precise-sounding rung.

## Using models in an engagement

```sh
cyrion demo --planner llm                 # provider reviews each controller transition
cyrion demo --planner llm --workers llm   # provider also reviews canonical worker results
cyrion demo --planner llm-author          # provider authors transitions; controller validates them
```

`llm` is the guarded mode: the controller builds the transition and the provider
may accept it or stop the engagement. `llm-author` lets the provider propose the
transition instead — every field still passes the same validation, so an
out-of-scope target, an ungranted capability, a duplicate task, or a dependency
cycle is rejected before anything is dispatched.

Worker review routes by task role: validator tasks are reviewed with the
`validator` binding, reporter tasks with `reporter`, everything else with
`worker`. Findings, evidence, provenance, verdicts, and report bodies remain
controller inputs regardless of what a provider returns.

## Readiness

```sh
cyrion models            # endpoints, catalogs, role bindings
cyrion models --check    # non-zero exit when nothing is reachable
cyrion models --probe    # additionally discover the structured-output rung
cyrion models --json     # machine-readable
```

Reachability, catalog membership, and credential presence are reported
separately. A model missing from a catalog is reported as `NOT LISTED` rather
than as a failure, because not every endpoint publishes one.

Readiness is decided by the endpoints **roles actually bind to**. An endpoint
kept in the file for later — a local server that is switched off, or one whose
credential is not set — says nothing about whether the configuration can run,
and does not fail the check. When the check does fail it names the endpoint and
the roles bound to it:

```
ready        NO
  blocked by local, bound to embedding
```

A run is held to the same rule: only the endpoints behind the roles that run
needs have to be available, so `--planner llm` works with a spare endpoint
configured and unreachable.
