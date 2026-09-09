# browser.session — rendering a page without leaving the engagement

A crawl reads the links a site publishes. That is most of a server-rendered
application and almost none of a single-page one: the endpoints that matter are
the ones a script calls after the document loads, and no amount of HTML parsing
finds them. Rendering the page finds them by letting it run.

The cost is that a page fetches whatever its markup and scripts tell it to —
fonts, analytics, a tag manager, an API on a host nobody approved. Every other
capability makes the requests *it* decided to make. Left alone, a headless
browser is the single most likely capability to leave the scope, and it would do
it from the operator's own machine.

So the request filter is the capability, and the rendering is the easy part.

## Every request is a scope decision

`browser.session` intercepts every request the page attempts and puts its URL
through the same scope engine the rest of Cyrion uses. Out of scope is
**aborted**, not noted afterwards — the request never leaves.

| Request | Outcome |
| --- | --- |
| Inside the approved scope | Allowed, and recorded |
| A third-party host | Aborted, and recorded with the reason |
| A path the manifest excluded | Aborted — exclusions win here as everywhere |
| `data:`, `blob:`, `about:` | Allowed; none of them leave the machine |
| Any other scheme (`file:`, `ws:`) | Aborted |
| Past 300 requests in one load | Aborted, and the summary says it was truncated |

Redirects go through the same filter, so a navigation that leaves the scope is
refused mid-flight rather than followed. The summary states the URL the page
settled on and whether that URL is in scope.

A discovered endpoint is a report, not a permission — the same rule `http.crawl`
follows. The endpoints a page called are recorded on an observation; reaching
one of them takes a manifest that already covers it.

## What comes back

```
rendered /app → 200 · Orders · 14 requests, 2 refused
```

- **Summary**: final URL, whether it redirected and whether that URL is in
  scope, status, title, the hosts it reached, the hosts it was refused, the
  `fetch`/`xhr` endpoints it called, its own console errors and warnings, and a
  bounded slice of the rendered DOM.
- **Evidence**: a PNG screenshot, a JSON session record with the full request
  log, and the rendered DOM. All three hashed like any other artifact.

Console text is the page's own words, so it is bounded and stripped of terminal
control characters before it reaches a log.

## Installing it

Playwright is not a dependency of Cyrion. A browser and its driver are a hundred
megabytes for a capability most engagements never grant, and `--sandbox local`
is meant to work on a machine with nothing installed. So this is the same
bargain as nmap — absent is fine, and the error says what to run:

```sh
bun add playwright && bunx playwright install chromium
```

`cyrion tools` reports it as `MISSING (optional)` until then, and never installs
it for you.

## The sandbox it is not in

The browser is driven from the Cyrion process, not from inside the worker
container. Under `--sandbox container` that means its requests are **outside the
kernel egress allowlist** that governs every other capability; the per-request
filter above is the substitute, and a userspace filter is a weaker guarantee
than the kernel's.

Rather than let that be discovered in a report, a container run refuses
`browser.session` outright:

```
browser.session runs the browser on this host, outside the container's egress
allowlist. Scope is enforced per request by Cyrion rather than by the kernel.
Pass --allow-host-browser to accept that, or run with --sandbox local.
```

`--allow-host-browser` accepts the trade explicitly. In `--sandbox local` there
is no gap to accept, because nothing else was behind a kernel boundary either.

## What this does not do

- It does not click, type, or log in. v1 loads a page and observes it; there is
  no action list, because a scripted action list is the beginning of handing a
  model a browser to drive, and invariant 1 says a model asks for a capability
  rather than receiving one.
- It does not pin DNS for the requests the page makes. The target host is
  pinned before navigation like any other capability, but Chromium resolves the
  hosts it fetches itself, and Cyrion sees the URL rather than the address. The
  scope filter still applies by name.
- It is not in the worker image, so `cyrion tools --sandbox container` lists it
  as absent there.
