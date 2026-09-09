# Changelog

All notable changes to Cyrion Community are documented here.

## Unreleased

### The worker image

- The worker builds from `vxcontrol/kali-linux` now, and the base is a build
  argument rather than a line in the Dockerfile. `CYRION_WORKER_BASE` points it
  at your own mirror, a hardened build, or a different Kali distribution; the
  verification applies whatever it is, so a base missing something fails the
  build rather than producing a worker that cannot do what the catalog promises.
- `worker-manifest.json` records the base it was built from. Two images sharing
  a tag but not a base are not the same evidence, and a report that cites tool
  versions should be able to say where they came from.
- The image tolerates a base that already claims uid 1000. Several Kali
  distributions ship their own default user, and failing the build over a name
  Cyrion never needed would make a good base unusable — what matters is that uid
  1000 exists and owns `/work`.
- Fixed the build refusing a perfectly good image: `sh` had been added to the
  required-binary list, but that list detects tools by probing `--version`,
  `-V` and `-v`, and those are valid `dash` flags that print nothing. A working
  shell read as missing, the build exited non-zero, and it left
  `worker-manifest.json` truncated mid-JSON. The shell is now checked by running
  `sh -c`, which is both a real check and the one that matches what the image is
  for.
- A missing image that cannot be pulled now produces one message instead of a
  registry error followed by Cyrion's own. It names why container mode was
  chosen — automatically, unless `--sandbox` said so — because otherwise the
  remedy reads as a demand to an operator who only asked to assess a target.

### Watching the graph

- **The left pane is a delegation tree.** It answers who asked for whom: root
  delegates, a worker asks for a specialist, that specialist asks for another,
  and each sits directly under the task that requested it. A flat roster of
  seven agents hid the only thing worth knowing about the seventh, which is why
  it exists.
- Nodes are named by the **role** they carry, because what a specialist is for
  is what tells an `idor` branch from an `xss` one at a glance. Under each is
  what that agent is doing — a running one shows its current tool call and
  target, a finished one shows what it produced.
- Drawn depth-first, with each node deriving its elbow from the ancestors still
  continuing, so a branch under a finished sibling does not trail a vertical
  rule through empty space. `delegationTree` is a pure function over the
  snapshot, so the shape is asserted without a terminal.
- Fixed the swarm footer running past its own border: the three counts could
  total 33 characters in a 28-column pane. The depth is the least important of
  them, so it is what gives way now.
- **Named themes.** `CYRION_THEME` selects `cyrion` (the default teal), `ember`
  (warm, lower contrast), `glacier` (cool, high contrast for a projector) or
  `monochrome`; an unknown name falls back rather than failing to open, and
  `NO_COLOR` still wins over all of them.
- Colour is doing work rather than decoration, and it is tested as such: every
  theme's body text clears 7:1 contrast against the panel behind it, muted text
  is dimmer but never below 3:1, and the four state colours are distinct — a
  running agent, a warning and a failure must not read the same in a tree twenty
  lines deep.

### Exploitation, not reproduction

- **A proof may now do what an exploit does.** Every HTTP method, a request
  body, an authenticated session, redirects followed to a bounded depth, and up
  to 64 steps instead of 8 — enough to log in, enumerate, escalate and prove the
  consequence. A test that cannot write, cannot log in and cannot follow a
  redirect cannot demonstrate a broken access control, which is most of what an
  engagement is for.
- It is still a **plan** rather than a script a model wrote. That was never
  about limiting what a proof may do; it is what makes a run reviewable before it
  happens and reproducible after, and it matters more now that the vocabulary is
  wider, not less.
- **Credentials are sent, then redacted.** Testing authorization means
  authenticating, so `authorization`, `cookie`, `x-api-key` and the rest are now
  allowed on a step, on `http.request`, and in a skill's own checks. Before
  anything reaches disk their values are replaced with `[redacted by cyrion]` —
  in the recorded argv, in the bundle's request record, and in the response
  transcript, which also strips a `set-cookie` the server issued back. The
  header name stays, so a reader can see the request was authenticated.
  The old rule prevented the leak by preventing the test; this keeps the test.
