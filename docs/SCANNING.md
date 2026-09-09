# Starting a scan

```sh
cyrion hack example.com
```

That is the whole command. The address is the only decision: every capability
the target kind supports is granted, the run is autonomous, and it happens in a
container. `cyrion scan` with no target opens a form for the same choices.

Everything else on this page is that command with flags, or the parts you may
want to change.

## Only scan what you are authorized to scan

Cyrion does not ask, and it will point at whatever you name. That makes the
authorization entirely yours: for your own site it is a formality, and for
anyone else's you need their written permission before you run this, with their
hosting provider's terms applying on top of it. Unauthorized scanning is a
criminal offence in most jurisdictions.

What Cyrion does do is stay on the target you named. The scope is derived from
your address and everything — every request, every redirect, every link the
crawler finds — is held to it, so a run cannot wander onto a third party because
a page linked there. `cyrion scope lock` writes down what was approved if you
want that record; nothing requires it.

## The form

| Field | What it decides |
| --- | --- |
| **Target** | The address. `example.com` becomes `https://example.com/`, and a bare origin covers everything under it. Add a path — `https://example.com/app` — to narrow it. |
| **Capabilities** | What the scan may do. `space` toggles the one under the cursor. |
| **Sandbox** | `LOCAL` runs tools on this machine. `CONTAINER` isolates them and enforces an egress allowlist in the kernel; it needs a container engine. |
| **Mode** | `AUTONOMOUS` dispatches each validated transition. `SUPERVISED` waits for your approval before every one. |
| **Authorized by** | Optional. Recorded in the report and the scope lock when you fill it in. |

Keys: `↑↓` move, `←→` change a choice, `space` toggles a capability, `enter`
types into a text field, `s` starts, `esc` cancels.

## Starting the next one without leaving the terminal

The same form is under `Mission`: press `n`. It is the form above, with the
same keys, over whatever is on screen — so the assessment that follows a run is
started from the terminal that showed it, not from a second shell.

Starting one closes the engagement you were watching: the terminal cancels its
workers and releases its state file before the new manifest is written, because
two engagements must never hold the same artifacts at once. What the finished
run recorded stays on disk and can be reported on afterwards.

Only the sandbox carries over — it is a fact about this machine. The target does
not: it is the decision the new assessment is about.

### Capabilities

| Capability | What it does | Default |
| --- | --- | --- |
| `dns.lookup` | Resolves the host and pins the addresses everything else is held to | on |
| `http.probe` | Fetches pages and reads headers | on |
| `http.request` | One typed request — a path under the target, chosen headers, a readable body — for the checks a skill declares | on |
| `http.crawl` | Follows the links a site publishes to find endpoints under the approved scope, bounded by pages and depth | on |
| `net.tls` | Inspects the certificate and protocol | on |
| `poc.run` | Reproduces a finding against the live target and keeps a replayable bundle | on |
| `net.portscan` | Port and service discovery — hosts and ranges only | on, for host targets |
| `repo.inventory` | Languages, dependency manifests, entry points, configuration files | on, for repository targets |
| `repo.scan` | Static analysis with public semgrep rulesets | needs `semgrep` |
| `repo.deps` | Known-vulnerable dependencies via grype | needs `grype` |
| `web.fuzz` | Content discovery with a wordlist, rate-capped | needs `ffuf` |
| `vuln.scan` | nuclei templates, with out-of-band callbacks disabled | needs `nuclei` |
| `sqli.test` | Injection testing with sqlmap | needs `sqlmap` |
| `shell.exec` | Runs a command the agent wrote, inside the sandbox | on |
| `python.exec` | Writes and runs a proof-of-concept exploit | on |

**Everything the target kind supports is granted.** A capability that cannot
apply — a port scan against a URL, a repository inventory against a website — is
dropped when the manifest is written rather than refused, so naming an address
is the whole decision. Pass `--capabilities` to narrow it.

### The shell, and where its boundary is

`shell.exec` runs a command the agent wrote; `python.exec` runs code it wrote.
That is what lets an assessment do the part nobody wrote an adapter for, and it
moves where the boundary sits — so it is worth being exact about.

