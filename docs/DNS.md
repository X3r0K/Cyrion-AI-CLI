# DNS — what a name publishes, and what it hands off to

Two capabilities read DNS, and they answer different questions.

| Capability | Question | Effect on the run |
| --- | --- | --- |
| `dns.lookup` | What addresses does this name resolve to? | **Pins them.** Every later connection is held to that set, and the container's egress allowlist is built from it. |
| `dns.enum` | What does this name publish, and whose infrastructure does it depend on? | None. It reports; it never pins. |

Keeping the pin under one owner matters. If both wrote it, a later connection
would be held to whichever answer happened to arrive last, and a rebinding check
would be arguing with itself.

## Passive, in a specific sense

`dns.enum` asks about the name the operator approved and nothing else. It
queries A, AAAA, CNAME, MX, NS, TXT, SOA and CAA for that one name.

There is no wordlist and no subdomain guessing — not because guessing is hard,
but because it is pointless here: a subdomain Cyrion invented is not in the
manifest, so finding it would produce an address the engagement may not touch.
A wildcard target is refused for the same reason.

Implemented inside Cyrion rather than through `dnsx`, for the reason
`http.crawl` is: `--sandbox local` has to keep working on a machine with nothing
installed, and a record lookup needs no binary to make.

## Absent is an answer

A resolver reports "this name publishes no CNAME" by failing the query, so the
two outcomes arrive down the same path. They are told apart before anything is
reported:

- **`absent`** — the zone answered, and it has no records of that type.
- **`failed`** — the query itself broke, with the resolver's code (`ESERVFAIL`,
  `ETIMEOUT`, …).

"No MX" and "the MX query broke" are different facts about a zone, and a reader
needs both. One failed type never costs the answers of the others.

## Delegation is a report, not a permission

NS, MX and CNAME records all name *other* hosts, and very often somebody else's
— a mail provider, a CDN, a registrar. Each one is checked against the manifest
and labelled:

```
delegations:         hera.ns.cloudflare.com (NS, out of scope)
                     elliott.ns.cloudflare.com (NS, out of scope)
externalDelegations: hera.ns.cloudflare.com, elliott.ns.cloudflare.com
```

None of them is ever queried. Learning that a zone depends on a third party is
useful — it is often the finding — but it is not authorization to go and look at
that third party. This is the same rule `http.crawl` and `browser.session`
follow: a discovered address is a report, and reaching it takes a manifest that
already covers it.

## Bounds

TXT records are free text a zone's operator wrote, which puts them in the same
class as a response body. Every value is stripped of control characters and cut
to 512 characters, and each type keeps at most 32 records, so a zone that
publishes thousands cannot flood a summary or a log line.

## When the answer disagrees with the pin

If `dns.lookup` already pinned this name and `dns.enum` sees different
addresses, the summary says so with `matchesPin: false`. It does not change the
pin — a name that starts answering differently mid-engagement is the rebinding
case the scope engine already refuses, and the useful thing here is to say it
plainly rather than to act on it.
