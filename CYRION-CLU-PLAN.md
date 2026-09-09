# Cyrion CLI — plan for an autonomous penetration testing terminal

Working plan · 7 September 2026 · scope: the open-source `Cyrion-Community` CLI

## 1. Recommendation in one paragraph

Keep the current controller as the product. Cyrion Community's real
differentiator is not "an agent that hacks" — every OSS project claims that —
it is a **deterministic controller that a model cannot talk its way past**:
typed decisions, scope and capability validation, leases, budgets, evidence
admission with SHA-256, and an independent validation gate. That machinery
already exists and is tested. Everything else in this plan is built *around*
it: real tooling instead of fixtures, real targets (URL / IP / repo), a
provider-agnostic model layer including local vLLM and Ollama, a Kali sandbox
that owns execution, a skills format, local RAG, MCP, PoC validation, and
reports. Ship the engine and the safety; keep the curated attack knowledge,
coverage breadth, and hosted operations commercial.

## 2. Where the project stands today

Verified by reading and running the repository, not from documentation claims.

| Area | State | Evidence |
| --- | --- | --- |
| Contracts | Complete and strict. Every inbound object is validated field-by-field, unknown keys rejected. | `packages/contracts/src/index.ts` (532 lines, no dependency on a schema library) |
| Controller | Durable event log, SQLite snapshots, leases with heartbeats, restart reconciliation, budget accounting, supervised approvals, dependency-cycle rejection, worker-result policy checks, evidence admission. | `packages/controller/src/controller.ts` (924 lines) |
| Tool gateway | Validates engagement, target, capability, timeout, and output budget before any adapter runs; emits accept/complete/reject events. | `packages/controller/src/tool-gateway.ts` |
| Execution | **Fixtures only.** One subprocess adapter running `fixture.read` / `fixture.compare` against reserved fixture targets. | `packages/runtime-opencode/src/isolated-fixture-adapter.ts`, `workers/fixture-worker.ts` |
| Models | OpenCode SDK only, and only in *guarded review* mode — the provider may accept or stop a controller-generated transition, never author one. | `guarded-root-planner.ts`, `guarded-agent-runtime.ts`, `opencode-runtime.ts` |
| Terminal | Five views over the event stream, OpenTUI, keyboard-first, `NO_COLOR` path. Rebuilt this session against the design references (§10). | `apps/cli/src/{tui,format}.ts` |
| Tests | 78 passing, including adversarial evidence, output-boundary, supervision, and recovery cases. | `bun test` |

**What is missing for the product to be real:** every capability that touches a
network or a filesystem, every target kind except a fixture hostname, and a
model layer that can plan rather than only review.

The commercial `Cyrion-AI` tree already solves many of these (Kali images in
`containers/`, a token-authenticated in-container tool server, a sandbox bridge
with egress filtering in `scripts/`, ~13 provider families in `cyrion/llm/config.py`,
pgvector RAG, a skills registry over WSTG/MASTG/ATT&CK/ATLAS/NIST/Prowler/Trivy,
MCP tools, browser and proxy tooling). The community edition should re-implement
the *shapes* of those systems in the public repo, not copy the tuned content.

## 3. Product definition and the open-source boundary

**Command:** `cyrion`. **Promise:** an operator defines an authorized
engagement, one Root agent plans, specialist workers act inside a Kali sandbox,
a separate validator reproduces each candidate, and the operator gets a report
where every claim links to a hashed artifact.

The boundary below is the commercially important decision in this document.
Give away the engine, the safety, and the format. Keep the knowledge, the
coverage breadth, and the operations.

| Ships in Cyrion Community (MIT) | Stays in the commercial product |
| --- | --- |
| Controller, contracts, scheduler, leases, budgets, supervision | Hosted control plane, fleet scheduling, multi-tenant RBAC/SSO, billing |
| Evidence store, integrity verification, admission checks | Long-term evidence retention, cross-engagement analytics, dashboards |
| Provider layer: hosted APIs + local vLLM/Ollama, role routing | Model-specific tuning, prompt-module library, ensembling policies |
| Kali worker image + typed capability adapters (recon, web, API, repo) | Browser-driven deep exploitation suites, mobile/cloud/AI red-team packs |
| Validator role, PoC runner, reproduction records | Curated exploit corpus, chaining heuristics, effectiveness scoring |
| Skills *format*, loader, validator, starter pack from public standards | Curated skill corpus, historical outcome data, confidence calibration |
| Local RAG (SQLite + vectors) and public-corpus ingesters | Proprietary intel feeds, enriched CVE/exploit corpus |
| MCP client and MCP server | Private integrations (Jira, GitHub App, Slack, SIEM) |
| Markdown / JSON / HTML / SARIF / JUnit reports | Compliance-framework mappings and auditor-ready report packs |
| Fixtures, benchmark harness, published measurements | Continuous monitoring, scheduled re-tests, support and SLA |

Two rules keep the boundary defensible: the community edition must complete a
real engagement end to end without a Cyrion account, and no commercial artifact
should be required to make it *safe*. Safety is public; coverage is commercial.

## 4. Target architecture

```text
                    engagement.yaml + scope.lock (operator attestation)
                                     |
                            +--------v---------+
   provider layer <-------- |   Root planner   |  typed RootDecision only
   (hosted / local)         +--------+---------+
                                     |
                        policy validation + supervision
                                     |
                            +--------v---------+
                            |    controller    |  durable event first
                            +--------+---------+
                                     |
        +----------------+-----------+-----------+----------------+
        |                |                       |                |
   recon worker     web/api worker          validator worker   reporter
        |                |                       |                |
        +----------------+-----------+-----------+----------------+
                                     |
                          typed tool gateway (capability, target,
                          timeout, rate limit, output budget)
                                     |
                    +----------------v-----------------+
                    |  Kali sandbox container(s)       |
                    |  no host mounts, egress allowlist|
                    |  pinned tools, token tool server |
                    +----------------+-----------------+
                                     |
                    evidence store (hashed artifacts) -> reports
```

