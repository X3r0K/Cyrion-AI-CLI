# Knowledge — a local corpus a worker must cite

Cyrion can consult public security standards while it works. The corpus lives on
the operator's machine, it is built by an explicit command, and a worker reaches
it the same way it reaches any other tool: through the gateway, under a
capability the manifest granted, with the result captured as evidence.

That last point is the design. Retrieval-augmented generation usually means
pasting retrieved text into a prompt, which produces two problems this project
cannot accept: nobody can point at what informed a claim afterwards, and a
retrieved document ends up sitting in instruction position. Making retrieval a
capability fixes both. The corpus is data a worker asked for and cited, not
context that arrived on its own.

## Building a corpus

```sh
cyrion knowledge sync                              # only what is already on this machine
cyrion knowledge sync --source owasp-api-top10     # fetches a public standard
cyrion knowledge sync --from ./methodology         # a directory you already have
cyrion knowledge status
cyrion knowledge search "object level authorization"
```

A bare `sync` ingests only local sources — it does not reach the network on its
own. Naming a `--source` is what authorizes a fetch, and the command prints the
licence before it starts.

The store defaults to `.cyrion/knowledge.sqlite`; `--knowledge <path>` names a
different one, and every command that can read the corpus takes the same flag.

### Sources

The repository ships pointers, never bytes: a URL, a licence, and the command.
The corpus itself is yours, which keeps the licence question with the operator
and a clone small.

| Source | Contents | Licence |
| --- | --- | --- |
| `cyrion-skills` | The methodology this build ships, rendered as prose | MIT |
| `owasp-wstg` | WSTG checklist and web/API testing indexes | CC BY-SA 4.0 |
| `owasp-api-top10` | The 2023 API Security Top 10, one document per risk | CC BY-SA 4.0 |
| `owasp-asvs` | ASVS 5.0 requirements | CC BY-SA 4.0 |

Every remote descriptor pins the exact files it will fetch. A corpus assembled
from whatever a documentation site happened to link to that day cannot support
a citation, because the text behind the citation would change without notice.

Your own material goes in the same way. `--from <directory>` ingests `.md` and
`.txt` files, and `--sources <file>` reads a JSON array of descriptors that are
validated the way a skill pack is — an unknown field or a plaintext URL is
refused rather than normalized.

## How retrieval works

Ingest splits each document at its headings, packs paragraphs into chunks of at
most 1,200 characters with an overlap, and stores them in SQLite with an FTS5
index. Chunk identifiers are derived from the text, so the same bytes always
produce the same identifiers and a citation made last month still resolves.

Search is lexical by default and hybrid when vectors exist:

```sh
cyrion knowledge sync --embed        # needs roles.embedding in your model configuration
```

Vectors are stored as blobs and scored in process. A vector extension would be
faster; requiring one would mean you could not use your own knowledge base
without installing a database first. Public standards are thousands of chunks,
not millions, so a scan is milliseconds.

When both sides run, results are combined by reciprocal rank fusion rather than
a weighted score, because BM25 and cosine are not on a comparable scale and any
constant that made them comparable on one corpus would be wrong on the next.

Every result states the mode it actually used. Keyword matches are never
presented as semantic retrieval.

## What a worker sees

`knowledge.search` takes a query and a count, and returns at most eight
snippets of at most 600 characters, each carrying the source, the document, the
heading, and the reference to cite. The full result — every hit, the corpus
version, the query — is written to the evidence store before the summary comes
back, so the retrieval can be opened later like any other artifact.

The query itself is rewritten into terms before it reaches the index. FTS5 has
its own operator grammar, and a string that arrived from a model or a target is
not allowed to reach it. Whatever a worker types, the capability answers rather
than erroring.

Grant it in the manifest like any capability:

```jsonc
"capabilities": ["dns.lookup", "http.probe", "knowledge.search"]
```

A run that grants `knowledge.search` with no corpus behind it is refused before
it starts, rather than failing at dispatch halfway through work you already
authorized.

## The line the corpus does not cross

A skill declares the capabilities it needs; `knowledge.search` is never one of
them. A skill that required a corpus would stop applying on a machine where
nobody ran `sync`, which would make coverage depend on whether an operator
downloaded a standard. The planner adds retrieval to a task when the manifest
allows it, and the methodology works either way.

Retrieved text is untrusted in exactly the way target output is. It is stripped
of control characters at ingest, bounded on the way out, and labelled where it
is returned. Nothing retrieved can widen scope, change a verdict, or become a
step.

The citation lands on an observation, never on a finding. What a standard says
is not why a target answered the way it did, and folding a retrieved paragraph
into a finding's evidence would let a document stand where a response belongs.
The observation records which text informed the step; the finding still rests
only on what the target returned.

## What the report says

Every report states the corpus version — a digest over the ingested documents —
along with the document count, the retrieval mode, and each source with its
licence. Two reports citing the same version cited the same text. The
limitations section repeats the boundary in as many words, so a reader is never
left to assume that a consulted standard was evidence.

## Commands

| Command | Does |
| --- | --- |
| `cyrion knowledge status` | What is ingested, how it is searched, what is not ingested yet |
| `cyrion knowledge sync` | Ingests local sources; `--source` fetches a public one; `--embed` adds vectors |
| `cyrion knowledge search <query>` | Runs a search by hand, exactly as a worker would |
| `cyrion knowledge forget --source <id>` | Removes a source and everything ingested under it |

All four accept `--knowledge <path>` and `--json`.
