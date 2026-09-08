# Product terminal

The interactive terminal is a keyboard-first view over the controller's durable
event stream. It does not expose hidden model reasoning. Every status, task,
finding, and evidence reference comes from the public engagement snapshot.

## Views

| Key | View | Operator workflow |
| --- | --- | --- |
| `1` | Mission | Read Root's plan, recent events, engagement limits, and Root chat replies. |
| `2` | Swarm | Select every dispatched worker and inspect its assignment, capabilities, lease, events, and result. |
| `3` | Findings | Select a finding, read its validation state, and press `Enter` or `e` to follow its first supporting artifact. |
| `4` | Evidence | Select artifacts and inspect metadata, SHA-256 status, and a bounded local preview. |
| `5` | Settings | Review and edit the OpenCode selection, the LLM endpoint, Root planner, worker review, mode, scenario, and color profile. |

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

Every view uses the same three regions: the swarm tree on the left, the active
workspace in the center, and an inspector on the right. Panel headings pair a
label with a state token (`LIVE`, `RUNNING`, `3 TASKS`) above a rule.

| View | Center | Inspector |
| --- | --- | --- |
| Mission | Briefing, plan with per-task state, activity feed, Root chat | Engagement identity, budget meters, finding counts |
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