Invariants to hold at every step, all of which the controller already enforces
for fixtures and must keep enforcing for real tools:

1. A model never receives a shell. It requests a **capability** with typed
   arguments; the gateway decides.
2. Scope is data, not prose. Targets, exclusions, and capabilities live in the
   manifest; the model cannot widen them, and neither can a tool result.
3. An event is recorded before the state it describes is applied.
4. Evidence exists in the store, matches its metadata exactly, and verifies by
   digest before a result is accepted.
5. Validation is performed by a different session — and, where configured, a
   different model — than discovery, using the finding record rather than the
   discoverer's transcript.

## 5. Workstream A — the model layer (multi-provider, local-first)

Today the only model path is the OpenCode SDK. Replace it with a small internal
interface and adapters, keeping OpenCode as one adapter so nothing regresses.

```ts
// packages/llm
interface ModelClient {
  id: string                                   // "ollama/qwen3:14b"
  complete(request: ModelRequest): Promise<ModelResponse>   // structured or text
  capabilities: { jsonSchema: boolean; toolCalls: boolean; contextTokens: number }
}
```

**Adapters to ship**

| Adapter | Covers | Notes |
| --- | --- | --- |
| `openai-compatible` | OpenAI, OpenRouter, DeepSeek, Groq, Together, Fireworks, xAI, **vLLM**, **llama.cpp**, **LM Studio**, **Ollama** (`/v1`) | One HTTP client, `baseUrl` + `apiKey` + `model`; covers most of the ecosystem |
| `anthropic` | Claude models | Native tool-use and structured output |
| `google` | Gemini models | Native response schema |
| `ollama-native` | Ollama `/api/chat` | JSON-schema `format`, model pull/list for the Settings view |
| `opencode` | Existing SDK path | Keep for users already authenticated through OpenCode |

**Local servers, concretely.** vLLM is started by the operator (`vllm serve <model>
--served-model-name cyrion-planner`) and reached at `http://127.0.0.1:8000/v1`;
structured output uses the server's guided-decoding option, tool calls need the
server's auto tool-choice parser. Ollama is reached at `http://127.0.0.1:11434`
with either the OpenAI-compatible path or the native path with a JSON schema.
Neither requires a key. `cyrion providers --check` must probe the endpoint,
list served models, and report which structured-output mode actually works —
discovered once and cached per endpoint, exactly as `opencode-runtime.ts`
already caches its strict-text fallback.

**Structured-output ladder** (generalize the logic that exists today):
native JSON schema → tool-call-shaped schema → server-side constrained decoding
→ strict-JSON text plus one repair attempt → hard failure recorded as an event.
Never accept unstructured text as a decision.

**Role routing.** One model per role, configured in `cyrion.models.json`:

| Role | Requirement | Sensible default |
| --- | --- | --- |
| `planner` | Strongest reasoning, small output | Best available hosted model, or a 30B+ local model |
| `worker` | Volume, tolerant of mid-tier | Cheaper hosted or 8–14B local |
| `validator` | **Must differ from the discoverer's model when possible** | A second family, or the planner model with a fresh session |
| `reporter` | Long context, cheap | Any mid-tier |
| `embedding` | Local by default | `nomic-embed-text` / `bge-m3` via Ollama |

**Budgets.** Local models cost nothing but still consume time and tokens; the
existing `ResourceUsage` accounting continues to apply, and an `offline`
profile (all roles local, egress from the agent host denied) becomes a
first-class, advertised mode: *no target data, no evidence, and no prompt
leaves the machine.* For assessment work under NDA this is a stronger selling
point than raw model quality.

## 6. Workstream B — targets: URL, IP, repository

The manifest currently carries `profile: "web-api" | "repository"` and a list of
opaque target strings. Replace with typed targets and a real scope engine.

```jsonc
{
  "targets": [
    { "kind": "url",  "value": "https://app.example.test", "paths": ["/api/*"] },
    { "kind": "host", "value": "10.10.0.0/24", "ports": "22,80,443,8000-8100" },
    { "kind": "repo", "value": "./services/api", "ref": "main" }
  ],
  "excluded": [ { "kind": "host", "value": "10.10.0.1" } ]
}
```

**Scope engine** (`packages/scope`, pure functions, exhaustively tested):

- Exclusions evaluated first and always win.
- Hosts: exact, CIDR, and explicit port ranges. No implicit port wildcards.
- URLs: scheme + host + optional port + path-prefix globs; subdomain wildcards
  only when written explicitly.
- Repos: canonicalized absolute path roots; symlinks resolved and re-checked.
- **DNS pinning:** resolve at task start, record the resolved addresses in the
  task record, and enforce those addresses at the egress layer. Re-resolution
  that changes the answer mid-task fails the task rather than following it.
- **Redirects:** a redirect target is re-validated against scope before it is
  followed; an out-of-scope redirect is recorded as an observation, not chased.

**Per-kind recon.** `url` → probe, crawl, fingerprint, endpoint and parameter
inventory, auth-surface map. *Delivered so far: probe and crawl. The crawl reads
the links a site publishes, inside the approved scope, and what it finds becomes
the assessment's target list.* `host` → port and service discovery, TLS
inspection, banner and version inventory. `repo` → clone or open, language and
framework inventory, dependency graph, entrypoints, secret scan, route map.
Findings from a repo target are **static claims** and must be labelled as such;
they cannot be marked `confirmed` without a runtime reproduction.

