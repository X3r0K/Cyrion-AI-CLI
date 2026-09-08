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

Add `poc.run` to the manifest's capabilities to get a proof bundle for every
confirmed finding. The run then waits for approval unless you pass
`--allow-unsupervised-poc`.

The assessment tests assert the full outcome: both issues found and confirmed
with independent evidence, nothing raised against the correct endpoints, and
zero scope or policy rejections across the run.
