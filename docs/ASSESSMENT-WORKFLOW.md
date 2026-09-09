# Running an assessment

`cyrion engage` runs the real loop: skills chosen from the approved scope,
capabilities executed in the selected sandbox, evidence hashed locally, and
every transition validated by the controller before anything is dispatched.

```sh
cyrion scope lock --manifest engagement.json --attest "Authorized by …, ticket SEC-1042"
cyrion engage --scope engagement.json --scope-lock scope.lock --sandbox local
cyrion engage --scope engagement.json --headless --state .cyrion/engagement.sqlite
```

## What the plan looks like

The planner is deterministic and reads only the manifest and the loaded skills:

1. **Recon** — one task per approved network target, resolving and pinning it and
   recording what it answered.
2. **Assessment** — one task per applicable skill and target. A skill applies
   when its target kind, its role, and every capability it needs are all
   satisfied by the manifest.
3. **Validation** — one task per candidate, in a fresh session, working from the
   finding record and the artifacts it cites rather than from the discovering
   worker's transcript. When the manifest grants `poc.run`, validation produces
   a replayable proof bundle; see [POC-VALIDATION.md](POC-VALIDATION.md).
4. **Report** — rendered from accepted records only.

Each task records the skill that produced it, so a report can state its
methodology.

## How the plan grows: proposals

A run is a tree, not a fixed pipeline. Any worker may return `proposedTasks`
alongside its observations — the lens, the objective, the target, and what it
would need — and the engagement follows what it finds. A web worker that meets a
login form reflecting its input asks for an `injection` specialist; that
specialist, having obtained a session, can ask for an `authz` one.

**A proposal is a request, never a dispatch.** A worker states the *shape* of
the work; the controller decides whether that task exists. A proposal carries no
`id`, no `parentTaskId` and no `depth`, and there are no such fields to set: a
proposer that could choose its own depth could spawn forever, and one that could
choose its own parent could hide where a request came from. The controller
assigns all three from the task that asked.

Everything else is checked twice — once when the result is accepted, once before
dispatch:

| A proposal that… | What happens |
| --- | --- |
| Targets outside the manifest scope | The whole worker result is refused, naming the target |
| Asks for an ungranted capability | The whole worker result is refused, naming the capability |
| Would sit deeper than `maxDepth` | Dropped, not clamped — running it shallower would misreport the tree |
| Delegates the report | Refused |
| Repeats one already dispatched | Ignored; each proposal is dispatched once |

### Roles

`recon`, `web`, `api`, `validator` and `reporter`, plus the specialists a
delegation can name: `injection`, `xss`, `ssrf`, `auth`, `authz`, `idor`,
`race`, `logic` and `repo`.

A role is a **lens, not a permission**. What an agent may do comes only from the
capabilities the manifest granted; naming a role has never widened one. They
exist so a task carries what it is *for*, which is what makes a delegation tree
readable and lets a report say which line of inquiry produced a finding.

Validation waits for every assessing role, specialists included — a candidate
validated while a spawned specialist is still running would be validating an
incomplete run.

## Optional provider review

A real engagement is deterministic by default: the planner and the workers are
the same ones a fixture run uses, and no model is contacted at all.

```sh
cyrion engage --scope engagement.json --planner llm      # a provider reviews each transition
cyrion engage --scope engagement.json --workers llm      # and each canonical worker result
cyrion engage --scope engagement.json --planner llm-author  # the provider proposes transitions
```

`llm` is the guarded mode: the controller builds the transition, the provider
may accept it or stop the engagement, and it never gains a tool. `llm-author`
lets the provider propose the transition instead — every field still passes the
same validation, so an out-of-scope target, an ungranted capability, or a
dependency cycle is rejected before anything is dispatched.

A review mode named on the command line is honoured or refused. One inherited
from saved defaults degrades to the deterministic runtime with the reason
printed, because a missing endpoint must never stop an authorized assessment.
The headless summary and the report both state what actually planned the run.

## What a worker may claim