**Authorization record.** `cyrion scope lock` writes `scope.lock` containing the
canonicalized scope, its hash, the operator's attestation string, and a
timestamp. The controller refuses to start when the manifest hash and the lock
disagree, and the header shows the lock's short hash. It is a small feature that
changes how the tool reads to a reviewer.

## 7. Workstream C — execution: the Kali sandbox

**Image.** `cyrion/kali-worker`, built from a pinned Kali base (`vxcontrol/kali-linux`)
digest, non-root `pentester` user, no sudo, tini as PID 1, tool set installed at
pinned versions with a manifest of versions and checksums emitted at build time
(that manifest is evidence — every tool invocation records the version it ran).

**Container policy** (mirrors what the commercial runtime already learned):

| Control | Setting |
| --- | --- |
| Network | Dedicated bridge `cyrion-sandbox`, never `host` |
| Egress | `DOCKER-USER` allowlist generated from the resolved scope; default DROP; DNS only to a pinned resolver |
| Filesystem | Read-only rootfs, `tmpfs` work directory, **no host bind mounts**, no Docker socket |
| Capabilities | `--cap-drop ALL`; `NET_RAW` added only for the scan profile, and only when raw scanning is requested |
| Limits | Memory, CPU, and pids limits; per-container and per-engagement caps |
| Identity | One container per engagement by default, one per worker under `--isolation=task` |
| Credentials | None. Target credentials are injected per request by the gateway, never into the environment |

**In-container tool server.** A small HTTP service with a bearer token,
listening only on the sandbox network, exposing exactly the registered
capabilities. No free-form command endpoint in v1. A `shell.exec` capability may
exist later behind an explicit profile — still egress-restricted, still argv-
recorded — because operators will ask for it; it must never be the default.

**Capability catalog v1**

| Capability | Tool | Target kinds | Notes |
| --- | --- | --- | --- |
| `net.portscan` | nmap | host | Rate-limited; timing template capped |
| `net.tls` | openssl/testssl | host, url | Certificate and protocol inventory |
| `dns.enum` | dnsx | host, url | Passive by default; active only if scope allows |
| `http.probe` | httpx | url | Status, tech, headers |
| `http.crawl` | katana | url | Depth and page budget from the task |
| `http.request` | internal client | url | Single typed request/response, always captured as evidence |
| `web.fuzz` | ffuf | url | Wordlist from the image; rate limit mandatory |
| `repo.inventory` | internal | repo | Languages, entrypoints, routes |
| `repo.scan` | semgrep | repo | Public rulesets only |
| `repo.deps` | syft + grype | repo | SBOM and known-vulnerable dependencies |
| `browser.session` | Playwright/Chromium | url | Headless, scoped proxy, screenshot evidence |
| `poc.run` | curl, declarative plan | url | §9; off by default, supervised by default |

Every adapter records argv, tool version, exit code, duration, and byte counts,
and writes stdout/stderr to the evidence store before returning a bounded,
typed summary. The model sees the summary; the operator can open the artifact.

## 8. Workstream D — agents and skills

**Roles** stay as the contracts define them (recon, web, api, validator,
reporter) plus a `repo` role for code targets. Resist adding roles; add
*skills* instead.

**Skill format** — operator-authored, versioned, reviewable:

```yaml
id: wstg-atho-04-idor
name: Insecure direct object reference
applies_to: { kinds: [url], capabilities: [http.request] }
preconditions: [ "two authenticated identities are configured" ]
steps: [ "…", "…" ]
expected_evidence: [ request, response ]
false_positives: [ "volatile fields differing between responses" ]
references: [ "WSTG-ATHZ-04" ]
```

Skills are **trusted operator input** and are injected as task instructions;
target data stays untrusted and is never promoted to instruction status.

**Delivered.** A skill may also state `checks`: the request to make and the
conditions that make the answer a finding, in the same vocabulary a PoC step
uses. One statement then drives discovery, independent validation, and the proof
bundle, so a contributed methodology runs — and replays — without a worker being
written for it. Where a check needs a path, a request header, or a body claim it
asks for `http.request`; the loader refuses a claim the granted capability could
not decide, a path that leaves the approved target, and a credential header.
Where a methodology is a choice rather than a conjunction — "any one of these
five headers is missing" — `anyOf` states it, bounded to 2 to 8 alternatives and
one level deep so the whole claim stays checkable at a glance. With it, no
shipped detection is code. Root
selects skills per task and records the selection in the task record, so the
report can state which methodology produced each finding. `cyrion skills
list|show|validate|sync` plus a JSON-schema validator in CI keeps community
contributions consistent. The starter pack derives from public standards
(WSTG, API Top 10, ASVS); the curated corpus stays commercial.

## 9. Workstream E — exploit generation and PoC validation

This is the feature that separates a scanner from a pentest tool, and the one
that most needs guardrails. Design it as *reproduction*, not *exploitation*.

**Flow.** Worker reports a candidate finding with evidence → Root assigns a
validator → the validator receives the finding record and evidence references
**but not the discoverer's transcript** → it states the claim as a minimal
reproduction **plan** → `poc.run` executes it inside the sandbox against the
pinned in-scope target → the verdict (`confirmed` / `rejected` /
`inconclusive`) is recorded with fresh evidence. The controller already enforces
most of this; the new part is the PoC artifact and its runner.

The plan is declarative rather than a generated script, which is what keeps
invariant 1 (§4) true: the model never receives a shell, and the runner compiles
the plan into recorded argv plus a standalone script an operator can read before
running. Authoring the plan from a model is a later, additive step — the schema
is already in `@cyrion/contracts` — and it changes nothing about what the runner
will accept.