A command is free text. `curl https://elsewhere.test` reaches elsewhere whatever
target the task declared, so the scope check on a task's target is bookkeeping
rather than containment for these two. What actually holds them to the approved
scope is the **kernel egress allowlist** installed into the container's network
namespace, derived from that same scope and defaulting to DROP.

| | `--sandbox container` (default) | `--sandbox local` |
| --- | --- | --- |
| Reaches only the approved scope | Yes, enforced by the kernel | **No** |
| Filesystem | Read-only image, tmpfs work directory, no host mounts | Your machine |
| Runs as | Unprivileged container user | You |

That table is why container is the default. Local mode is fully supported and
right for a Kali box you already trust, but with a shell granted it isolates
nothing — Cyrion says so on the way past, and the report records which runner
actually ran.

Every command, its exit code, its output, and the source of every exploit are
captured as evidence before the summary reaches the agent.

## Scanning a repository

```sh
cyrion hack .
cyrion hack ./services/api --capabilities repo.inventory,repo.deps
```

`.`, `./services/api`, `/srv/app`, and `~/code/app` are all repository targets;
a bare name like `example.com` is still a website. The path is resolved once,
when the manifest is written, so the scope check and the capability agree on
what was approved whatever directory a later run starts from.

Dependency and build directories — `node_modules`, `vendor`, `dist`, `target`,
`.venv` and their kin — are skipped, because they hold code the project did not
write and counting them inflates every total. Symlinked directories are not
followed: a checkout may not walk the walker out of its approved root.

**Everything a repository scan finds is a static claim.** Nothing in a checkout
is running, so nothing in one can be reproduced, and the controller refuses to
let a repository finding reach `confirmed` at all. They stay candidates until a
runtime target reproduces them — which is the honest state for a claim nobody
has executed.

## Without the form

```sh
# Prepare and run in one step
cyrion hack https://example.com

# See what it would do, and start it later yourself
cyrion hack https://example.com --dry-run

# More capability, a different sandbox, unattended
cyrion hack https://example.com \
  --capabilities dns.lookup,http.probe,net.tls --sandbox container --headless
```

`scan` writes two files into `.cyrion/engagements` and hands them to `engage`:

- `ENG-example-com-6f5a4333.json` — the manifest, with the scope and budgets
- `ENG-example-com-6f5a4333.lock` — the attestation, bound to that scope's hash

Keep both. They are what makes the run repeatable and what a reviewer reads to
see what was authorized. Re-run the same assessment with:

```sh
cyrion engage --scope .cyrion/engagements/ENG-….json --scope-lock .cyrion/engagements/ENG-….lock
```

## What you get

A scan of one site finishes in seconds and produces:

- **findings**, each `confirmed` only after a second worker reproduced it
  independently from the record rather than from the first worker's transcript;
- **evidence** — every response that supports a claim, hashed, in
  `.cyrion/artifacts`;
- **a report** in any of six formats.

```sh
cyrion hack https://example.com --state .cyrion/run.sqlite
cyrion report ENG-… --state .cyrion/run.sqlite --format html --out report.html
```

Add `poc.run` and each confirmed finding also carries a proof bundle — the exact
commands, the pinned addresses, and a shell script that reproduces it without
Cyrion. See [Proof of concept and replay](POC-VALIDATION.md).

## Gating a pipeline instead

```sh
cyrion ci --scope .cyrion/engagements/ENG-….json --fail-on high
```

Same run, different ending: reports are written, and the exit code is non-zero
when a confirmed finding meets the threshold. See
[Reports and CI gating](REPORTING.md).

## Adding a model

A scan is deterministic and contacts no model by default. To have a provider
review each transition and each result:

```sh
cyrion hack https://example.com --planner llm --workers llm
```

Configure the endpoint in Settings (press `5` in the terminal) or with
`CYRION_LLM_BASE_URL` and `CYRION_LLM_MODEL`. Review adds minutes and cost and
changes no finding: the controller owns scope, verdicts, and evidence either
way. See [Model providers](MODELS.md).

## Coverage, honestly

The starter skill pack checks surface inventory, browser protection headers, and
object-level authorization. That is a small methodology, and a clean report from
it means those checks found nothing — not that the site is sound. The report's
limitations section says so, and says which skills ran.