- `REPRO.md` and the generated script now say that steps may change state, that
  they should be read before being run, and where to substitute your own
  credential for a redaction.
- Two bounds deliberately stay, and neither is about what an operator may prove.
  Volume is capped — 500 ms between steps, one connection at a time, a wall clock
  per step — because accidentally exhausting a client's service is the one
  outcome no engagement wants and no finding needs. And a body claim is refused
  on `GET`/`HEAD`, where the request would be sent without it and the step would
  prove nothing.

### The agent graph

- **A worker can now ask for the next agent.** A result may carry
  `proposedTasks`: the lens, the objective, the target and what it would need.
  An engagement stops being a pipeline with a fixed shape and becomes a tree
  that follows what it finds — a web worker meeting a reflecting login form asks
  for an injection specialist, and that specialist can ask for an authorization
  one.
- **A proposal is a request, never a dispatch.** This is the line the whole
  project is built on and it has not moved: a worker states the shape of the
  work, and the controller decides whether that task exists. There is
  deliberately no `id`, no `parentTaskId` and no `depth` field on a proposal —
  a proposer that could set its own depth could spawn forever, and one that
  could set its own parent could hide where a request came from. The controller
  assigns all three from the task that asked.
- Everything a proposal could have used to widen the engagement is checked
  twice. The controller holds the target to the manifest scope and the
  capabilities to the grant when the result is accepted, and the planner
  re-checks both before dispatching. A proposal outside the manifest fails the
  whole worker result rather than being dropped quietly, because a worker asking
  for it is worth seeing.
- A proposal past `maxDepth` is **dropped rather than clamped**: running
  something shallower than was asked for would make the delegation tree lie
  about what happened. No worker may propose the report.
- Added the specialist roles a delegation can name — `injection`, `xss`, `ssrf`,
  `auth`, `authz`, `idor`, `race`, `logic`, `repo` — alongside the existing five.
  A role is a lens, not a permission: what an agent may do still comes only from
  the granted capabilities, and every specialist returns an assessment.
- Fixed a gate that would have gone wrong with them: "assessments are done" only
  looked at `web` and `api`, so a validator could have started while a spawned
  specialist was still running, validating an incomplete run. It now waits for
  every assessing role, and the report depends on them too.

### A real toolbox

- **`shell.exec` runs a command the agent wrote, and `python.exec` runs code it
  wrote.** Every other capability is a typed adapter where Cyrion builds the
  argv; these two are deliberately the opposite, because the interesting half of
  an assessment is the part nobody wrote an adapter for. The deferred "not in
  v1" decision, reversed.
- The exploit is the artifact. `python.exec` stores the source it ran verbatim
  as a `poc` artifact, and `shell.exec` stores the command, exit code and output
  — including when the command failed, because what was tried and did not work
  is part of the account. A client gets an exploit they can re-run rather than a
  description of one.
- **Where the boundary is, said plainly.** A command is free text, so the scope
  check on a task's target is bookkeeping rather than containment for these two:
  `curl https://elsewhere.test` reaches elsewhere whatever the task declared.
  What holds a shell to the approved scope is the kernel egress allowlist in the
  container's network namespace, default DROP, derived from that scope. In local
  mode there is no such boundary at all, Cyrion says so before the run, and the
  runner that actually ran is recorded on every result and in the report.
- The runner's binary allowlist is lifted only for an engagement that granted
  one of these, and only by the caller from the granted capabilities — an
  adapter cannot arrange it for itself, and a test fails without that.
- Added `web.fuzz` (ffuf), `vuln.scan` (nuclei) and `sqli.test` (sqlmap), each
  parsing its tool's output into something a worker can reason about instead of
  a wall of banner text, scope-checked before the process starts, and rate-capped
  so a fuzz stays a fuzz. `nuclei` runs with out-of-band callbacks disabled: no
  interaction with a third-party server.
- `web.fuzz` was listed in the catalog as planned since phase 3 and now has an
  adapter. `cyrion tools` reports all five, and the worker image grows `sqlmap`,
  `python3`, `python3-requests` and a pinned `nuclei`; the build refuses to
  finish without them.

### Zero ceremony

