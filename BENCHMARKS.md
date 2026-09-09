# Benchmark results

Contract `cyrion.community/benchmark-v1` · generated 2026-09-09T14:16:07.017Z

Reproduce these numbers on a clean machine:

```sh
git clone https://github.com/X3r0K/Cyrion-AI-CLI && cd Cyrion-AI-CLI
bun install
bun run bench
```

The labs run in-process on loopback and the assessment is deterministic, so a matching Cyrion and fixture version gives the same table. A difference is a regression, not noise.

| Setting | Value |
| --- | --- |
| Cyrion | `0.1.0-alpha.2` |
| Fixtures | `2026.09.1` |
| Root planner | `assessment` |
| Worker review | `capability` |
| Sandbox | `local` |
| Deterministic | yes — the same input gives the same numbers |

## Per lab

| Lab | Status | TP | FP | FN | Precision | Recall | Rejected | Inconclusive | Reproduced | Scope violations | Wall clock |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `imperfect` | completed | 3 | 0 | 0 | 100% | 100% | 0 | 0 | 3/3 | 0 | 0.2s |
| `clean` | completed | 0 | 0 | 0 | — | — | 0 | 0 | 0/0 | 0 | 0.0s |
| `partial` | completed | 0 | 0 | 0 | — | — | 1 | 0 | 0/0 | 0 | 0.1s |

## Per class

| Lab | Methodology | TP | FP | FN | Precision | Recall | Inconclusive |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `imperfect` | `api-object-boundary` | 1 | 0 | 0 | 100% | 100% | 0 |
| `imperfect` | `web-security-headers` | 2 | 0 | 0 | 100% | 100% | 0 |

## Totals

- Precision **100%**, recall **100%** (3 true, 0 false, 0 missed)
- Reproduction rate **100%** (3 of 3 confirmed replayed from a bundle)
- Scope violations **0** — any number but zero invalidates the run
- Findings confirmed against a lab that cannot support one: **0**
- Wall clock 0.3s, cost $0

## What these numbers do not say

- Coverage is the starter skill pack, not a full methodology. Recall is measured
  against what these labs contain, and the labs contain what the skills look for.
  It is a regression measure, not a claim about finding unknown classes of issue.
- Precision is measured where a false positive is provable, which is why a clean
  lab is here. It says nothing about a real application's ambiguity.
- A model in the loop makes these numbers a sample rather than a fact; the
  deterministic configuration is the one that reproduces exactly.
