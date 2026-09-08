# Changelog

All notable changes to Cyrion Community are documented here.

## Unreleased

- Added HTML, SARIF, JUnit, and CSV reports beside Markdown and JSON, all
  rendered from one record so the client report, the code-scanning dashboard,
  and the pipeline gate cannot disagree about what was found. HTML is
  self-contained and fetches nothing when opened; each format escapes untrusted
  finding text for its own grammar, including quoting a spreadsheet formula.
- The report record now states the canonical scope hash and the operator
  attestation, the skills that produced each task, the sandbox and models and
  tool versions when the caller supplies them, budgets granted against consumed,
  and validation records. It discloses when discovery and validation used the
  same model, and when no attestation was bound to the run.
- Added `cyrion ci`: runs an engagement, writes the selected report formats, and
  exits non-zero when the gate fails. The gate counts confirmed findings at or
  above `--fail-on`, and also fails an engagement that did not complete or that
  recorded refusals. Reports are written before the exit code is decided.
- `cyrion report` gained the new formats and `--out`.
- Added `@cyrion/mcp`. As a server, `cyrion mcp serve` exposes an engagement over
  JSON-RPC on stdio with `engagement_status`, `list_findings`, `get_evidence`,
  and `render_report`; it is read-only, and `start_engagement` is refused at the
  protocol level rather than merely hidden. Artifact text is bounded, returned
  only when asked for, and withheld when it no longer matches its digest.
- As a client, `mcp.json` declares operator-approved servers with an explicit
  tool allowlist mapped to Cyrion capability names; the manifest still decides
  what a worker may call. Servers run with a scrubbed environment and only the
  variables named in `passEnv`; a credential written into the file is refused.
  `cyrion mcp list` and `cyrion mcp call` drive one by hand.
- The CLI dispatch moved to the end of its module. Two commands had already
  shipped a reference error because a `const` they used was still in the
  temporal dead zone when the dispatch ran.

- A structured-output rung now counts as working only when the object satisfies
  the caller's contract, not merely when it parses. Hosted APIs that ignore an
  unknown constraint such as `guided_json` while honouring the `json_object`
  beside it were landing on a rung that constrained nothing, and a well-formed
  but off-schema answer then failed the engagement; it now costs one rung and
  the ladder keeps descending. A model-authored plan is deliberately exempt: it
  is judged by the controller and recorded as `root.decision.rejected`.
- Model readiness is decided by the endpoints roles actually bind to. An
  endpoint kept in a config for later — unreachable, or missing a credential
  nothing asks for — no longer fails `cyrion models --check` or downgrades a
  run whose own roles all resolve. When the check does fail it names the
  endpoint and the roles bound to it.
- `kind` errors now say that a vendor name is not a wire protocol and list the
  vendors that speak `openai-compatible`; an `apiKeyEnv` holding what looks like
  a live credential is refused with instructions to move it and rotate it, and
  the value is never echoed.

- A model runtime that cannot be satisfied no longer stops Cyrion from opening.
  When a saved default names an LLM or OpenCode runtime that is missing or
  unreachable, the terminal starts with the deterministic runtime, states the
  reason in the footer and in the Settings sidebar, and reports what actually
  ran. A runtime named on the command line still fails loudly: that is a
  request for this run, not a stale default.
- The LLM endpoint is now configurable in the terminal. Settings gained endpoint
  kind, endpoint URL, model, and key-variable fields; the three text fields are
  typed in the footer editor (`Enter` to open and apply, `Escape` to cancel) and
  saved to the owner-only `.env`. Only the credential variable's name is stored,
  never the key.
- Saving Settings validates with the same rules the provider layer enforces, so
  the page cannot store a configuration that would only fail at the next launch;
  clearing a value now removes the line instead of leaving a blank assignment.
- `cyrion models` reports an unconfigured endpoint as a state and exits zero;
  `--check` still exits non-zero.
- Fixed a temporal-dead-zone crash that replaced several command errors with
  "Cannot access 'MODEL_SETUP_HINT' before initialization".
- `apps/cli` now declares the workspace packages it imports.

- Added `poc.run`: a validator turns a candidate into a bounded, declarative
  reproduction plan and executes it under the same scope, pinning, and evidence
  rules every other capability follows. The contract admits reads only — GET,
  HEAD, or OPTIONS, no request body, no credential-bearing header, at most eight
  rate-limited steps, redirects refused — so destructive primitives are absent
  from the vocabulary rather than discouraged in a prompt.
- Every run writes a proof bundle: the plan, the exact argv, the scrubbed
  environment, the pinned addresses, the tool version, each raw exchange, the
  per-step outcome, and a `REPRO.md` ending in a standalone shell script that
  reproduces the finding on a clean machine without Cyrion.