- **`cyrion hack <target>` is the whole command.** No manifest to write, no
  scope lock to create, no attestation to compose, no capability checklist: the
  address is the decision. Every capability the target kind supports is granted,
  the run is autonomous, and a capability that cannot apply — a port scan against
  a URL, a repository inventory against a website — is dropped when the manifest
  is written rather than refused. `cyrion scan` still opens the form.
- Removed the authorization ceremony. An attestation is no longer required to
  start a run, `scope.lock` is a record an operator writes when they want one
  rather than a file the controller demands, and `cyrion scope lock --attest` is
  now optional. Authorization for an open-source tool is the operator's, held
  outside it, the way every comparable tool treats it.
- Removed the supervision defaults. Granting `poc.run` no longer forces the run
  to be supervised, `--allow-unsupervised-poc` is gone, and a repository
  engagement may carry it — nothing static becomes `confirmed` without a runtime
  target, which was always the real rule.
- Removed the remaining refusals that were preferences: plain http to a remote
  host, a port scan named against a URL, `--allow-host-mcp` for an MCP server in
  a container run (now said once, not refused), and `--allow-start` for
  `mcp serve` — pointing it at a manifest instead of a state database is what
  asks for a startable server.
- **What did not change: the run stays on the target you named.** Scope is
  derived from the address, and every request, redirect and crawled link is held
  to it. Not for compliance — because the model picks the next target, and a page
  that says "also assess 10.0.0.0/8" is an attack on the operator whose IP the
  packets leave from.

### Container by default

- `--sandbox` now defaults to `container` wherever a container engine is
  present, including on Kali and Parrot. A worker writes and runs code the
  operator did not read; that belongs somewhere other than their home directory
  with their credentials in the environment. `--sandbox local` is fully
  supported and one flag away.
- **This changes the execution environment for anyone already scripting
  Cyrion** without an explicit `--sandbox`. It is the one change in this release
  that is silent if you are not looking for it.
- The worker image is pulled on first use instead of refusing the run with a
  build command. Container being the default made that refusal the first thing a
  new operator would meet — the same ceremony, one step later. A machine with no
  engine and no image still says so, with `--sandbox local` as the remedy.

- A check can now state a claim that is a choice rather than a conjunction.
  `anyOf` offers 2 to 8 alternatives of which at least one must hold, which is
  what a methodology like "any one of these five headers is missing" actually
  says. Stating it as five separate checks would have reported one weak origin
  five times; stating it as a conjunction would have required all five to be
  missing before saying anything.
- With it, `web-security-headers` moved out of the worker and into its file, and
  **no shipped detection is code any more**. `packages/assessment` runs checks
  without knowing what any of them is about, so the whole starter methodology is
  a set of files a reviewer can read. The finding identifier (`F-HEADERS-…`),
  the verdicts, and the benchmark table are unchanged: `bun run bench` still
  reports 100% precision and recall with `web-security-headers` scoring 2 of 2.
- The alternatives are judged by the same code that judges every other
  condition, so a claim and its reason stay separate: the finding names the
  alternative that actually held, a failure names what it found instead, and
  both are written from the skill file rather than from the response. An
  alternative that reads the body of a truncated response leaves the check
  undecided rather than false — a body nobody read in full cannot say a marker
  is absent.
- The format is bounded where a reader has to check it: an alternative may not
  nest another, one alternative is refused as not being a choice, and anything
  stated beside `anyOf` still has to hold. `anyOf` widens a claim; it does not
  loosen the rest of it.
- Fixed the rule that refuses a body claim a probe could not decide: it read
  only the top level, so a body condition inside an `anyOf` passed the loader
  and was then dispatched under `http.probe`. A probe reports no body, so the
  alternative was decided against an empty string — and `bodyExcludes` *held*,
  which would have raised a candidate from a body nobody ever fetched. The rule
  now reaches inside alternatives, refusing the skill at load with the fix in
  the message; a test fails without it.

- Container mode now says what it will run in before it runs. Cyrion reads the
  identity of the worker image — the image ID, and the registry digest when
  there is one — and a missing image is refused before the engagement starts
  with the command that fixes it, instead of surfacing as a `docker` error at
  the first request, after the operator had already authorized the run.
