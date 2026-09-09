# Product terminal

The interactive terminal is a keyboard-first view over the controller's durable
event stream. It does not expose hidden model reasoning. Every status, task,
finding, and evidence reference comes from the public engagement snapshot.

## Views

| Key | View | Operator workflow |
| --- | --- | --- |
| `1` | Mission | Read Root's plan, recent events, engagement limits, and Root chat replies, and start the next assessment with `n`. |
| `2` | Attack | Watch the run happen to the target: every request, what came back, and every finding as it is raised. |
| `3` | Swarm | Select every dispatched worker and inspect its assignment, capabilities, lease, events, and result. |
| `4` | Findings | Select a finding, read its validation state, and press `Enter` or `e` to follow its first supporting artifact. |
| `5` | Evidence | Select artifacts and inspect metadata, SHA-256 status, and a bounded local preview. |
| `6` | Settings | Review and edit the OpenCode selection, the LLM endpoint, Root planner, worker review, mode, scenario, and color profile. |

## Watching the run

The Attack view is the engagement as it happens to the target, one line per
exchange:

```
00:04 → web-01        http.probe https://app.example.test/
00:04 ← web-01        http.probe https://app.example.test/            8ms
                      200 text/html · 1.2 kB
00:04 ! web-01        raised F-HEADERS-a845c387
                      Missing browser protection headers
00:06 → validator-01  poc.run https://app.example.test/             520ms
                      reproduced · 1 step · bundle E-0014
```

`→` a request, `←` what came back, `✗` a refusal and why, `!` a finding
changing state, `◆` a Root decision. Leases, heartbeats, and budget updates are
left out: they are how the controller keeps time, not what happened to the site.

The view follows the newest line. Scrolling up with `↑`/`↓`, `PgUp`/`PgDn`, or
`Home` releases the pin so an event cannot yank the screen away mid-read; `End`
or `f` re-arms it. Everything the target influenced — a status line, a refusal
reason — is bounded and stripped of control characters before it is recorded,
so a hostile response cannot drive your terminal.

`/` in the Findings view filters the list — by identifier, title, asset,
verdict, severity, or the methodology that produced it, so `high`, `confirmed`,
or a path all narrow it the way a reader expects. `esc` clears the filter.

`<` and `>` fold the left and right panes away and give the space to the centre,
which is where the reading happens. The terminal width still decides what can be
shown at all.

## Starting the next assessment

`n` under Mission opens the same form `cyrion scan` does — target,
capabilities, sandbox, mode, and who authorized it — over the run on screen.
`↑↓` move, `←→` change a choice, `space` toggles a capability, `Enter` types
into a field, `s` starts, and `Esc` closes the form with the draft intact.

While the form is open it owns the keyboard, so a key meant for a field cannot
pause the run or export a report behind it. `1`–`6` and `[`/`]` still move
between views, and the draft is waiting when you come back.

Pressing `s` ends the engagement on screen: its workers are cancelled and its
state released before the new manifest and scope lock are written, and the new
engagement then opens in the same terminal. Everything the finished run
recorded stays on disk. The sandbox carries over because it describes this
machine; the target and the attestation never do.

The form is also there while watching someone else's run. Starting one is not
reaching into the watched engagement — it is a new engagement, with its own
manifest and its own authorization, running here.

## Watching a run you did not start

```sh
cyrion watch ENG-1042 --state .cyrion/engagement.sqlite
cyrion watch ENG-1042 --state .cyrion/engagement.sqlite --headless --until-finished
```

A headless run on a server, a `cyrion ci` job, a colleague's terminal — all of
them write the same durable record, and `watch` reads it. Every view works,
including the live transcript, because the watcher rejoins the stored snapshot
with the event log.

Every operator control refuses instead of acting. A second process reaching into
a running engagement is the kind of thing the controller exists to prevent, so
pause, resume, approve, deny, and Root chat all say plainly that this session is
watching rather than running.

Use arrow keys or `j`/`k` to move within a view. Use left/right or `[`/`]` to
move between views. Press `?` or `Ctrl+K` for the in-product command reference.
Outside Settings, `r` writes the Markdown report for the current snapshot next
to the engagement artifacts and shows the resulting path in the footer.

Run `cyrion providers --select` before opening the dashboard to choose a model
from the providers OpenCode reports as connected. The active selection is shown
in the mission briefing and engagement inspector.

In Settings, use up/down or `j`/`k` to select a field and left/right to cycle
its available values. The three typed fields — LLM endpoint URL, LLM model, and
LLM key variable — are edited instead of cycled: press `Enter` to open the
footer editor, `Enter` again to apply, `Escape` to cancel. Press `s` to save,
`r` to discard draft changes, and `d` to refresh OpenCode discovery. The page
writes only Cyrion-managed keys to the owner-only `.env` file, preserves
credential lines without rendering them, and applies saved defaults on the next
launch. The active engagement is not mutated. Use `[`/`]` or a numbered
shortcut to leave the view while left/right is reserved for editing.

Saving validates the profile with the same rules the provider layer enforces,
so Settings cannot store an endpoint that would only fail at the next launch: a
malformed URL, half of an endpoint, a key variable that is not an environment
variable name, or cleartext to a remote host is refused with the reason. Only
the **name** of the credential variable is stored; the key itself is never read
or rendered here.

