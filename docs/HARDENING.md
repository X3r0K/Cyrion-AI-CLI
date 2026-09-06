# Post-alpha hardening

The fixture CLI runs each capability invocation in a short-lived Bun subprocess
by default. This is a real process boundary for lifecycle and environment
testing, but it is not presented as a network sandbox.

## Fixture worker boundary

- The controller gateway validates engagement, task, target, capability,
  timeout, and output budget before dispatch.
- The subprocess adapter independently checks the assigned target and fixture
  capability before spawning.
- The worker validates a small JSON envelope again and accepts only reserved
  fixture targets and `fixture.read` or `fixture.compare`.
- The child receives an explicit environment containing only locale, temporary
  directory, color, and worker-kind values. Provider credentials and the
  operator environment are not forwarded.
- Every invocation uses a private temporary working directory that is removed
  after success, failure, timeout, or cancellation.
- Standard output is bounded by the task budget; diagnostics are bounded to 8
  KiB and stripped of terminal control characters.
- Controller timeout or cancellation terminates the worker process.

## Evaluated failure cases

| Case | Enforcement point | Automated coverage |
| --- | --- | --- |
| Root widens target scope | Controller decision validation | Yes |
| Tool changes target or capability | Scoped tool gateway | Yes |
| Worker receives an unapproved target | Fixture subprocess adapter | Yes |
| Worker output exceeds budget | Subprocess stream reader and gateway | Yes |
| Tool exceeds deadline or is cancelled | Abort signal terminates child | Yes |
| Parent credential variables reach worker | Explicit child environment | Yes |
| Evidence artifact is modified | SHA-256 evidence verification | Yes |
| Evidence contains terminal controls | TUI preview sanitization | Yes |
| Worker or controller is interrupted | Durable lease reconciliation | Yes |
| Provider returns malformed or opaque fields | Runtime contract parser | Yes |
| Worker forges target, source, or finding status | Controller result policy | Yes |
| Root creates a cyclic task graph | Controller decision policy | Yes |

## Remaining boundary

The fixture subprocess has no network functionality, but it is not containerized
and does not have filesystem mount or kernel-level egress restrictions. Any
future live HTTP, browser, shell, or scanner adapter must run in a separately
reviewed container/namespace boundary that enforces approved destinations after
DNS resolution and on every redirect. This phase does not enable such adapters.