- `containers/build-worker.sh` records what it built (`id`, `repoDigest`,
  `pinned`) alongside the tool versions, and `cyrion tools --sandbox container`
  reports the image it found rather than only that the engine answers — an
  engine with no worker image is ready for nothing.
- An image that differs from the recorded one is reported, not refused: two
  correct builds of the same Dockerfile differ. A published image can be pinned
  (`"pinned": true`) and then a different one is refused, and `--image` always
  means the operator chose deliberately. The image identity is recorded in the
  report beside the tool versions, because `nmap 7.99` from one image is not the
  same claim as `nmap 7.99` from another.
- Fixed a container start race: workers start the sandbox lazily and in
  parallel, so two tasks arriving together each created a container with the
  engagement's name — the engine refused one, failing the run, and before that
  the second could remove the container the first was using. Startup is now
  once-only, with a regression test that fails without the fix.
- The release carries the worker image record: `bun run release:artifacts`
  writes `worker-manifest.json` beside the tarball and SBOM and checksums it,
  and `release:check` refuses a package whose worker manifest does not identify
  the image and the tools measured inside it.

- Added `http.crawl`, and with it a run that finds its own surface. Recon walks
  the approved origin, the planner assesses the endpoints it found, and an
  engagement stops being an assessment of the list of addresses somebody typed.
  It reads links the site published — `href`, `src`, form actions — with no
  wordlist, no path guessing, and no request that changes state, bounded by
  pages, depth, the task's clock, and a gap between requests.
- A discovered address is a report, not a permission. A link outside the
  approved scope is counted in the inventory and never followed; an observation
  may name what it found (`assets`), and the controller refuses the whole worker
  result if one of those is out of scope. The planner checks again before
  dispatching, so neither check is the only one.
- A scope pattern stops being a task once the pages under it are known:
  assessing `https://app.example.com/api/*` and its pages both would report one
  page's issue twice.
- `http.crawl` is implemented in Cyrion rather than shelling out to katana, so
  `--sandbox local` still works on a machine with nothing installed; in a
  container it goes through curl like every other HTTP capability, under the
  same egress allowlist. `cyrion tools` now lists it as built in.

- A skill can now carry itself out. `checks` in a `*.skill.json` file state the
  request to make and the conditions that make the answer a finding, and the
  worker runs them without knowing what the methodology is about. Adding a
  detection is adding a file: no branch in `packages/assessment` mentions it.
- One statement drives all three moments a claim passes through. The conditions
  are the same vocabulary a proof-of-concept step uses, so discovery raises the
  candidate, validation repeats exactly that request and those conditions from
  the record alone, and `poc.run` compiles the same check into the bundle that
  reproduces it. A contributed skill cannot disagree with itself, and
  `cyrion replay` works for it from the first run.
- Added `http.request`: one typed request against an approved URL — a path under
  the target, chosen request headers, and an answer whose headers and body a
  check can read — captured in full as evidence. The path is re-checked against
  scope, so a check reaches only what the operator approved, and a credential
  header is refused by name.
- A check is bounded where it is written. The loader refuses a body claim from a
  skill that did not require `http.request` (a probe could not decide it), a path
  that leaves the approved target, a credential header, a method that changes
  state, and checks on roles or target kinds that never run them.
- `skills/api-object-boundary.skill.json` now states its own check instead of
  being a branch in the worker, in discovery, in validation, and in the proof
  plan. The finding identifier, the verdicts, and every benchmark number are
  unchanged — `bun run bench` still produces the published table byte for byte.

- MCP now works in both directions all the way through. `cyrion mcp serve
  --allow-start` serves `start_engagement` for the engagement the operator
  prepared: the caller repeats the attestation recorded in the scope lock, and
  picks nothing else — scope, capabilities, sandbox, and authorization were all
  decided before the server spoke its first frame. An invented attestation is
  refused, the run starts once, and the record is read live from the running
  controller so a peer watching it sees it progress.
- An operator-approved MCP tool is now a capability a worker calls through the
  tool gateway, not just an operator instrument. Three decisions have to agree:
  the tool is named in `mcp.json`, the manifest grants the capability it answers
  as, and a skill asked for it. The whole exchange — server, tool, arguments,
  answer, duration — is captured as evidence before a bounded summary reaches
  the worker, which records it as a cited observation and never as a finding.
