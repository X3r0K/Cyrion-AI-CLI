# Untrusted output boundary

Root and worker responses are untrusted input even when the provider reports
that JSON-schema formatting succeeded. Cyrion validates provider output again
before it can enter durable state or drive scheduling.

In guarded worker mode, provider output is narrower than `WorkerResult`: only
an `accept`/`flag` review and labeled public summary are admitted. The canonical
worker's summary, observations, findings, evidence, report, and provenance are copied
unchanged, then the complete result passes the normal controller gates.

The provider input is bounded too. Evidence bodies are included only for
textual artifacts after engagement/worker binding, exact canonical-metadata
comparison, store verification, and a second digest/size check of the bytes
actually read.
Individual, total, and artifact-count caps constrain disclosure. Every preview
is explicitly untrusted prompt data; provider instructions found inside it have
no authority. Failed checks and non-text content produce metadata-only records.

## Contract validation

- Engagement manifests, Root decisions, worker results, evidence references,
  findings, observations, and usage records are checked at runtime.
- Unknown fields, unsupported enum values, unsafe identifiers, duplicate list
  entries, non-finite usage, oversized text, and oversized collections are
  rejected.
- The OpenCode response schemas mirror these public contracts to help providers
  correct invalid output before the controller receives it.
- Malformed Root responses are recorded only as a bounded rejection reason;
  their opaque fields are not copied into the event log.

## Controller policy

Contract-valid data must also satisfy its task binding:

- Root cannot create cyclic task graphs, mismatch a role and output type, or
  assign a validator to anything except an existing candidate on the same
  target.
- Observations and findings cannot change the task target or claim another
  agent as their source.
- Evidence must use the current engagement's `artifact://` namespace, carry the
  current worker as its source, and use a new evidence ID.
- Discovery workers can create candidates only. They cannot mark their own
  claims confirmed or impersonate a validator.
- Validators can return only a final verdict for their assigned candidate.
  Candidate identity, title, asset, severity, discoverer, and prior evidence
  remain immutable, and fresh validator-owned evidence is required.
- Reporter output cannot mutate findings or observations.

Invalid worker results emit `task.result.rejected` with a bounded reason, then
fail the task without merging evidence or findings. An invalid completion found
during restart reconciliation is rejected and the original task is requeued
instead of trusting the stale event.

## Deliberate limitation

These checks establish data provenance and state-transition integrity; they do
not prove that an artifact's content is true. Artifact hashes prove integrity
after capture, while independent validation determines whether a candidate may
be promoted to a confirmed finding.