**PoC bundle** stored as evidence: the script, its argv and environment, the
captured request/response pairs, the run log, and a generated `REPRO.md` with
manual reproduction steps. `cyrion replay <finding-id>` re-runs it later.

**Hard limits, enforced by the runner and not by prompt text:**

- Only in-scope, DNS-pinned targets; egress allowlist applies to the PoC too.
- Non-destructive by construction: proof markers only — no data exfiltration
  beyond a bounded sample, no writes that persist, no account or credential
  changes, no lateral movement, no denial of service, no automated fuzzing at
  volume.
- Rate limits and a hard wall-clock timeout per run.
- `exploit.validate` is a manifest capability that is **off by default** and
  runs in supervised mode unless the operator opts out explicitly.
- Never enabled for `repo` targets; static findings need a runtime target to be
  confirmed.

**Honesty requirements.** A finding is `confirmed` only with a fresh,
independent reproduction. Record reproducibility separately from severity.
Where discovery and validation used the same model, the report must say so —
correlated model error is a real failure mode and disclosing it is cheaper than
being caught by it.

## 10. Workstream F — the terminal (done this session, and what remains)

The reference images are now implemented against the live event stream.
Delivered in this session, all covered by tests:

- Three-segment header: brand, `ENG-0042 | target | AUTONOMOUS`, environment badge.
- View tabs that fill the row evenly, with a solid accent fill for the active view.
- Panel headings that pair a label with a state token above a rule, replacing
  the old centered dashed captions.
- Swarm tree with square status glyphs, per-worker state lines, and an
  `N active / M workers` footer.
- **Live task board** as a ruled table — agent, task, state, elapsed — with the
  selected row highlighted, over the selected worker's live activity panel and
  the isolation/scope/heartbeat strip.
- **Root dispatch** inspector: parallel slots, queued/running/completed counts,
  last handoff, and the selected worker's lease state.
- **Finding cards** with ID, severity, and verdict, and an inspector carrying
  asset, discovery, validation, environment, linked evidence, and remediation.
- Budget meters rendered as `[■■■□□□]` with a percentage, matching the concept.
- Activity lines in plain operator language ("Result accepted") with
  mission-relative timestamps, never raw event payloads.
- `r` exports the Markdown report and shows the written path in the footer.
- Panel widths derived from the terminal width, applied on resize only, so
  rules and tables stop at their own border at 84, 100, and 168 columns.

Delivered since: the **Attack** view — a scrollable transcript with follow mode,
showing every request, what the target returned, every refusal and its reason,
and each finding as it changes state. Capability adapters report a bounded
outcome on `tool.request.completed`, so the exchange is legible without opening
an artifact.

All of the §10 list is now delivered: the findings filter on `/`, foldable side
panes on `<` and `>`, progress from long-running tools reported while they work
and throttled before it reaches the log, and `cyrion watch` — a read-only
attachment that rejoins the stored snapshot with the event log so every view,
including the transcript, works against an engagement another process is
running.

## 11. Workstream G — knowledge (RAG) — delivered

Local-first and small. SQLite with FTS5, and vectors as blobs scored in process
rather than a mandatory vector extension: requiring one would mean an operator
cannot use their own knowledge base without installing a database first, and a
corpus of public standards is thousands of chunks, not millions.

- `packages/knowledge`: ingest → chunk → embed → store → search.
- Public corpora only, ingested on command rather than shipped as data. Shipped
  descriptors cover the shipped skills, OWASP WSTG, the API Security Top 10, and
  ASVS; each pins the exact files it fetches, because a corpus assembled from
  whatever a site links to today cannot support a citation. CWE and ATT&CK are
  larger and differently shaped, and are left to an operator descriptor.
- Embeddings local by default (Ollama), remote optional, and absent is a
  supported answer rather than a degraded one: search falls back to lexical and
  says so instead of presenting keyword matches as semantic retrieval.
- **Retrieval is a capability, not ambient context.** A worker calls
  `knowledge.search(query, k)` and receives bounded snippets with source IDs
  that must be cited in the resulting observation. This keeps the evidence
  discipline intact and prevents a retrieved document from behaving like an
  instruction.
- The citation lands on an observation, never on a finding. A standard explains
  why a check ran; it never stands in for what the target returned.
- `cyrion knowledge sync|status|search|forget` for operators; corpus version
  recorded in the engagement so a report can state which knowledge base produced
  it.

## 12. Workstream H — MCP, both directions

**As a client:** operator-approved MCP servers become additional capabilities.
Each server is declared in `mcp.json` with an explicit tool allowlist, timeouts,
and an argument schema; each exposed tool maps to a Cyrion capability name that
must appear in the manifest before a worker may call it. Results are untrusted
data. No ambient credentials: an MCP server that needs a secret receives it from
the gateway per call, or it is not enabled.

**As a server:** expose `start_engagement`, `engagement_status`, `list_findings`,
`get_evidence`, and `render_report` so other agents and IDEs can drive Cyrion.
Read-only by default; starting an engagement requires an explicit flag and a
scope lock. This is the cheapest adoption lever in the plan.

**Delivered.** `--allow-start` serves the engagement named by `--scope` and
`--scope-lock`, and the caller starts it by repeating the attestation the lock
records — it chooses nothing else, so a peer can release authorized work but
never author it. On the client side, each allowed tool becomes a capability in
the registry, filtered by the manifest grant, called through the gateway, and
recorded as evidence plus a cited observation. An MCP tool may not answer as a
built-in capability, and because its server runs on the host rather than in the
sandbox, a container run refuses one unless the operator accepts that explicitly.