- An MCP tool may not answer as a capability Cyrion implements itself, and a
  granted capability nothing can serve is still refused before the run starts.
  An MCP server runs on the host, outside the container and its kernel egress
  allowlist, so container runs refuse it unless `--allow-host-mcp` says
  otherwise; the report names every MCP tool the run could call and the version
  that answered.
- Fixed the MCP client holding the process open for a full request timeout after
  its last answer: the per-request timer is now cleared when the response
  arrives. `cyrion mcp call` returned in 30 seconds and now returns in half a
  second.

- The new-assessment form is now under `Mission` as well as at `cyrion scan`:
  press `n` to fill in a target, capabilities, sandbox, mode, and who authorized
  it, and `s` to start it. The next assessment begins in the terminal that
  showed the last one instead of in a second shell, and the same form, keys, and
  refusals apply in both places. It is available while watching someone else's
  run too: starting one is a new engagement here, never a reach into the watched
  one.
- Starting an assessment from `Mission` cancels the engagement on screen and
  releases its state before the new manifest and scope lock are written, so two
  engagements never hold the same artifacts. Only the sandbox carries over; the
  target and the attestation are always decisions about the new assessment.
- While the form is open it owns the keyboard, so a key meant for a field cannot
  pause the run or export a report behind it. `1`–`6` and `[`/`]` still move
  between views, and the draft survives the trip.
- Fixed the footer taking a settings or filter value as Root chat: focusing the
  input for a field no longer switches the terminal into chat mode, so `Enter`
  applies the LLM endpoint or the findings filter instead of sending it to Root.

- Added `@cyrion/knowledge` and `cyrion knowledge sync|status|search|forget`: a
  local corpus of public standards, ingested by an explicit command and stored
  in SQLite with a full-text index. Chunking is deterministic, so the same bytes
  always produce the same chunk identifiers and a citation made last month still
  resolves to the paragraph it named.
- Retrieval is a **capability**, not ambient context. `knowledge.search` goes
  through the tool gateway like any other capability, under a grant the manifest
  made, and the whole retrieval — query, hits, corpus version — is captured as
  evidence before a bounded summary comes back. Snippets are capped at eight per
  call and 600 characters each.
- The query is rewritten into terms before it reaches the index. FTS5 has its own
  operator grammar and a string that arrived from a model or a target is not
  allowed to reach it, so a worker's query returns nothing rather than erroring
  the capability.
- The citation lands on an observation, never on a finding. What a standard says
  is not why a target answered the way it did, and a test asserts that no corpus
  artifact ever appears in a finding's evidence.
- A skill never requires `knowledge.search`. One that did would stop applying on
  a machine where nobody ran a sync, making coverage depend on whether an
  operator downloaded a standard; the planner adds retrieval when the manifest
  allows it and the methodology works either way.
- Embeddings are optional and local by default: `--embed` with `roles.embedding`
  bound adds vectors, and search fuses them with the lexical side by reciprocal
  rank rather than a weighted score, because bm25 and cosine are not on a
  comparable scale. Every result states the mode that actually ran, so keyword
  matches are never presented as semantic retrieval.
- The repository ships source descriptors, not corpora: a pinned URL, a licence,
  and the command. A bare `sync` ingests only what is already on the machine —
  naming `--source` is what authorizes a fetch — and a plaintext URL, a URL
  carrying credentials, or a response a chunker cannot read is refused with the
  reason recorded.
- Reports state the corpus version, its document count, the retrieval mode, and
  each source with its licence, and the limitations section says plainly that
  retrieved text informed which checks were run and is never evidence for a
  finding.
- A run that grants `knowledge.search` with no corpus behind it is refused before
  it starts, rather than failing at dispatch halfway through authorized work.

- Container mode now works end to end. The `cyrion-sandbox` bridge is created on
  first use — nothing created it before, so every container run failed on a
  missing network — and a container left behind by a run that died is removed
  before a new one starts instead of blocking the name.
- `http.probe` runs inside the container in container mode. It was calling
  `fetch` from the Cyrion process, so the capability an engagement uses most
  never entered the sandbox and the kernel egress allowlist did not govern it.
  Local mode still uses the in-process path, which is what lets it work on a
  machine with nothing installed.
