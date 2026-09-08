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

## What is not here yet

Starting an engagement from another agent is refused in this release. It needs a
scope lock bound to the manifest — the same authorization record a run from the
command line needs — and this server does not yet hold one. Run `cyrion engage`
or `cyrion ci`, then serve the resulting state read-only.

MCP-backed capabilities are declared and validated, and can be driven by hand
with `cyrion mcp call`, but are not yet registered into the capability registry
that workers call through. Until they are, an MCP tool is an operator
instrument rather than a worker capability.