## 13. Workstream I — reporting

Extend the existing versioned Markdown/JSON generator rather than replacing it.

| Format | Use |
| --- | --- |
| Markdown | Default human report |
| HTML | Self-contained, printable to PDF, includes evidence index |
| JSON | Machine consumption, stable schema, already versioned |
| SARIF | Code and repo findings in GitHub/GitLab code scanning |
| JUnit | CI gating (`cyrion ci --fail-on high`) |
| CSV | Import into trackers |

Every report states: scope and lock hash, methodology (skills used), models and
versions per role, tool versions, budgets consumed, findings with severity
rationale and reproducibility recorded separately, evidence appendix with
digests, validation records, and an explicit **limitations and coverage gaps**
section. Reports never embed artifact bodies by default; they reference them.

## 14. Safety, legal, and abuse resistance

- Authorization gate: no engagement starts without a scope lock and an operator
  attestation; the attestation appears in the report.
- Refuse-by-construction rather than refuse-by-prompt: destructive primitives
  are absent from the capability catalog, not merely discouraged in a prompt.
- Rate limiting and concurrency caps per target, not just per engagement — a
  swarm hitting one host is the most likely way to cause real damage.
- Prompt-injection posture: target content, tool output, retrieved knowledge,
  and MCP results are all untrusted; none can change scope, capabilities,
  budgets, findings, verdicts, or evidence. This is already the controller's
  model and must remain true for every new input channel.
- Secrets: credentials for authenticated testing live in an operator-managed
  store, are injected per request, are redacted from artifacts, and never enter
  a model prompt unless the operator explicitly opts in per credential.
- Publish a `SECURITY.md` disclosure process (exists) and a documented threat
  model for the sandbox (extend `docs/HARDENING.md` when containers land).

## 15. Evaluation — how to claim anything credibly

Build the harness before the coverage, and publish measurements with model and
fixture versions.

| Lab | Purpose |
| --- | --- |
| OWASP Juice Shop, DVWA, WebGoat | Known web findings, broad classes |
| VAmPI / DVRA | API and object-level authorization |
| vulhub containers | Service and version-specific issues |
| A deliberately clean app | False-positive rate |
| A partially broken app | Inconclusive-rate honesty |
| Vulnerable repositories | Static claims and SARIF output |

Metrics: precision, recall, and inconclusive rate **reported separately** per
vulnerability class; reproduction rate of confirmed findings; cost and wall
clock per confirmed finding; time to first confirmed finding; scope-violation
count (must be zero); crash/recovery behavior. Compare at least two model
configurations, one of them fully local, so the local path has published
numbers rather than a claim.

## 16. Delivery plan

Estimates assume one experienced engineer working steadily, with security
review help for the labs. Phases are ordered so that each one ends with
something demonstrable.

| Phase | Weeks | Deliverable | Exit criterion |
| --- | --- | --- | --- |
| 0 · Papercuts **[done]** | 0.5 | Fixture-version guard on the artifact directory with `--fresh`; headless mode error names its source; evidence clash message names the path and remedy | `bun run demo` works twice in a row in a dirty directory ✔ |
| 1 · Model layer **[done]** | 2 | `packages/llm` with OpenAI-compatible (covers vLLM, llama.cpp, LM Studio, Ollama `/v1`), Anthropic, and native Ollama clients; role routing; structured-output ladder; `cyrion models`; `--planner llm/llm-author`, `--workers llm` | Fixture engagement completes against a local endpoint and reports real token usage; `cyrion models --probe` names the working structured-output rung ✔ |
| 2 · Targets and scope **[done]** | 1.5 | `packages/scope` with typed host/URL/repo expressions, CIDR and port ranges, IPv6, exclusions-first evaluation, DNS pinning, redirect policy, address evaluation, and `cyrion scope check` / `scope lock` enforced by the controller | Scope suite passes CIDR, wildcard, port, kind-crossing, rebinding, and redirect-escape attempts ✔ |
| 3 · Sandbox and capabilities **[done]** | 3 | `packages/sandbox` (local **and** container execution), `packages/capabilities` (dns.lookup, http.probe, net.portscan, net.tls), the Kali worker image with a verified build, `cyrion tools`, `cyrion probe` | Real recon against a local lab produces hashed artifacts; out-of-scope egress is blocked at the network layer, verified by test ✔ |
| 4 · Real assessment **[done]** | 3 | `cyrion engage`, `@cyrion/skills` with a starter pack, `@cyrion/assessment` (skill-driven planner and capability-backed workers), and a controlled lab fixture | A lab run yields confirmed findings with fresh independent validation evidence, no false positive against the correct endpoints, and zero scope violations ✔ |
| 5 · PoC validation **[done]** | 2 | `poc.run`, PoC bundles, `cyrion replay`, supervised default | Every confirmed finding replays from its bundle on a clean machine ✔ |
| 6 · Reporting and MCP **[done]** | 2 | HTML/SARIF/JUnit, `cyrion ci`, MCP client and server | CI gating demo and an MCP-driven engagement from a second agent ✔ |
| 7 · Public beta **[done]** | 2 | Benchmarks published, packaging, docs, contribution guide, release artifacts | Clean-machine install reproduces the published lab numbers ✔ |
| 8 · Knowledge **[done]** | 1.5 | `packages/knowledge` (ingest, chunk, embed, store, search), `knowledge.search` as a gateway capability, `cyrion knowledge` (sync, status, search, forget), corpus version in every report | A worker consults the corpus and cites it; no corpus artifact ever backs a finding; a granted capability with no corpus is refused before the run starts ✔ |
| 9 · MCP both directions **[done]** | 1 | `start_engagement` behind `--allow-start` and a scope lock; MCP tools registered into the capability registry as capabilities workers call through; MCP provenance in the report | Another agent starts the operator's prepared engagement by repeating the lock's attestation and watches it complete; a worker calls an approved MCP tool through the gateway and records a cited observation, never a finding ✔ |
| 10 · Executable skills **[done]** | 1.5 | Declarative `checks` in the skill format; `http.request`; one statement driving discovery, validation, and the proof bundle; the shipped object-boundary skill migrated into its file | A skill added as a file alone raises a candidate, is independently validated with fresh evidence, and replays from its bundle — with no change to any worker; the benchmark table is unchanged by moving a built-in detection into its file ✔ |
| 11 · Surface discovery **[done]** | 1 | `http.crawl` bounded to the approved scope; discovered endpoints carried on observations; the planner assessing what recon found, with the controller holding every address to the manifest | A run against one approved origin assesses the endpoints it links to, never requests a link outside the scope, and a worker reporting an out-of-scope address has its whole result refused ✔ |
| 12 · A container run you can check **[done]** | 1 | Worker image identity read before a run, refused when missing, reported when it differs, pinned when published; recorded in the report and in the release artifacts; once-only container startup | `cyrion tools --sandbox container` states the image identity; a machine without it is refused with the build command before an engagement starts; a container engagement completes with parallel workers ✔ |
| 13 · Every detection is a file **[done]** | 0.5 | `anyOf` alternatives in a check, bounded to 2–8 and one level deep; `web-security-headers` migrated out of the worker | A claim that is a choice rather than a conjunction is expressible in a skill file; no shipped detection is code; the benchmark table is unchanged by the move ✔ |

