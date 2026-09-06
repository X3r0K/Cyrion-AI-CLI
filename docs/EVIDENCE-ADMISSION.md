# Evidence admission

Evidence references returned by a worker are untrusted model output. A valid
shape and an engagement-scoped URI do not prove that the referenced artifact
exists, that its metadata is canonical, or that its bytes are unchanged.

The controller therefore owns the `EvidenceStore` for the engagement and
passes that same store to each runtime through `RuntimeContext`. Workers may
capture artifacts, but they cannot choose a second store that the controller
does not inspect.

## Admission sequence

Before a task can emit `task.completed` or merge evidence into the durable
snapshot, the controller performs these checks in order:

1. Runtime contract validation rejects malformed or unknown fields.
2. Result policy binds the URI, evidence ID, and source to the engagement and
   assigned worker.
3. The configured store must return a canonical metadata record for the exact
   ID and URI.
4. Every field returned by the worker must match that canonical record.
5. The artifact bytes must match the canonical SHA-256 digest and byte length.

A failure emits a bounded `task.result.rejected` reason, marks the task failed,
and leaves the engagement evidence index unchanged. The rejected provider
payload and artifact body are not copied into the event log.

Recovery applies the same checks to a durable `task.completed` event before it
is accepted. If its artifact is missing, its metadata differs, or its digest no
longer verifies, the controller records the rejection and requeues the same
task identity with a new attempt.

## Store behavior

`LocalEvidenceStore` keeps artifact bytes and `<evidence-id>.meta.json` as
separate owner-only files. `MemoryEvidenceStore` keeps the same canonical
metadata distinction for tests and disposable runs. Re-capturing an existing
ID with identical bytes returns the original reference; different bytes are
rejected.

Durable controller state should always be paired with a durable evidence store.
The CLI does this automatically when `--state` is used by supplying the same
local artifact store to both the controller and terminal inspector.

## Limits

Hash verification proves only that the stored bytes match the captured
metadata. It does not prove that a target response is truthful, that the source
was authentic, or that a security claim is valid. Those remain separate scope,
provenance, and independent-validation responsibilities.

There is also an unavoidable time-of-check/time-of-use window for files that an
external process can modify. The terminal inspector verifies again immediately
before previewing an artifact so later tampering remains visible to the
operator.