## When a configured runtime is unavailable

A saved default that cannot be satisfied — no model endpoint, an unreachable
one, an OpenCode provider that is not connected — never keeps the terminal from
opening. Cyrion runs the deterministic runtime instead, states the reason in the
footer at launch and under `RUNTIME NOTICE` in the Settings sidebar, and leaves
the page that fixes it one keystroke away. A runtime named on the command line
(`--planner llm`) is treated differently: that is a request for this run, so it
fails with the reason rather than quietly running something else.

Selecting the `OPENCODE` Root planner or worker review enables guarded provider
sessions on the next launch. The terminal labels this as `HYBRID`: OpenCode can
review exact controller proposals and canonical worker results while fixture
workers retain all tool, finding, verdict, report, and evidence ownership.

The dashboard owns the keyboard by default. Press `i` or `Tab` to focus Root
chat, `Enter` to send, and `Escape` or `Tab` to return to navigation. Root chat
returns a concise summary derived from recorded state; it is not a hidden chain
of thought or an authorization channel.

## Layout

Every view uses the same three regions: the delegation tree on the left, the
active workspace in the center, and an inspector on the right. Panel headings
pair a label with a state token (`LIVE`, `RUNNING`, `3 TASKS`) above a rule.

### The delegation tree

The left pane answers *who asked for whom*. Root delegates, a worker asks for a
specialist, and that specialist can ask for another — so a flat roster of seven
agents would hide the only thing worth knowing about the seventh, which is why
it exists.

```
■  root-agent
├─■ recon
│  2 findings
├─■ web
│  http.crawl acme.test
│  └─■ injection
│     sqli.test /login
│     └─■ authz
│        http.request /admin
├─■ api
│  web.fuzz /api/v1/
│  └─■ idor
│     queued
└─■ validator
   poc.run /login
──────────────────────────────────
5 active  /  7 agents  /  depth 3
```

Nodes are named by the **role** they carry, because what a specialist is *for*
is what tells an `idor` branch from an `xss` one at a glance. Under each is what
that agent is doing: a running agent shows its current tool call and target — "what
is it doing to my site right now" — and a finished one shows what it produced.

Children are drawn depth-first, directly under the task that asked for them, so
a spawn never has to be reconstructed by matching identifiers. Each node draws
its own elbow from the ancestors still continuing, so a branch under a finished
sibling does not trail a rule through empty space. In a narrow pane the depth
count gives way before the line overruns its border.

### Themes

`CYRION_THEME` selects one of `cyrion` (the default teal), `ember` (warm, lower
contrast), `glacier` (cool, high contrast for a projector) or `monochrome`. An
unknown name falls back to the default rather than failing to open.

Colour is doing work rather than decoration: a running agent, a validator
verifying, a refusal and a critical finding have to stay distinguishable in a
tree twenty lines deep. Every theme's body text clears 7:1 against the panel
behind it, and its four state colours are distinct — asserted by test, not by
eye. `NO_COLOR` and `CYRION_COLOR_MODE=monochrome` still win over any named
theme, because a terminal that asked for no colour meant it.

| View | Center | Inspector |
| --- | --- | --- |
| Mission | Briefing, plan with per-task state, activity feed, Root chat — or the new-assessment form | Engagement identity, budget meters, finding counts |
| Swarm | Ruled task board with agent, task, state, and elapsed columns, then the selected worker's live activity | Root dispatch counters, last handoff, selected worker |
| Findings | One card per finding with ID, severity, and verdict | Finding record, validation, linked evidence, remediation |
| Evidence | Artifact index with kind, URI, and digest | Artifact metadata, integrity state, bounded preview |

Activity lines show mission-relative time and a plain-language event label.
Untrusted payload text is never rendered in the feed.

## Lifecycle controls

`r` exports the current Markdown report. `p` pauses or resumes dispatch. Pausing prevents the controller from assigning
new work but does not pretend an already-running provider request stopped
instantly. In supervised mode, `a` approves the pending Root delegation and `x`
denies it without dispatching the proposed tasks. `q` closes the terminal and
asks the controller to cancel active workers. Use `--state <path>` to make
restart reconciliation durable.

## Evidence safety

The inspector reads artifacts only through the configured `EvidenceStore`,
verifies their stored hash, and shows an explicit `VERIFIED` or `HASH MISMATCH`
label. Preview text is length-bounded and C0/C1 terminal control characters are
removed before rendering. Binary artifacts show metadata rather than raw bytes.

## Responsive behavior

- At 120 columns and wider, the terminal shows swarm, workspace, and inspector.
- From 90 to 119 columns, the inspector is folded below the workspace.
- Below 90 columns, one focused workspace pane is shown.
- Setting `NO_COLOR` switches semantic colors to a monochrome palette; labels
  and glyphs continue to communicate every state.

The color theme uses translucent blue-black panel layers over a near-black base,
cyan focus states, and restrained green/amber/red status colors. Alpha blending
adds depth in terminals that support it; labels and borders preserve the same
hierarchy where transparency is flattened.
