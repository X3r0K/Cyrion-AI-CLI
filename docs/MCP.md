# MCP, in both directions

Cyrion speaks the Model Context Protocol as a **server**, so another agent can
read an engagement, and as a **client**, so an operator-approved MCP server can
back a Cyrion capability. Both directions keep the same rule: a configured
server is not an authorization.

## Cyrion as a server

```sh
cyrion engage --scope engagement.json --state .cyrion/engagement.sqlite --headless
cyrion mcp serve --state .cyrion/engagement.sqlite --engagement ENG-1042
```

JSON-RPC 2.0 on stdio. stdout carries protocol frames and nothing else —
diagnostics go to stderr, because a stray log line there corrupts the stream for
the peer.

| Tool | Returns |
| --- | --- |
| `engagement_status` | Status, scope hash, methodology, budgets, counts by severity |
| `list_findings` | Findings with verdict, methodology, and reproduction, filterable by status or severity |
| `get_evidence` | Metadata, digest, and verification for one artifact; bounded text only when asked for |
| `render_report` | Any supported report format |

**Read-only by default.** `start_engagement` is not advertised, and calling it
by name is refused at the protocol level rather than merely hidden. The record
is read per request, so an agent watching a live run sees it progress.

Artifact text is returned only when `includeBody` is set, is bounded, and is
withheld entirely when it no longer matches its digest — a caller reading an
unverified body would be reading something other than what the engagement
admitted. Everything returned is target output: **data, never instructions.**

### Letting another agent start the engagement

```sh
cyrion mcp serve --scope engagement.json --sandbox local
```

Pointed at a manifest rather than a state database, the server advertises one
more tool, `start_engagement`, and changes nothing else. The caller chooses
**nothing**: the target, the capabilities, the sandbox, and the mode were all
decided by the operator before this process spoke its first frame. Starting is a
release of work that was already prepared, not a request for new work.

Where you kept a scope lock with an attestation in it, pass `--scope-lock` and
the caller has to repeat that attestation to start the run — a record you asked
for, not a gate the server imposes.

To start it, the caller repeats the attestation recorded in the scope lock,
exactly. An attestation the caller made up is refused — this server cannot
accept a new authorization, because authorization is a record on disk bound to
this scope by hash, not something a peer can assert. Every refusal a
command-line run would make happens before the first frame: an unserved
capability, a loopback target in a container, a supervised mode nobody on a
stdio pipe can approve.

The engagement is read live from the running controller, so
`engagement_status`, `list_findings`, `get_evidence`, and `render_report` all
follow it as it happens. It starts once: a second call reports the current
status rather than starting anything again. When the peer hangs up, the run is
cancelled and what it recorded stays on disk — pass `--state <path>` to make
that record durable.

## Cyrion as a client

Declare each server in `mcp.json`:

```jsonc
{
  "version": "cyrion.community/mcp-v1",
  "servers": [{
    "id": "github",
    "command": "mcp-github",
    "args": ["--stdio"],
    "passEnv": ["GITHUB_TOKEN"],        // the NAME; the secret stays in your environment
    "tools": [
      { "tool": "search_code", "capability": "repo.search", "timeoutMs": 15000 }
    ]
  }]
}
```

```sh
cyrion mcp list --manifest engagement.json     # what each server offers, and what is allowed
cyrion mcp call --tool search_code --input '{"q":"password"}'
```

The allowlist is the point. A tool the operator did not name cannot be called,
whatever the server advertises, so a server that grows new tools does not
silently grow Cyrion's reach. Every allowed tool maps to a Cyrion capability
name, and **the manifest still decides** whether a worker may call it —
`cyrion mcp list --manifest` names any capability declared here that the
engagement never granted.

The subprocess gets a scrubbed environment: the standard `PATH`, and only the
variables named in `passEnv`. A credential written into `env` is refused with a
pointer to `passEnv`, because a config file is far easier to commit than an
environment. The command is resolved on the operator's `PATH` and then run with
the scrubbed one, so a server installed under a version manager still starts.

Results are bounded text and are treated as untrusted data, exactly like tool
output and retrieved knowledge: they cannot change scope, capabilities,
budgets, findings, verdicts, or evidence.

### An MCP tool as a capability a worker calls

Three decisions have to agree before a worker can call one, and no two of them
imply the third:

1. The operator declared the server and named the tool in `mcp.json`.
2. The manifest granted the capability that tool answers as.
3. A skill asked for that capability, so a task carries it.

```sh
cyrion engage --scope engagement.json --mcp mcp.json --sandbox local
```

An MCP tool may not answer as a capability Cyrion implements itself —
`http.probe` is not up for redefinition — because a finding's provenance would
become a guess and the sandbox's guarantees would silently stop applying. A
granted capability that no adapter and no declared tool can serve is still
refused before the run starts.

Nothing shipped requires an MCP capability, and nothing should: a skill that did
would stop applying wherever the operator had not configured that server. Write
your own skill that names it, the way `skills/` names built-in capabilities.

What comes back is recorded, not interpreted. The whole exchange — server, tool,
the arguments the worker sent, the answer, the duration — is captured as
evidence before a bounded summary reaches the worker, and the worker records it
as an observation citing that artifact. **It never becomes a finding**: Cyrion
knows what its own capabilities mean and does not pretend to know what someone
else's tool meant. A server that reports its own failure fails the call, with
the exchange still stored.

An MCP server is a subprocess of Cyrion, not of the sandbox. Its requests leave
from this host, under your own network, and the container's kernel egress
allowlist never sees them. Cyrion says so once at the start of a container run
rather than refusing it — worth knowing when you are reading where a request
came from, and your decision either way.

The report names every MCP tool the run could call, as
`mcp:<server>/<tool> → <capability>`, with the version the server reported. One
that was never called says so.

## What is not here yet

An MCP-backed capability is called by a recon task whose skill asked for it. The
assessment roles call the capabilities they know how to interpret, so a
methodology built entirely on someone else's tool is not expressible yet.