- Added `cyrion replay <finding-id>`: re-runs a stored bundle, re-checking every
  step against the *current* manifest rather than the recorded one, and exits
  non-zero when the verdict no longer matches.
- Findings now carry `reproduction` — verdict, bundle, steps, runner, and time —
  recorded separately from severity. The controller refuses a validator whose
  status disagrees with its bundle, one that cites a bundle it never captured,
  and any discovering worker that claims a reproduction it did not run.
- A validator now receives the artifacts its candidate cites, so it can state
  the claim as a checkable condition; it still never sees the discovering
  worker's transcript.
- `cyrion engage` runs supervised whenever the manifest grants `poc.run`, unless
  the operator passes `--allow-unsupervised-poc`, and refuses the capability on a
  repository engagement: a static claim needs a runtime target to be confirmed.
- Reports state reproducibility per finding and count reproduced findings apart
  from confirmed ones; the limitations section is now derived from the run
  instead of asserting a fixture caveat over a live assessment.

- Added `cyrion engage`: a real assessment over the capability adapters, planned
  from the approved scope and the loaded skills, with independent validation of
  every candidate and a report rendered from accepted records.
- Added `@cyrion/skills`, a reviewable JSON methodology format with an
  applicability rule (target kind, role, and required capabilities) and a loader
  that refuses a malformed pack rather than silently shrinking the methodology.
  Shipped a starter pack covering surface inventory, browser protection headers,
  object-level authorization, and independent reproduction.
- Added `@cyrion/assessment`: a deterministic planner that walks recon,
  assessment, validation, and reporting, and workers that derive every claim
  from a capability result the tool gateway admitted.
- Tasks and findings now record the skill that produced them, and a validator
  receives the candidate record — never the discovering worker's transcript.
- Added `fixtures/lab`, a controlled target with two findable issues and two
  endpoints that behave correctly, so precision and recall are both measurable.
- Agents of the same role are now numbered distinctly, and the terminal reports
  the execution sandbox instead of labelling a real run as fixture.

- Added `@cyrion/sandbox` with two execution modes. Local mode runs tools on the
  operator's own machine — the Kali and Parrot path — keeping the capability
  allowlist, adapter-built argv, a scrubbed environment, a private working
  directory, output and time ceilings, and process-group termination, and
  stating plainly which isolation it cannot provide.
- Container mode runs one hardened container per engagement: unprivileged user,
  read-only root, tmpfs work directories, no host mounts or engine socket, all
  Linux capabilities dropped, resource ceilings, and a default-DROP egress
  allowlist installed into the container's own network namespace from the host.
  Cyrion refuses to start when that allowlist cannot be installed.
- Added `@cyrion/capabilities` with `dns.lookup`, `http.probe`, `net.portscan`,
  and `net.tls`. Each validates its target against the scope engine, builds argv
  itself, and writes raw output to the evidence store before returning a bounded
  summary. Redirects are reported rather than followed, and pinned hosts are
  rechecked before a request.
- Added `cyrion tools` (capability and toolchain readiness with per-distribution
  install commands, never an implicit installation) and `cyrion probe` (run one
  capability by hand under the same enforcement).
- Added `containers/Dockerfile.worker` and a build script that refuses to finish
  unless every required binary answers inside the image, recording tool versions
  for evidence.

- Added `@cyrion/scope`: typed target expressions for hosts, CIDR ranges with
  port lists, IPv6 literals, URLs with path prefixes, and repository roots, with
  exclusions evaluated first and no implicit crossing between kinds, schemes, or
  ports.
- Added DNS pinning that refuses an address which was not resolved at task start
  and names rebinding when a public host turns inward, redirect checks that
  refuse an out-of-scope hop or an https-to-http downgrade, and address
  evaluation for a future egress allowlist.
- Added `cyrion scope check` and `cyrion scope lock`: an operator attestation is
  bound to one canonical scope hash, and `--scope-lock` makes the controller
  refuse to start when the scope has changed since it was attested.
- The controller and tool gateway now decide scope through the engine, reject an
  unparsable scope before starting, and record the scope hash on
  `engagement.started`; the terminal shows the short hash and lock state.

- Added `@cyrion/llm`: a provider-agnostic model layer with OpenAI-compatible,
  Anthropic, and native Ollama clients, per-role model routing, a
  structured-output ladder that is discovered once per endpoint, bounded and
  credential-safe transport, and optional per-model pricing.
- Added `cyrion models` for endpoint, catalog, credential, and structured-output
  readiness, and `--planner llm|llm-author` plus `--workers llm` for engagements
  driven by any configured provider, including a local vLLM or Ollama server.
