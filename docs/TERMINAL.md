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
| `5` | Settings | Review and edit provider, model, default mode, demo scenario, and color profile. |

Use arrow keys or `j`/`k` to move within a view. Use left/right or `h`/`l` to
move between views. Press `?` or `Ctrl+K` for the in-product command reference.

Run `cyrion providers --select` before opening the dashboard to choose a model
from the providers OpenCode reports as connected. The active selection is shown
in the mission briefing and engagement inspector.

In Settings, use up/down or `j`/`k` to select a field and left/right to cycle
its available values. Press `s` to save, `r` to discard draft changes, and `d`
to refresh OpenCode discovery. The page writes only Cyrion-managed keys to the
owner-only `.env` file, preserves credential lines without rendering them, and
applies saved defaults on the next launch. The active engagement is not
mutated. Use `h`/`l` or a numbered shortcut to leave the view while left/right
is reserved for editing.

The dashboard owns the keyboard by default. Press `i` or `Tab` to focus Root
chat, `Enter` to send, and `Escape` or `Tab` to return to navigation. Root chat
returns a concise summary derived from recorded state; it is not a hidden chain
of thought or an authorization channel.

## Lifecycle controls

`p` pauses or resumes dispatch. Pausing prevents the controller from assigning
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