Roughly four months of focused work to a credible public beta. The first three
phases are the ones that convert the current fixture demo into a real tool;
everything after that is coverage and polish.

## 17. Repository layout as it grows

```text
apps/cli/                 commands + terminal
packages/contracts/       versioned schemas (extend: targets, PoC, skills)
packages/controller/      scheduler, policy, state          [unchanged core]
packages/scope/           NEW target and scope engine
packages/llm/             NEW provider layer and routing
packages/sandbox/         NEW container lifecycle + egress policy
packages/capabilities/    NEW typed tool adapters
packages/knowledge/       NEW local RAG
packages/mcp/             NEW client and server
packages/evidence/        artifacts, hashing, verification
packages/reporting/       md, json, html, sarif, junit
skills/                   operator-authored methodology units
containers/               Kali worker image + build/pin scripts
labs/                     benchmark lab compose files
fixtures/                 deterministic demo engagements
```

Packaging: keep the Bun-built single-file CLI and npm tarball, add a container
image for the CLI itself, publish SBOM and checksums (already scripted), and
pin the worker image by digest in the release manifest.

## 18. Fixes applied (was: found while reading and running the code)

1. **Stale artifacts broke the demo.** ✔ Fixed. The engagement artifact
   directory now carries a fixture-version stamp, checked before the run
   starts, with `--fresh` to replace mismatched output. The evidence store's
   clash message also names the offending path and the remedy.
2. **`bun run demo:headless` failed when `.env` set a supervised default.** ✔
   Fixed. The error now names whether the mode came from `--mode` or from
   `CYRION_DEFAULT_MODE`, and points at `--mode autonomous`.
3. **Unclipped mission text.** ✔ Bounded by pane width; manifest text is
   already length-checked by the contract validators at load time.
4. **`docs/TERMINAL.md` responsive claims.** ✔ Now accurate, with the pane math
   derived from the terminal width and verified at 84, 100, and 168 columns.

### Delivered in phases 0 through 13

- `packages/llm`: `ModelClient` interface; `openai-compatible`, `anthropic`, and
  native `ollama` adapters; per-role routing; strict config validation that
  refuses cleartext transport to a remote host and embedded credentials.
- A structured-output ladder discovered once per endpoint and model:
  `json_schema` → `guided_json` → forced tool call → `json_object` →
  strict-JSON text. Unstructured text is never accepted as a decision.
- Credential-safe transport: hard timeouts, a response-byte ceiling, and
  redaction so a key cannot reach an error message, event, or report.
- `cyrion models [--json] [--check] [--probe]` reporting reachability, catalog
  membership, credential presence, and the working structured-output rung
  separately.
- `--planner llm` (guarded review), `--planner llm-author` (model proposes,
  controller validates), and `--workers llm` with validator tasks routed to the
  `validator` binding so a second model can check the first.
- Reviewer contracts and provider JSON Schemas moved into `@cyrion/contracts`;
  the evidence preview builder moved into `@cyrion/evidence`, so both runtimes
  share one validated shape.
- Adversarial coverage: a model-authored plan proposing an out-of-scope target,
  an ungranted capability, an invalid role/output pair, or a non-decision is
  rejected before dispatch.
- `packages/scope`: typed expressions for hosts, CIDR ranges with port lists,
  IPv6 literals, URLs with path prefixes, and repository roots. Exclusions are
  evaluated first; kinds, schemes, and ports never cross implicitly; a wider
  range is never admitted by a narrower one; credentials, queries, and `..`
  segments in an expression are refused rather than normalized away.
- DNS pinning that refuses an address absent from the task's pin set and names
  rebinding when a public host turns inward; redirect checks that refuse an
  out-of-scope hop or an https-to-http downgrade; address evaluation ready for
  the egress allowlist in phase 3.
- `cyrion scope check` and `cyrion scope lock`, with the controller refusing to
  start on an unparsable scope or a lock whose attested scope has changed, and
  recording the scope hash on `engagement.started`.
