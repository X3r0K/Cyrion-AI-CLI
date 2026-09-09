# Credentials — authenticating without writing a secret down

Testing authorization requires authenticating. The question is where the token
lives.

Written into a skill file it becomes three things at once: a secret in a git
repository, a string in every prompt built from that skill, and a value in
whatever artifact the exchange produced. None of those are recoverable by
redacting output afterwards.

So a skill names a credential and never holds one. The file says
`${cred:api-token}`, the operator's store holds the value, and the two meet for
the first time inside the function that writes bytes to a socket.

## The store

Default path `cyrion.credentials.json`, overridden with `--credentials <path>`
or `CYRION_CREDENTIALS`. It is in `.gitignore`, and Cyrion never writes it —
there is deliberately no command that saves a credential, because an operator's
own editor and file permissions are a better place for that than an argv the
shell puts in a history file.

```json
{
  "version": "cyrion.community/credentials-v1",
  "credentials": [
    {
      "name": "api-token",
      "value": "the-actual-token",
      "hosts": ["api.example.test"],
      "description": "Read-only service account"
    },
    {
      "name": "session",
      "value": "sess-...",
      "hosts": ["*.staging.example.test"],
      "exposeToModel": false
    }
  ]
}
```

`hosts` is required, and it is the reason this store is worth having. A
credential bound to one host cannot be carried to another by a redirect, a
crawled link, or a check whose target was edited. A leaked credential is a worse
outcome than a missed finding. A leading `*.` covers what is under a name, never
the bare name beside it.

`cyrion credentials [--json]` lists what is defined — names, hosts, and whether
the model may read each one. Values are never printed, here or anywhere else.

## Referring to one

Anywhere Cyrion sends a header, from a skill's declarative check or a proof
step:

```json
{
  "request": {
    "path": "/api/objects/42",
    "headers": { "authorization": "Bearer ${cred:api-token}" }
  }
}
```

A reference may sit inside a larger string, so `Bearer ${cred:...}` works
without storing the word `Bearer` in the secret.

Three things are refused rather than guessed:

- **A name nobody defined.** Substituting nothing would send an
  unauthenticated request that comes back 401 and reads exactly like a finding,
  which is the most expensive way for this to fail.
- **A host the credential is not bound to.** This is the leak the store exists
  to prevent.
- **A reference with no store loaded.** The error names the credential it
  wanted, so the fix is obvious.

## What gets recorded

The reference, not the value. Every caller above the send funnel holds
`${cred:api-token}`, so that is what reaches the evidence artifact, the event
log, the proof bundle, and any prompt built from them.

That is more useful than a redaction: a reader of the artifact learns which
credential to substitute rather than that something was removed. It is also why
a proof bundle stays shareable — `cyrion replay` re-resolves the reference
against whoever's store is replaying it, so a bundle can be attached to a report
without the secret going with it.

The one route by which a value could still escape is a target that echoes it
back into a response. Response bodies and headers are scrubbed on the way in:
the value is replaced with the reference it was sent under, before it becomes a
summary, an artifact, or a prompt. Set `exposeToModel: true` on a credential to
turn that off for it, which is the per-credential opt-in and is off by default.

## What this does not do

- It does not encrypt the file. It is a file of secrets with your filesystem's
  permissions on it, and it should be treated as one.
- In container mode the resolved value is passed to `curl` as an argument
  inside the sandbox, where it is visible to anything reading `/proc` in that
  container. The container is per-engagement and unprivileged, so this is a
  boundary you already trust for the rest of the run, but it is stated here
  rather than left to be discovered.
- It does not stop a skill from writing a literal credential in a header.
  Literals still work and are still redacted by header name in artifacts; they
  simply carry every problem described at the top of this page.
