# Reports and CI gating

Every export comes from one record. `buildCommunityReport` reads the engagement
snapshot, and each format renders that record — so the Markdown a client reads,
the SARIF a code-scanning dashboard ingests, and the JUnit a pipeline gates on
cannot disagree about what was found.

```sh
cyrion ci --scope engagement.json --fail-on high --formats markdown,html,sarif,junit
cyrion report ENG-1042 --state .cyrion/engagement.sqlite --format html --out report.html
```

## Formats

| Format | Use | Extension |
| --- | --- | --- |
| `markdown` | The default human report | `.md` |
| `json` | Machine consumption, versioned schema | `.json` |
| `html` | Self-contained, printable to PDF | `.html` |
| `sarif` | GitHub and GitLab code scanning | `.sarif.json` |
| `junit` | CI gating | `.junit.xml` |
| `csv` | Import into a tracker | `.csv` |

The HTML report fetches nothing when it is opened — no fonts, scripts, or
stylesheets — because a report that phones home is not one an assessor can hand
to a client. Artifact bodies stay out of every format; digests go in.

Untrusted text is escaped for each grammar separately. A finding summary that
begins `=cmd|calc` is quoted so a spreadsheet will not run it, and one
containing `<script>` reaches HTML and XML as text.

## What every report states

- **Authorization** — the canonical scope hash, and the operator attestation
  when a scope lock was supplied. A run with no attestation says so in the
  limitations rather than staying quiet about it.
- **Methodology** — the skills that produced the tasks, so a reader can see how
  a finding was reached.
- **Environment** — sandbox, Root planner, worker review, model per role, and
  tool versions, when the caller supplied them.
- **Budgets** — granted against consumed.
- **Findings** — severity and verdict, with **reproducibility recorded
  separately**: a confirmed finding with no proof bundle is reported as resting
  on the validator's observation rather than on a replayable reproduction.
- **Validation records** — who validated what, and which bundle proves it.
- **Evidence index** — every artifact with its digest.
- **Limitations and coverage gaps** — derived from the run. When discovery and
  validation used the same model, the report says so: correlated model error is
  a real failure mode, and disclosing it is cheaper than being caught by it.

## SARIF

Status is carried by `kind` and severity by `level`, so a rejected candidate
appears as a passing result rather than disappearing — "Cyrion looked and found
nothing" is a different statement from "Cyrion never looked".

| Cyrion verdict | SARIF kind | Level |
| --- | --- | --- |
| `confirmed` | `fail` | by severity |
| `rejected` | `pass` | `none` |
| `inconclusive` | `review` | `none` |
| `candidate`, `validating` | `open` | `none` |

Each skill becomes a rule, so an alert links back to the methodology that
produced it, and `security-severity` is set for dashboards that sort on it.

## Gating a pipeline

```sh
cyrion ci --scope engagement.json --sandbox local --fail-on high --approve-all
echo $?   # 1 when the gate fails
```

The gate counts **confirmed** findings at or above `--fail-on`. A candidate
nobody validated is not evidence of a problem, and a gate that fails on one
teaches a team to ignore the gate; pass `--fail-on-unresolved` when you want
unvalidated work to block as well.

Two other conditions fail the gate, because neither leaves a trustworthy result:

- the engagement did not complete;
- the run recorded scope, policy, or evidence refusals.

Reports are written **before** the exit code is decided, so a failing build
still leaves everything needed to read why. `--formats` selects what to write,
`--report <directory>` where.

```
gate         FAIL (--fail-on high)
             1 confirmed finding(s) at or above high
```
