# Pacing — what one host is asked to endure

Budgets bound an engagement: how many agents, how many tasks, how long, how
much. None of them bound what a single machine receives. Twelve agents inside
every budget are twelve simultaneous scanners if they all pick the same
endpoint, and that is the most likely way an authorized assessment causes real
damage — not by reaching outside the scope, but by hitting something inside it
too hard.

So there is a second set of limits, counted per host and shared by every agent.

## The limits

| Field | Means | Default |
| --- | --- | --- |
| `minRequestGapMs` | Least time between two requests reaching one host | `100` |
| `maxConcurrentPerTarget` | Requests in flight against one host at a time | `4` |
| `maxRequestsPerTarget` | Requests one host receives for the whole engagement | `2000` |
| `maxQueueWaitMs` | Longest a call waits for a slot before it is refused | `30000` |

State them in the manifest to pace a fragile target harder:

```json
{
  "limits": {
    "minRequestGapMs": 500,
    "maxConcurrentPerTarget": 1,
    "maxRequestsPerTarget": 300,
    "maxQueueWaitMs": 60000
  }
}
```

A manifest that states no `limits` gets the defaults. A partial block is
refused rather than filled in: half a pacing policy reads like a whole one.
`maxConcurrentPerTarget` may not exceed 64 and `minRequestGapMs` may not exceed
60 seconds, because a limit permitting a thousand concurrent requests looks like
a control in the manifest while behaving like its absence.

## The unit is the host

A limit is counted against the **hostname**, not the target expression. Two
tasks aimed at `https://app.example.test/orders` and
`https://app.example.test/invoices` have not found two machines to talk to, and
keying on the expression would let a planner pace itself out of every limit by
naming more paths. A bare host, a URL on that host, and a URL on a different
port are all the same host.

Repository targets reach no host and are not paced. Reading files off a disk is
not a swarm.

## Waiting, and the two cases that are not waiting

Waiting is the normal outcome. A request that would exceed the pace is held
until it may go, because refusing legitimate work to keep a rate would just move
the problem into the findings. The wait is recorded on `tool.request.accepted`
as `waitedMs`, so an operator watching a slow run can see what accounts for the
time.

Two cases refuse instead:

- **The host has spent `maxRequestsPerTarget`.** A ceiling that silently became
  a queue would be a run that never ends.
- **The wait would exceed `maxQueueWaitMs`.** Past that point the operator is
  owed the word "refused" rather than a run that appears to have stalled.

Both are recorded as `tool.request.rejected` with the limit that caused them
named in the reason, and both count toward the refusals a report states.

## Where it is enforced

In the tool gateway, which is the only place a capability can be called from —
one limiter per engagement, so it counts what the host actually feels rather
than what any one worker did. An adapter cannot reach a target by a route that
skips it, and the tool's own timeout starts only once the call is allowed to
leave, so queued time never fails a healthy tool.

Every report states the pacing that was in force. A client asks two separate
questions about an assessment: what did it cost, and how hard did you push my
server. The second one now has an answer.