- Two execution modes. **Local** runs tools on the operator's own machine — the
  Kali and Parrot path — keeping the capability allowlist, adapter-built argv, a
  scrubbed environment, a private working directory, output and time ceilings,
  and process-group termination, while stating plainly what it cannot isolate.
  **Container** runs one hardened container per engagement, unprivileged and
  read-only, with a default-DROP egress allowlist installed into the container's
  own network namespace from the host; Cyrion refuses to start when it cannot be
  installed.
- The allowlist is derived from the approved scope before the container starts,
  with exclusions emitted as DROP rules ahead of every accept, so a host excluded
  from an approved range is refused by the kernel as well as by the scope check.
- `dns.lookup`, `http.probe`, `net.portscan`, and `net.tls`, each validating its
  target, building its own argv, and writing raw output to the evidence store
  before returning a bounded summary. Redirects are reported rather than followed.
- `cyrion tools` reports what a machine can already do and prints the exact
  install command for the operator's package manager without ever running it;
  `cyrion probe` runs one capability by hand under the same enforcement.
- `containers/Dockerfile.worker` plus a build script that refuses to finish
  unless every required binary answers inside the image, recording tool versions
  as evidence input.
- `cyrion engage`: recon, one task per applicable skill and target, independent
  validation of every candidate, then a report — all under the controller's
  existing enforcement, with evidence hashed locally.
- A reviewable JSON skill format with an applicability rule (kind, role, required
  capabilities) and a loader that refuses a malformed pack outright, plus a
  starter pack covering surface inventory, protection headers, object-level
  authorization, and independent reproduction.
- Tasks and findings record the skill that produced them, and the report states
  it; a validator receives the candidate record rather than the discovering
  worker's transcript, and rejects a candidate the target no longer reproduces.
- `fixtures/lab` gives precision and recall a fixed target: two findable issues,
  two endpoints that behave correctly, and tests asserting the whole outcome.
- `poc.run` executes a **declarative** reproduction plan rather than a script a
  model wrote, which keeps invariant 1 intact: reads only, no request body in the
  contract at all, credential-bearing headers refused by name, at most eight
  steps with a rate limit and a per-step wall clock, redirects refused, every
  step re-checked against the scope, and each hostname held to the addresses the
  engagement pinned.
- Every run writes a proof bundle — plan, argv, scrubbed environment, pinned
  addresses, tool version, raw exchanges, per-step outcome, verdict — plus a
  `REPRO.md` whose shell script reproduces the finding without Cyrion. A test
  replays every confirmed finding from its bundle alone into a fresh store.
- `cyrion replay <finding-id>` re-runs a stored bundle against the *current*
  manifest, refusing a step the scope no longer covers, and exits non-zero when
  the verdict has changed — the re-test gate a fix needs to be checkable.
- Findings record `reproduction` separately from severity. The controller
  refuses a validator whose status disagrees with its own bundle, one citing a
  bundle it never captured, and any discovering worker claiming a reproduction.
  A validator now sees the artifacts its candidate cites — never the discovering
  worker's transcript.
- `poc.run` is off unless the manifest grants it, supervised unless the operator
  passes `--allow-unsupervised-poc`, and refused outright for a repository
  engagement.
- One report record now feeds six formats — Markdown, JSON, HTML, SARIF, JUnit,
  CSV — so a client report and a code-scanning dashboard cannot disagree. It
  carries the scope hash and attestation, the skills used, sandbox and models
  and tool versions, budgets granted against consumed, validation records, and
  reproducibility recorded apart from severity. Untrusted finding text is
  escaped per grammar, including quoting a spreadsheet formula.
- SARIF keeps a rejected candidate visible as a passing result: "Cyrion looked
  and found nothing" is a different statement from "Cyrion never looked".
- `cyrion ci` gates a pipeline on confirmed findings at or above `--fail-on`,
  and on an engagement that did not complete or recorded refusals. A candidate
  nobody validated does not fail the build unless the operator asks for it.
- `@cyrion/mcp` in both directions: a read-only server exposing
  `engagement_status`, `list_findings`, `get_evidence`, and `render_report`
  over JSON-RPC on stdio, and a client that runs an operator-approved server
  with a scrubbed environment and an explicit tool allowlist mapped to
  capability names the manifest must already grant. The integration test drives
  Cyrion's server with Cyrion's own client over a real subprocess.
- Container mode reads the identity of the image it will execute in — the ID,
  and the registry digest when there is one — refuses a missing image before the
  run with the command that fixes it, reports one that differs from the release
  record, and refuses it outright once an image is published and pinned. The
  identity is recorded in the report beside the tool versions and shipped with
  the release artifacts.
- Fixed a start race in the container runner: parallel workers each started the
  sandbox lazily, so two of them created a container with the same
  engagement-derived name. Startup is once-only now, and a test fails without it.

- `http.crawl` turns one approved origin into the inventory the skills are run
  against: links the site published, bounded by pages, depth, and a gap between
  requests, with no wordlist and no path guessing. A link outside the scope is
  counted and never followed.
- A discovered address is a report, not a permission. An observation may carry
  what it found, the controller refuses a result naming anything outside the
  manifest, and the planner checks again before dispatching — so widening an
  engagement takes changing the manifest, not finding a link.
- Implemented in Cyrion rather than through katana, because `--sandbox local`
  has to keep working on a machine with nothing installed; the catalog now says
  so instead of listing it as planned.

- A skill carries itself out. `checks` state the request and the conditions that
  make an answer a finding; the worker runs them without knowing what the
  methodology is about, and adding a detection is adding a file. The same
  statement is re-tested by the validator from the record alone and compiled into
  the proof bundle, so a contributed skill cannot disagree with itself.