- Fixed pinned addresses reaching curl as separate `--resolve` flags. curl
  commits to the first set and does not fall back, so a host that answered with
  an IPv6 address was unreachable from an IPv4-only sandbox — silently breaking
  container probes and proof bundles against any dual-stack target. They are now
  one comma-separated entry, IPv4 first, IPv6 bracketed because the entry is
  itself colon-separated.
- A loopback target is refused before a container run starts, with the reason: a
  container's loopback is its own, so a lab on this machine is not there.

- Added repository assessment. `repo.inventory` is built in and needs nothing
  installed: it reports languages, dependency manifests, entry points, and
  configuration files, skipping vendored and build directories and refusing to
  follow a symlink out of the approved root. `repo.scan` (semgrep, named
  rulesets only — never `--config auto`, which would fetch rules mid-engagement)
  and `repo.deps` (grype) are implemented and report when their tool is present.
- A repository finding is a **static claim** and the controller now refuses to
  let one reach `confirmed`. Nothing in a checkout is running, so nothing in one
  can be reproduced; it stays a candidate until a runtime target reproduces it.
- `cyrion scan` accepts repository targets — `.`, `./services/api`, `/srv/app`,
  `~/code/app` — and builds a `repository` engagement for them. The root is
  resolved once when the manifest is written, so a relative path cannot mean one
  directory to the scope check and another to the capability.
- The planner no longer skips repository roots, and a task that wants a
  capability the manifest did not grant now falls back to one it did rather than
  asking for something the controller will reject. The reporter needs no
  capability at all and was the case that exposed it.

- Added `cyrion watch <id> --state <path>`: a read-only attachment to an
  engagement running elsewhere. Every view works, including the live transcript,
  because the watcher rejoins the stored snapshot with the event log — a stored
  snapshot carries no events of its own. Pause, resume, approve, deny, and Root
  chat all refuse rather than reaching into an engagement another process owns.
- Added a findings filter on `/`, matching identifier, title, asset, verdict,
  severity, and methodology, with `esc` to clear it.
- Long-running tools now report while they work. `net.portscan` says which hosts
  it has found so far and `poc.run` names the step it is on; the gateway
  throttles those notes to one a second and bounds each to 200 characters, so a
  chatty tool cannot flood the durable log.
- `<` and `>` fold the side panes away and give the space to the centre.
- `cyrion tools` no longer advertises capabilities nothing implements. Seven
  catalog entries — `http.request`, `repo.inventory`, `repo.scan`, `repo.deps`,
  `dns.enum`, `http.crawl`, `web.fuzz` — are marked `NOT IMPLEMENTED YET`, and a
  manifest granting one is refused before the run starts instead of failing at
  dispatch. A test keeps the catalog from drifting from the adapters again.

- Added the **Attack** view (`2`): the engagement as it happens to the target,
  one line per exchange — who asked, which capability, against which address,
  and what came back. Requests, answers, refusals with their reason, findings
  changing state, and Root decisions. Leases, heartbeats, and budget updates are
  left out, because they are how the controller keeps time rather than what
  happened to the site.
- Capability adapters now report a short outcome — `200 text/html · 1.2 kB`,
  `reproduced · 1 step · bundle E-0014`, `3 open across 1 host` — carried on
  `tool.request.completed` so the transcript can show the exchange without
  opening an artifact. It is target-derived, so it is bounded to 200 characters
  and stripped of control characters before it reaches a durable event.
- The transcript follows the newest line, and scrolling back releases the pin so
  an arriving event cannot yank the screen away mid-read; `End` or `f` re-arms
  it.

- Added `@cyrion/benchmark` and `cyrion bench`: three labs with ground truth kept
  outside the code being measured, scored for precision, recall, and
  inconclusive rate **per methodology**, plus reproduction rate, cost and wall
  clock per confirmed finding, and a scope-violation count that must be zero.
  Only confirmed findings count as claims, and `inconclusive` is its own column
  rather than folded into either side.
- One lab answers inconsistently on purpose. Nothing there can honestly reach
  `confirmed`, so a run that confirms is guessing and `bench` exits non-zero.
