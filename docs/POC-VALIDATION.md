# Proof of concept and replay

A scanner tells you what it saw. A pentest tool shows you how to see it again.
`poc.run` is how Cyrion does the second thing: a validator turns a candidate
into a bounded reproduction, runs it, and stores the bundle that repeats it —
so a confirmed finding arrives with the exact commands that prove it.

```sh
cyrion scope lock --manifest engagement.json --attest "Authorized by …, ticket SEC-1042"
cyrion engage --scope engagement.json --scope-lock scope.lock --sandbox local
cyrion replay F-OBJECT-a845c387 --manifest engagement.json
```

## It is off until you turn it on

`poc.run` is a manifest capability. It does nothing unless the approved scope
names it:

```jsonc
"capabilities": ["dns.lookup", "http.probe", "poc.run"]
```

Granting it changes two things. The engagement runs **supervised** — every
delegation waits for your approval — unless you pass `--allow-unsupervised-poc`
and say so deliberately. And a `repository` engagement refuses to start with it
at all: a static claim needs a runtime target before it can be confirmed.

## What a proof of concept is here

It is a **plan**, not a script a model wrote. The plan is data the controller
validates before anything runs, and the destructive primitives are absent from
the vocabulary rather than discouraged in a prompt:

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

The contract admits `GET`, `HEAD`, and `OPTIONS` and nothing else. There is no
request body field to carry a payload, no header that may carry a credential
(`authorization`, `cookie`, `x-api-key`, and their relatives are refused by
name), at most eight steps, and every step must state a condition — a proof that
asserts nothing proves nothing.

`expect` is the whole judgement: `status`, `headersPresent`, `headersAbsent`,
`contentType`, `bodyIncludes`, `bodyExcludes`. Every stated condition must hold.

## What the runner enforces

Not by asking the model nicely — by refusing:

| Control | Behaviour |
| --- | --- |
| Scope | Every step URL is re-validated; the first step must be the assigned target |
| Pinning | Each hostname is held to the addresses this engagement pinned; a moved answer fails the run |
| Redirects | `--max-redirs 0`. A redirect is a different request against a different target |
| Rate | 500 ms between steps, one connection at a time — a reproduction, not a fuzz run |
| Time | 5 s to connect, 15 s per step, and the gateway's own wall clock over the whole call |
| Output | Bounded per step; a truncated body cannot decide a body condition, and says so |
| Egress | In container mode the allowlist applies to the PoC exactly as it does to every other capability |

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
