# Controlled assessment workflow

Phase 3 supplies a deterministic, non-destructive workflow for exercising the
Root-to-specialist-to-validation lifecycle without scanning a real target.

## Scenario matrix

| Scenario | Candidate | Independent verdict | Reporting behavior |
| --- | --- | --- | --- |
| `known-positive` | Authorization response mismatch | Confirmed with fresh evidence | Reports one confirmed finding |
| `clean` | None | Validator is not dispatched | Reports a clean controlled run |
| `rejected` | Volatile response difference | Rejected | Preserves the validation record but does not confirm the claim |
| `incomplete` | Interrupted comparison | Inconclusive | Records the limitation and requests more evidence |

The API worker may only submit a candidate. When a candidate exists, Root
creates a separate validator task and the controller transitions the finding to
`validating` before dispatch. Only the validator can produce the terminal
`confirmed`, `rejected`, or `inconclusive` state. A clean assessment skips this
unnecessary worker.

## Evidence records

Fixture evidence is normalized into request, response, fixture, and report
artifacts. Every reference includes:

- engagement-scoped `artifact://` URI;
- SHA-256 digest and byte length;
- capture time, producing worker, and content type;
- a separate metadata file so JSON evidence cannot overwrite its own metadata.

IDs and extensions accept only conservative path segments. Absolute paths,
additional URI segments, and traversal values are rejected. Tool audit events
contain metadata only; evidence content stays in the artifact store.

These scenarios are lifecycle and evaluation fixtures. They are not assessment
playbooks, real exploits, or claims about a live system.

`fixtures/manifest.json` versions the fixture set and records the expected task,
evidence, and finding outcome for each scenario. Release checks treat this file
as the public reproducibility contract.
