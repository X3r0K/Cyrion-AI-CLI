# Targets and scope

Scope is data the controller enforces, not a sentence in a prompt. Every task
target, tool invocation, resolved address, and redirect is checked against the
same engine, and an entry means exactly what the operator wrote.

## Target expressions

`scope.targets` and `scope.excluded` hold expressions. The kind is inferred from
the syntax, and may be stated explicitly with `host:`, `url:`, or `repo:`.

| Expression | Kind | Covers |
| --- | --- | --- |
| `demo.lab.test` | host | Exactly that hostname |
| `*.example.test` | host | Subdomains only — never the apex, never a sibling like `notexample.test` |
| `10.10.0.0/24` | host | Every address in the range, and any sub-range of it |
| `10.10.0.5:22,8000-8100` | host | That address on those ports only |
| `[2001:db8::1]:443` | host | An IPv6 literal with a port |
| `https://app.example.test` | url | The whole origin on the scheme's default port |
| `https://app.example.test/api/*` | url | That path and everything under it |
| `https://app.example.test/health` | url | That exact path, not its subtree |
| `./services/api` or `repo:./services/api` | repo | That directory and its subtree |

Rules that keep an entry honest:

- **Exclusions are evaluated first and always win.** `10.10.0.0/24` with
  `10.10.0.1` excluded admits `.2` and refuses `.1`.
- **Kinds do not cross.** `https://app.test` does not authorize host-level
  scanning of `app.test`; list the host separately if that is intended.
- **Schemes and ports are never assumed.** `https://app.test` does not cover
  `http://app.test` or `https://app.test:8443`.
- **A wider range is never admitted by a narrower one.** With `10.10.0.0/16`
  approved, `10.10.4.0/24` is in scope and `10.0.0.0/8` is not.
- Credentials in a URL, a query or fragment, and a `..` segment are rejected
  outright rather than normalized away.

Ports: an entry without ports admits any port. An entry *with* ports admits a
candidate that names no port, because a port-less operation asserts no
connection; a capability that does connect passes `requirePort` so the check
becomes strict.

## Checking a scope

```sh
cyrion scope check --manifest engagement.json
cyrion scope check --manifest engagement.json --target 10.10.0.9
cyrion scope check --manifest engagement.json --target evil.example.com --check   # exit 1
```

The canonical form is parsed, normalized, sorted, and deduplicated, so a
reordered manifest hashes identically and a widened one does not.

## The scope lock

A lock is the operator's written statement that this exact scope is authorized:

```sh
cyrion scope lock --manifest engagement.json \
  --attest "Authorized by the platform team, ticket SEC-1042"
```

It records the engagement ID, the scope hash, the canonical scope text, the
attestation, and a timestamp. Supply it to a run with `--scope-lock scope.lock`:
the controller verifies it before the first task and refuses to start when the
scope has changed, when the lock belongs to another engagement, or when the
attestation is missing. Widening scope therefore requires a new attestation
rather than inheriting the old one.

The terminal shows the short scope hash and whether an operator lock was
accepted. Every engagement records its scope hash in `engagement.started`, so a
report can state which scope produced it.

## Redirects and DNS

Two checks exist for the moment a capability actually connects. They are part of
the engine now and become enforced at the network layer when sandboxed tooling
lands.

**Redirects** are re-validated before they are followed. A hop that leaves the
approved scope is recorded as an observation rather than chased, and an
`https` to `http` downgrade is refused unless the caller accepts it explicitly.

**DNS pinning** records the addresses a hostname resolved to when a task
started. Every later connection must use one of them, so a second answer cannot
move a task to a host nobody approved. When a hostname that resolved publicly
suddenly resolves to a private address, the refusal says so — that shape is
rebinding, not a legitimate change.

Addresses are also checked directly: `evaluateAddress` decides whether a
connection address falls inside an approved host entry, which is what an egress
allowlist will be generated from.