A worker's claim is only as good as the artifact behind it. Every observation
and finding carries the evidence the capability captured, and the controller
refuses a result whose evidence is missing, mismatched, or unverifiable. A
worker that produced no evidence cannot raise a finding at all.

Findings start as candidates. Only a validator moves one to confirmed,
rejected, or inconclusive, and only with fresh evidence it captured itself. When
the target no longer behaves as the candidate described, the verdict is
`rejected` — the run in `tests/assessment.test.ts` proves this by hardening the
lab between discovery and validation.

Reproducibility is recorded separately from severity. A finding validated with
`poc.run` carries the bundle that reproduces it, and `cyrion replay
<finding-id>` re-runs that bundle against the current scope later. A finding
confirmed without one is still confirmed — and the report says it rests on the
validator's observation rather than on a replayable proof.

## Finding the surface

An assessment that only ever looks at the addresses an operator typed is an
assessment of a list, not of a site. When the manifest grants `http.crawl`, the
recon task walks the approved origin and reports the endpoints it found, and the
planner runs the skills against those too:

```jsonc
"capabilities": ["dns.lookup", "http.probe", "http.crawl"]
```

The crawl reads links the target itself published — `href`, `src`, and form
actions. There is no wordlist, no path guessing, and no request that changes
state: content discovery by brute force is a different capability with different
consequences, and it is not this one. It is bounded by pages (25), depth (3),
the task's own clock, and a gap between requests; a task may ask for less with
`maxPages` and `maxDepth`, never more.

**A discovered address is a report, not a permission.** Every link is checked
against the scope before it is requested, so a link that leaves what was
approved is *counted* in the inventory and never followed. The endpoints a
worker reports are then checked twice more: the controller refuses the whole
result if one of them is out of scope, and the planner checks again before it
dispatches anything. Two independent checks means neither is the only one.

The scope pattern itself stops being a task once its pages are known — assessing
`https://app.example.com/api/*` *and* the pages under it would report one page's
issue twice.

What the walk could not finish is stated rather than hidden: the inventory
artifact lists the pages visited, the endpoints still queued when the budget ran
out, the links that left the scope, and anything that did not answer.

## Skills

A skill is one reviewable unit of methodology in `skills/*.skill.json`:

```jsonc
{
  "version": "cyrion.community/skill-v1",
  "id": "web-security-headers",
  "name": "Transport and browser protection headers",
  "source": "WSTG-CONF-12",
  "appliesTo": { "kinds": ["url"], "capabilities": ["http.probe"], "roles": ["web"] },
  "objective": "…",          // becomes the task objective
  "steps": ["…"],            // operator-authored instructions
  "expectedEvidence": ["response"],
  "falsePositives": ["…"],   // what would make this claim wrong
  "severity": "low"
}
```

Skills are **trusted operator input**: their steps become task instructions.
Target content never gets promoted to that status. The format is JSON rather
than front-matter Markdown deliberately — a security tool should not add a
parser dependency to read its own methodology.

`--skills <directory>` loads an alternative pack. A malformed skill fails the
whole load rather than silently shrinking the methodology.

The starter pack covers surface inventory, browser protection headers,
object-level authorization, independent reproduction, and — when `poc.run` is
granted — reproduction from a proof bundle. Broader coverage is where community
packs, and the commercial corpus, come in.

### Checks: a skill that carries itself out

A skill may state its own checks, and then no code has to know it exists:

```jsonc
"checks": [{
  "id": "object",
  "request": { "method": "GET", "path": "/api/objects/42" },
  "expect": { "status": [200], "contentType": "application/json", "bodyIncludes": "\"owner\"" },
  "finding": {
    "title": "Object response discloses an owner field",
    "summary": "The approved object endpoint named the record's owner."
  }
}]
```

Every declared condition must hold for the check to raise a candidate, and
`anyOf` states the one place where a claim is a choice rather than a
conjunction. The conditions are the same vocabulary a proof-of-concept step
states — status, headers present or absent, content type, a body marker — and
that is the point: **one statement drives all three moments a claim passes
through.** Discovery
asks the question and raises the candidate; validation repeats exactly the same
request and conditions from the record alone; `poc.run`, when granted, compiles
the same check into the bundle that reproduces it. A contributed skill cannot
disagree with itself, and `cyrion replay` works for it on day one.