- Published `BENCHMARKS.md` from the code being released, carrying the Cyrion
  and fixture versions, the runtime that produced it, the command to reproduce
  it from a clean clone, and a section on what the numbers do not say.
- Rewrote the contribution guide around the invariants a change may not weaken,
  how to write a skill including the false positives that would make its claim
  wrong, and how to add a lab so a new detection has its precision measured.
- Fixed `cyrion bench` reading its own `--report` and `--json` flags after
  dispatching a lab had already replaced the argument list.

- Added `cyrion scan`: one command from an address to a running assessment. With
  no flags it opens a form — target, capabilities, sandbox, mode, and who
  authorized it — and starts the run on `s`. With `--target` and `--attest` it
  runs unattended. Either way it writes a manifest and a scope lock the operator
  keeps, so the run stays repeatable and reviewable.
- The form defaults to the two read-only capabilities. Reproduction is opt-in
  and forces a supervised run; port scanning is hidden for a URL target, since
  it needs a host or a range. Plain http to a remote host is refused before the
  scan starts rather than after.
- A bare name is treated as a website and an address, range, or port list is
  not, so a host target keeps the capabilities that only apply to one.

- The deadline error now names the numbers: elapsed against allowed, and how
  many tasks finished. A run that completed all its work and then tripped the
  clock needs a larger `budgets.maxDurationMs`, not a bug report.

- The guarded review prompt now states what the controller has already
  validated, and which limits the reviewer does not own. A live run stopped an
  authorized engagement because the model read `maxConcurrentAgents` as a queue
  limit when it is a batch size — the controller dispatches that many ready
  tasks at a time and the rest wait. A reviewer asked to re-derive enforcement
  it cannot see produces false stops, so it is now told to stop only for what
  the controller cannot check and to accept when in doubt.

- A truncated structured answer now earns one retry of the same mode with a
  wider ceiling, instead of counting as a mode that does not work. On a
  reasoning model the output budget covers the thinking as well as the answer,
  so a ceiling sized for the answer alone starves it — the failure names its own
  remedy, and the client acts on it. The retry never widens past the ceiling a
  role binding set.
- Review requests ask for 8192 output tokens rather than 2048, for the same
  reason, and a cut-off answer now says so instead of reporting an opaque
  finish reason.

- Reviews now bound their own output. A guarded review is a verdict plus a
  sentence, but nothing capped generation, so a thinking model spent minutes on
  reasoning nobody reads and timed out the engagement. Reviews ask for at most
  2048 output tokens and an authored plan for 8192.
- A role binding's `maxOutputTokens` and a request's are both ceilings, so the
  tighter one now wins: a caller cannot widen what the operator allowed, and an
  operator's cap cannot silently ignore a task that needs less.

- The structured-output ladder now remembers the modes an endpoint has said it
  cannot serve. A 400 naming the parameter — DeepSeek answering "this
  response_format type is unavailable", or "thinking mode does not support this
  tool_choice" — is a settled fact about the endpoint, and re-asking on every
  later request spent the whole budget rediscovering it. Transient failures and
  off-schema answers stay retryable.
- Raised the default provider-review budget for an engagement to 150 seconds,
  which a thinking model needs for one answer now that the budget is spent on
  attempts that can succeed.

- A structured request now spends one wall-clock budget across the whole
  output ladder instead of one per rung. Five modes each given the full timeout
  let a slow endpoint hold a single decision for five times as long as the
  caller agreed to wait, sailing past the engagement's own deadline, which the
  controller only checks between transitions.
- Provider review in an engagement is bounded by `--model-timeout`, 90 seconds
  by default, so a provider that will not answer cannot outlast the run it is
  reviewing.

- `cyrion engage` and `cyrion ci` now take `--planner assessment|llm|llm-author`
  and `--workers capability|llm`, so a provider can review a real engagement and
  not only the fixture demo. Real runs stay deterministic by default and contact
  no model unless asked; the headless summary and the report state what actually
  planned the run, and the report records the model bound to each role.
- A review mode inherited from saved defaults degrades to the deterministic
  runtime with its reason rather than stopping an authorized assessment; one
  named on the command line is still refused outright.

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