- `http.request` gives a check a typed request and a readable answer — a path
  under the approved target, chosen headers, the response body — re-checked
  against scope before it is sent and captured in full as evidence.
- The shipped object-boundary skill moved from three branches in the worker into
  its own file with no change to its identifier, its verdicts, or the published
  benchmark table.

- `mcp serve --allow-start` completes the server side: the engagement comes from
  the operator's manifest and scope lock, the caller repeats the lock's
  attestation to release it, an invented one is refused, and the live controller
  answers every read tool while it runs.
- An approved MCP tool is a capability a worker calls through the gateway. The
  manifest grant, the `mcp.json` allowlist, and a skill's requirement all have to
  agree; the exchange is stored as evidence before a bounded summary is returned;
  the worker records a cited observation and never a finding. A built-in
  capability cannot be redefined by a server, and a container run refuses a
  host-side MCP tool unless the operator accepts the gap in the allowlist.
- Fixed the MCP client keeping the process alive for a whole request timeout
  after its last answer, which had made every call cost 30 seconds at exit.
- `@cyrion/benchmark` scores a run against ground truth kept in the labs rather
  than in the code being measured, so the benchmark can fail. Only confirmed
  findings count as claims — a candidate nobody validated is not an assertion —
  and `inconclusive` gets its own column instead of being folded into either
  side. Precision, recall, and inconclusive rate are reported **per class**, so
  one weak methodology cannot hide behind a strong one.
- Three labs, each making a different number honest: known issues for recall, a
  correct application for precision, and one that answers inconsistently, where
  a confirmed finding would be a guess and the harness fails the run for it.
- `cyrion bench` publishes `BENCHMARKS.md` with the Cyrion and fixture versions,
  the planner, workers, and sandbox that produced it, and a section stating what
  the numbers do not say. It exits non-zero on a scope violation.
- Verified: two runs produce an identical table, and breaking one skill dropped
  recall to 33% with the per-class row naming the methodology that failed.
- `CONTRIBUTING.md` states the invariants a change may not weaken, how to add a
  skill with its false positives, and how to add a lab so a new detection has
  its precision measured rather than asserted.

- `@cyrion/knowledge`: ingest → chunk → embed → store → search over SQLite with
  an FTS5 index. Chunking is deterministic and heading-aware, so the same bytes
  always produce the same chunk identifiers and a citation made against an
  earlier sync still resolves to the paragraph it named.
- Retrieval is a capability rather than ambient context. `knowledge.search` runs
  through the tool gateway under a manifest grant, captures the whole retrieval
  as evidence before returning, and hands back at most eight snippets of at most
  600 characters, each carrying the reference to cite. The query is rewritten
  into terms first, so FTS5's operator grammar is unreachable from a string a
  model or a target produced.
- The citation lands on an observation, never on a finding: a standard explains
  why a check ran and never stands in for what the target returned. A test
  asserts that no corpus artifact appears in any finding's evidence.
- Skills never require `knowledge.search`. A skill that did would stop applying
  wherever nobody ran a sync, which would make coverage depend on whether an
  operator downloaded a standard; the planner adds retrieval when the manifest
  allows it.
- Embeddings are optional and local by default, fused with the lexical side by
  reciprocal rank rather than a weighted score, and every result names the mode
  that actually ran so keyword matches are never presented as semantic
  retrieval.
- Source descriptors, not corpora: the repository ships a pinned URL and a
  licence, a bare `sync` reaches nothing over the network, and a plaintext URL,
  a URL carrying credentials, or an unreadable response is refused with its
  reason recorded.
- Reports state the corpus version, document count, retrieval mode, and each
  source with its licence; the limitations section says in as many words that
  retrieved text is never evidence for a finding.

- A claim may now be a choice rather than a conjunction. `anyOf` states 2 to 8
  alternatives of which at least one must hold, bounded to one level: a skill
  file has to stay checkable at a glance, and a boolean tree is not. Anything
  stated beside it still has to hold, so the construct widens a claim without
  loosening the rest of it.
- With that, `web-security-headers` moved out of the worker into its file and no
  shipped detection is code any more — `packages/assessment` carries out checks
  without knowing what any of them is about. The finding identifier, the
  verdicts, and the benchmark table are unchanged by the move.
- The alternative that held is what the finding names, and what a failure found
  instead is what its detail names; both are written from the skill file rather
  than from the response. A body alternative against a truncated response is
  undecided rather than false.
- Fixed the load-time rule that refuses a body claim a probe could not decide:
  it read only the top level, so a body condition inside an `anyOf` was accepted
  and then dispatched under `http.probe`, which reports no body — `bodyExcludes`
  held against an empty string and would have raised a candidate from a body
  nobody fetched.

## 19. Open decisions for the maintainer

| Decision | Recommendation |
| --- | --- |
| Keep OpenCode as the runtime? | Keep as one adapter, stop treating it as the runtime. The provider layer should not depend on it. |
| Let the model author plans, or only review them? | Ship both: `--planner guarded` (current, deterministic transitions) and `--planner model` (model proposes, controller validates). Guarded stays the default until benchmarks justify otherwise. |
| Docker or Podman? | Support both through one interface; Podman rootless is a meaningful advantage for security-conscious users. |
| Free-form shell in the sandbox? | Not in v1. Add later behind a profile, with argv recorded as evidence. |
| Repo findings confirmable? | No. Static claims stay `candidate` unless a runtime target reproduces them. |
| License for skills? | Keep the format MIT; let contributed skill packs carry their own license, as the boundary doc already allows. |
