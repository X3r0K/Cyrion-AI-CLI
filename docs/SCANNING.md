# Starting a scan

```sh
cyrion scan
```

That opens a form: the address, what the scan may do, where it runs, and who
authorized it. Fill it in, press `s`, and the assessment starts in the terminal.

Everything else on this page is the same thing with flags, or the parts you may
want to change.

## Only scan what you are authorized to scan

Cyrion asks who authorized the assessment before it will start one, and records
that answer in the report. For your own site, "I own example.com, personal
site, self-assessment" is a real answer. For anyone else's, you need their
written permission — and their hosting provider's terms may apply on top of it.

The attestation is bound to the exact scope by a hash. Widen the scope later and
the lock stops matching, so the controller refuses to run under an authorization
that was given for something narrower.

## The form

| Field | What it decides |
| --- | --- |
| **Target** | The address. `example.com` becomes `https://example.com/`, and a bare origin covers everything under it. Add a path — `https://example.com/app` — to narrow it. |
| **Capabilities** | What the scan may do. `space` toggles the one under the cursor. |
| **Sandbox** | `LOCAL` runs tools on this machine. `CONTAINER` isolates them and enforces an egress allowlist in the kernel; it needs a container engine. |
| **Mode** | `AUTONOMOUS` dispatches each validated transition. `SUPERVISED` waits for your approval before every one. |
| **Authorized by** | Who authorized this, and under what reference. |

Keys: `↑↓` move, `←→` change a choice, `space` toggles a capability, `enter`
types into a text field, `s` starts, `q` quits.

### Capabilities

| Capability | What it does | Default |
| --- | --- | --- |
| `dns.lookup` | Resolves the host and pins the addresses everything else is held to | on |
| `http.probe` | Fetches pages and reads headers | on |
| `net.tls` | Inspects the certificate and protocol | off |
| `poc.run` | Reproduces a finding against the live target and keeps a replayable bundle | off |
| `net.portscan` | Port and service discovery — hosts and ranges only, never a URL | off |

The two defaults only read. `poc.run` repeats a finding's condition against the
target, so switching it on makes the run supervised whatever the mode field
said. `net.portscan` is hidden for a URL target: it needs a host or a range.

## Without the form

```sh
# Prepare and run in one step
cyrion scan --target https://example.com --attest "I own example.com, personal site"

# See what it would do, and start it later yourself
cyrion scan --target https://example.com --attest "…" --dry-run

# More capability, a different sandbox, unattended
cyrion scan --target https://example.com --attest "…" \
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
cyrion scan --target https://example.com --attest "…" --state .cyrion/run.sqlite
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
cyrion scan --target https://example.com --attest "…" --planner llm --workers llm
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