| Field | Meaning |
| --- | --- |
| `id` | Names the check, and names the finding it raises (`F-<ID>-<asset>`), which is how a validator gets back to the statement it has to re-test |
| `request.method` | `GET`, `HEAD`, or `OPTIONS`. Reads only: the vocabulary has no method that changes state |
| `request.path` | Resolved against the approved target and **re-checked against scope**, so a check reaches only what the operator approved |
| `request.headers` | Sent with the request. A credential header is refused by name, at load |
| `expect` | The conditions. At least one, all of which must hold |
| `expect.anyOf` | 2 to 8 alternatives, of which at least one must hold. One level deep, and everything stated beside it must still hold |
| `finding` | The title and summary the candidate carries, plus an optional severity that defaults to the skill's |

A check that asks for a path, a request header, or a body condition needs
`http.request`; one that only asks about the status line and the headers runs
under `http.probe`. The loader refuses a body claim from a skill that did not
require `http.request`, because a probe could not decide it — a refusal an
author can fix beats a run that fails halfway through. The rule reaches inside
`anyOf`: a probe reports no body, so a body condition hidden in an alternative
would be decided against an empty string rather than refused, and `bodyExcludes`
would hold against a body nobody fetched.

The finding's summary quotes the **skill's** conditions, never the response: a
sentence a reader trusts should not be written by the target. What the target
actually returned is in the artifact, which is hashed and verifiable.

### A claim with alternatives

Some methodologies are a choice, not a conjunction: "any one of these five
headers is missing" is one claim about a response, and stating it as five
separate checks would report one weak origin five times. `anyOf` says so
directly:

```jsonc
"expect": {
  "anyOf": [
    { "headersAbsent": ["content-security-policy"] },
    { "headersAbsent": ["x-frame-options"] }
  ]
}
```

It is bounded on purpose: 2 to 8 alternatives, one level deep, and an
alternative may not nest another. A reader has to be able to check the whole
statement at a glance, which stops being true the moment a skill file becomes a
boolean tree. Anything stated alongside `anyOf` still has to hold, so `anyOf`
widens a claim without loosening the rest of it.

The alternatives are judged by the code that judges every other condition, so
the reasons stay separate: the **claim** is "any of these five absent", and
what a reader needs is *which* of them was — so the finding names the
alternative that held, and a failure names what it found instead. Both come
from the skill file; neither is written by the target. Where a body condition
appears among the alternatives and the response was truncated, the check is
undecided rather than false — a body nobody read in full cannot say a marker is
absent.

`skills/api-object-boundary.skill.json` and `skills/web-security-headers.skill.json`
are both written this way. They used to be branches in the worker; moving them
into their files changed no identifier, no verdict, and no benchmark number.
No shipped detection is code any more: `packages/assessment` runs checks
without knowing what any of them is about.

## The lab

`fixtures/lab/server.ts` is a small controlled target with exactly two
findable issues and one endpoint that behaves correctly, so precision and recall
are both measurable:

| Endpoint | Expected outcome |
| --- | --- |
| `/` | Missing browser protection headers — one confirmed finding |
| `/api/objects/:id` | Answers an unauthenticated request — one confirmed finding, plus the header finding for the same response |
| `/api/private/:id` | Refuses with 401 and full protections — **no** finding |
| `/hardened` | Sets every protection — **no** finding |

```sh
bun fixtures/lab/server.ts                     # listens on 8123
cyrion engage --scope fixtures/lab/engagement.json --sandbox local --headless
```

`poc.run` is granted by default and writes a proof bundle for every confirmed
finding. Drop it from the manifest's capabilities if you want an assessment that
only reads.

The assessment tests assert the full outcome: both issues found and confirmed
with independent evidence, nothing raised against the correct endpoints, and
zero scope or policy rejections across the run.
