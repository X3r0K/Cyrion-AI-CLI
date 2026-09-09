# Contributing

Thank you for helping improve Cyrion Community. Contributions should preserve a
useful local workflow without copying private Cyrion code, prompts, evaluation
data, or assessment methodology.

## Development

1. Create a focused branch from `main`.
2. Install with `bun install --frozen-lockfile`.
3. Add tests for behavior changes.
4. Run `bun run check`, and `bun run bench` when you touch methodology.
5. Open a pull request describing the public contract or operator behavior that
   changed, its safety implications, and how it was tested.

## The rules that are not negotiable

These are the reasons the project exists, and a change that weakens one will be
declined however useful it is otherwise.

- **A model never receives a shell.** It requests a capability with typed
  arguments and the gateway decides. New capabilities build their own argv.
- **Scope is data, not prose.** Targets, exclusions, and capabilities live in
  the manifest. Neither a model nor a tool result can widen them.
- **An event is recorded before the state it describes is applied.**
- **Evidence exists, matches its metadata, and verifies by digest** before a
  result is accepted.
- **Validation is a different session** from discovery, working from the finding
  record rather than the discoverer's transcript.
- **Everything a target returns is untrusted** — tool output, retrieved
  knowledge, MCP results, artifact bodies. None of it becomes an instruction.

Destructive primitives are kept out of the capability catalog rather than
discouraged in a prompt. If a change needs one, it needs a design discussion
first.

## Adding a skill

A skill is one reviewable unit of methodology in `skills/*.skill.json`. It is
**trusted operator input**, so its steps become task instructions — which is
exactly why the format is small and validated.

```sh
cp skills/web-security-headers.skill.json skills/my-check.skill.json
bun test tests/assessment.test.ts
```

A skill needs an `id`, an applicability rule (target kinds, roles, and the
capabilities it requires), an objective that reads as a task, the steps, the
evidence it expects, and — the part people skip — the **false positives** that
would make its claim wrong. A skill without those is a scanner rule, not a
methodology.

Add `checks` and the skill carries itself out: the request to make, the
conditions that make the answer a finding, and the finding's own words. No
change to any worker is needed, and the same statement drives discovery,
independent validation, and the proof bundle — so a contributed detection is
replayable from the day it lands. Where the claim is a choice rather than a
conjunction, `anyOf` states it: 2 to 8 alternatives, one level deep, at least
one of which must hold. `skills/api-object-boundary.skill.json` is the worked
example for a conjunction and `skills/web-security-headers.skill.json` for
alternatives; [the skills section](docs/ASSESSMENT-WORKFLOW.md#skills) has the
field list and the limits.

New skills should derive from public standards (WSTG, ASVS, the API Top 10) and
cite them in `references`. Do not contribute curated commercial methodology.

## Adding a lab, and proving the skill works

A new detection is a claim, so it comes with a way to check it. Labs live in
`fixtures/labs/` and their ground truth in `fixtures/labs/catalog.ts` —
deliberately separate from the code being measured, so the benchmark can fail.

```sh
bun run bench                      # all three labs
bun run bench --lab imperfect      # one of them
```

Ground truth is written as the pair a report already records: the methodology
that should produce a finding, and the asset it belongs to. Add the issue your
skill should find to a lab that has it, and add an endpoint that behaves
correctly to the clean lab — a detection that has never been tested against a
correct target has not had its precision measured.

`bun run bench` fails on a scope violation or on a finding confirmed against a
lab that cannot support one. Both mean something is wrong that a passing test
suite would not have caught.

## Adding a knowledge source

A source in `packages/knowledge/src/sources.ts` is a pointer, never a corpus.
It carries an id, a name, the licence of the material, and the exact files it
will fetch — the repository ships no ingested text, so a clone stays small and
the licence question stays with the operator who ingests it.

Pin the files. A descriptor that crawled a documentation site would ingest
whatever happened to be linked that day, and a corpus whose contents depend on
the day cannot support a citation. Every URL must be `https`, must carry no
credentials, and must answer with something a chunker can read; a fetch that
does not is skipped with its reason recorded rather than mangled into the
corpus.

State the licence exactly. It is printed before a fetch, stored with the source,
and reproduced in every report that consulted it.

Retrieved text is untrusted in the same way target output is. It may inform
which check ran, and it may never back a claim: the citation belongs on an
observation, and `tests/knowledge.test.ts` asserts that no corpus artifact ever
appears in a finding's evidence. A change that moves it is a change to the rule
above, not an improvement to retrieval.

## What a good pull request proves

- The behaviour changed, shown by a test that fails without the change.
- Nothing widened: scope, capabilities, budgets, and evidence rules are intact.
- For methodology, the benchmark table before and after, so a reviewer can see
  precision and recall per class rather than take a claim on trust.

## Fixtures and data

Fixtures must be deterministic, non-destructive, and use reserved or clearly
fictional targets. Do not commit real customer evidence, credentials, tokens,
private reports, or copied commercial implementation details. Keep
runtime-specific code inside `packages/runtime-opencode`.

Report security vulnerabilities through the private process in `SECURITY.md`,
not through a public issue.