- Moved the reviewer contracts and provider JSON Schemas into `@cyrion/contracts`
  and the evidence preview builder into `@cyrion/evidence`, so a runtime adapter
  cannot drift from the validated shape.
- Added adversarial coverage for model-authored plans: out-of-scope targets,
  ungranted capabilities, invalid role/output pairs, and non-decisions are
  rejected before dispatch.
- `cyrion demo` replaces its own artifacts from an earlier fixture version and
  reports what it replaced, instead of refusing to start. It only ever runs
  shipped fixtures, so it owns that directory; `--fresh` still forces a clean
  run, and `cyrion engage`, which runs an operator's own manifest, never
  replaces anything. Made the headless supervised-mode error name the setting
  that caused it.

- Rebuilt the terminal against the product design references: a three-segment
  header, evenly filled view tabs, panel headings with state tokens, a ruled
  task board with per-task elapsed time, a Root dispatch inspector, finding
  cards, budget meters, and plain-language activity lines.
- Sized every panel from the terminal width so rules, tables, and cards stop at
  their own border, and applied responsive pane widths on resize only.
- Added `r` to export the current engagement's Markdown report from the
  terminal, with the written path shown in the footer.

## 0.1.0-alpha.2 — 2026-09-07

- Added evidence-aware guarded worker review with exact metadata matching,
  engagement/worker binding, post-read SHA-256/size verification, and bounded
  text-only provider previews; malformed worker results are rejected before a
  provider call, non-text or invalid evidence remains metadata-only, and
  controller admission still runs afterward. Clarified the harmless fixture comparison fields so
  clean enforcement and the known-positive bypass cannot be confused.
- Added guarded role-specific OpenCode worker review. Providers may summarize
  or flag canonical fixture results while findings, evidence, provenance,
  verdicts, and report content remain immutable controller inputs.
- Cache structured-output incompatibility per OpenCode runtime and use strict
  JSON text mode for subsequent reviews; expanded demo deadlines to three
  minutes for slower provider-backed sessions.
- Added guarded OpenCode Root planning with CLI and Settings selection. The
  provider can review or stop exact controller-generated transitions but cannot
  alter their task identities, targets, capabilities, or dependencies.
- Fixed Root-chat keyboard routing so focused text entry always receives letter
  keys; removed the conflicting `h`/`l` navigation aliases in favor of `[`/`]`.
- Added a fifth terminal Settings view for safe provider/model selection and
  persisted mode, fixture, and color defaults without rendering or rewriting
  provider credentials.
- Fixed packaged and globally linked TUI startup by resolving OpenTUI native
  libraries through explicit platform-specific optional dependencies, with a
  packed-consumer TUI smoke check in the release gate.
- Added an interactive connected-provider/model picker and refreshed the
  terminal with translucent blue-black Kali-inspired panels and brighter cyan
  focus states based on the original product references.
- Added a packaged environment template, provider/model validation,
  OpenCode provider readiness diagnostics, and visible runtime configuration in
  the terminal without enabling unscoped live assessment.
- Added a repeatable release-artifact command that emits the npm tarball, a
  CycloneDX 1.6 production-dependency SBOM, and SHA-256 checksums after testing
  the installed package from a clean temporary consumer.
- Made the controller own the engagement evidence store and require canonical
  metadata plus SHA-256 verification before accepting worker evidence.
- Added recovery-time evidence revalidation and adversarial tests for missing,
  forged, and post-capture-tampered artifacts.
- Implemented durable supervised delegation with interactive approve/deny
  controls, explicit headless opt-in, audit events, and restart revalidation.
- Added strict runtime parsing for manifests, Root decisions, worker results,
  evidence metadata, findings, and provider usage.
- Bound worker output to task targets and agent provenance, enforced fresh
  independent validation, and rejected cyclic task graphs.
- Added bounded `task.result.rejected` audit events and adversarial output tests.
- Run fixture capabilities in short-lived subprocesses with a scrubbed
  environment, private work directory, bounded streams, and abort-driven
  termination.
- Added explicit hardening tests and documentation for the remaining
  container/egress boundary.

## 0.1.0-alpha.1 — 2026-09-06

- Added the durable Root controller, task leases, budgets, event persistence,
  restart reconciliation, and scope-bound tool gateway.
- Added deterministic confirmed, clean, rejected, and incomplete fixtures.
- Added local evidence storage with SHA-256 verification and safe metadata.
- Added the four-view interactive product terminal with worker and evidence
  inspection, Root chat, pause/resume, responsive layouts, and `NO_COLOR`.
- Added versioned Markdown/JSON report exports, durable status commands, release
  packaging checks, and public contribution/security documentation.

This alpha contains fixture workers only. It does not ship a live network
assessment adapter or claim parity with the commercial Cyrion platform.
