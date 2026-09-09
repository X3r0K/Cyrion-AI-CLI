# Proof of concept and replay

A scanner tells you what it saw. A pentest tool shows you how to see it again.
`poc.run` is how Cyrion does the second thing: a validator turns a candidate
into an exploit, runs it, and stores the bundle that repeats it — so a confirmed
finding arrives with the exact commands that prove it.

It is still a **plan** rather than a script a model wrote, because that is what
makes a run reviewable before it happens and reproducible after. What changed is
what a plan may do: any method, a body, a session, and a chain long enough to
demonstrate a consequence.

```sh
cyrion scope lock --manifest engagement.json --attest "Authorized by …, ticket SEC-1042"
cyrion engage --scope engagement.json --scope-lock scope.lock --sandbox local
cyrion replay F-OBJECT-a845c387 --manifest engagement.json
```

## Granting it

`poc.run` is a manifest capability, named in the approved scope:

```jsonc
"capabilities": ["dns.lookup", "http.probe", "poc.run"]
```

It is granted by default, like every other capability the target kind
supports, and it does not change how the run is supervised: an assessment you
started is an assessment you authorized. A `repository` engagement can carry it
too, though nothing static becomes `confirmed` without a runtime target to
reproduce it against.

## What a proof of concept is here

It is a **plan**, not a script a model wrote. The plan is data the controller
validates before anything runs, and an operator can read the whole of it before
it does — which is the point of keeping it declarative now that what it may do
is no longer narrow:

```jsonc
{
  "version": "cyrion.community/poc-v1",
  "findingId": "F-OBJECT-a845c387",
  "title": "Object endpoint answers an unauthenticated request",
  "rationale": "The proof sends exactly that request — no credential, no cookie …",
  "steps": [{
    "id": "unauthenticated-request",
    "description": "Request http://app.lab.test/api/objects/42 without any credential",
    "method": "GET",
    "url": "http://app.lab.test/api/objects/42",
    "expect": { "status": [200], "contentType": "application/json" }
  }]
}
```

The contract admits every HTTP method, a request body, an authenticated session,
and up to 64 steps — enough to log in, enumerate, escalate, and prove the
consequence. Every step must still state a condition: a proof that asserts
nothing proves nothing.

A test that cannot write, cannot log in, and cannot follow a redirect cannot
demonstrate a broken access control, which is most of what an engagement is for.
So those constraints are gone. What replaced the credential rule is **redaction**
rather than refusal, described below.

`expect` is the whole judgement: `status`, `headersPresent`, `headersAbsent`,
`contentType`, `bodyIncludes`, `bodyExcludes`. Every stated condition must hold.

## What the runner enforces

Not by asking the model nicely — by refusing:

| Control | Behaviour |
| --- | --- |
| Scope | Every step URL is re-validated; the first step must be the assigned target |
| Pinning | Each hostname is held to the addresses this engagement pinned; a moved answer fails the run |
| Redirects | Followed to a depth of 5 — an authentication bypass usually lands through one — with every hop held to the pinned addresses |
| Rate | 500 ms between steps, one connection at a time. A volume bound, not a capability one: exhausting a client's service is the one outcome no engagement wants and no finding needs |
| Time | 5 s to connect, 15 s per step, and the gateway's own wall clock over the whole call |
| Output | Bounded per step; a truncated body cannot decide a body condition, and says so |
| Egress | In container mode the allowlist applies to an exploit exactly as it does to every other capability |
| Credentials | Sent as written, redacted everywhere the bundle is stored |

## Credentials: sent, then redacted

Testing authorization means authenticating, so a step may carry `authorization`,
`cookie`, `x-api-key` and the rest. They are sent exactly as written.

They are **not** in what you hand a client. Before anything reaches disk, Cyrion
replaces the value of every secret header with `[redacted by cyrion]` — in the
recorded argv, in the bundle's request record, and in the response transcript,
which strips a `set-cookie` the server issued in reply. The header *name* stays,
so a reader can see the request was authenticated.

The old contract refused these headers outright, which prevented the leak by
preventing the test. This keeps the test and prevents the leak: `REPRO.md` tells
the reader to substitute their own credential where a redaction appears.

## Verdicts, and the honest third one

| Verdict | Meaning | Finding becomes |
| --- | --- | --- |
| `reproduced` | Every condition still holds | `confirmed` |
| `not-reproduced` | A condition failed on a response that arrived | `rejected` |
| `inconclusive` | The run could not decide — no answer, a timeout, a truncated body | `inconclusive` |

The controller checks the verdict against the status: a validator that claims
`confirmed` on a bundle that did not reproduce is rejected, and so is one that
cites a bundle it never captured. A discovering worker cannot claim a
reproduction at all.

Reproducibility is recorded **separately from severity**, on the finding itself:

```jsonc
"reproduction": {
  "verdict": "reproduced",
  "bundleId": "E-mts9cv5t77q-0014",
  "steps": 1,
  "runner": "local",
  "at": "2026-09-08T05:57:47.704Z"
}
```

A confirmed finding with no bundle is still reported as confirmed — and the
report says plainly that it rests on the validator's observation rather than on
a replayable proof.

## The bundle

Every run writes three artifacts, hashed like all other evidence:

- the **raw exchange** for each step — argv, response headers, body;
- the **bundle** (`kind: poc`, JSON) — plan, argv, environment, pinned
  addresses, tool version, per-step outcome, verdict, and a standalone script;
- **`REPRO.md`** (`kind: poc`, Markdown) — the same run written for a person,
  ending in a shell script that needs no Cyrion at all.

That last point is the test this feature has to pass. Extract the script and it
runs anywhere `curl` does:

```sh
--- step 1: Request http://app.lab.test/api/objects/42 without any credential
HTTP/1.1 200 OK
Content-Type: application/json;charset=utf-8

{"id":"42","owner":"someone-else","balance":4210}
```

## Replaying later

```sh
cyrion replay <finding-id> --manifest engagement.json [--artifacts <dir>]
cyrion replay --bundle .cyrion/artifacts/ENG-1/E-0014.json --manifest engagement.json --json
```

Replay reads the bundle, then ignores its authority: the **current** manifest
decides whether every step is still in scope, `poc.run` must still be granted,
and the run happens under the same pinning and evidence rules an engagement
uses. It prints the recorded verdict beside the new one and exits non-zero when
they differ — which is exactly what you want in a re-test pipeline, and what
makes "we fixed it" checkable.

## What it is not

There is no exploitation here, and that is deliberate. No writes, no state
changes, no credential handling, no lateral movement, no volume. A capability
that could do those things is not in the catalog to be misconfigured. When
authenticated reproduction lands it will take credentials from an operator-managed
store, injected per request and redacted from artifacts — never from a plan and
never from a prompt.
