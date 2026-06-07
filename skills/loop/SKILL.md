---
name: loop
description: >
  Run another workflow (or a plain recurring task) repeatedly on a fixed interval.
  Supports --max iters and composes naturally with /goal for "loop until the goal says done".
  Use for continuous triage, periodic research, watchdog checks, etc. Triggered by
  "/loop", "every 10 minutes run", "recurring", or "poll ...".
metadata:
  short-description: "Recurring execution of a workflow or task at a fixed interval (first-class /loop)"
---

# /loop — recurring / scheduled workflow execution

Runs the bundled grok-workflows loop harness. It parses an interval (10s / 5m / 1h / 1d),
delegates to the named sub-workflow (or falls back to a plain agent task), sleeps the
interval, and repeats. Results from each tick are collected; a lightweight dry-streak
heuristic stops plain tasks that go silent. Use `--max N` to bound it. Pair with /goal
for a criteria-driven stop instead of (or in addition to) a wall-clock schedule.

## Usage
`/loop <interval> <sub-workflow-or-task> [--max N] [--no-fire]`

Examples:
```
/loop 10m triage ./current-backlog.txt --max 20
/loop 1h deep-research "weekly status of the Node.js permission model and breaking changes"
/loop 30s "is the production build green on main?" --max 5
```

The interval is the first token. The remainder (after stripping --max / --no-fire) is passed
to the sub harness or used as a plain prompt.

## How it runs

Self-locating launcher at `<skill-dir>/scripts/run.mjs` → harness at the plugin root.
Each tick resets the engine's agent counter (so a long-lived loop doesn't hit the global
cap from accumulated work).

Returns:
```json
{
  "subcommand": "triage ./current-backlog.txt",
  "intervalMs": 600000,
  "iters": 4,
  "stopReason": "max-iters",
  "lastResult": { ... },
  "historySummary": [ { "iter": 0, "hasResult": true, "type": "object" }, ... ]
}
```

## What to do with the result

- Present the `lastResult` (the most recent successful inner output).
- Mention how many iters ran and why it stopped (`stopReason`).
- For continuous processes, the user will typically run the /loop command itself under
  Grok's own `/loop` (or an external scheduler) so the whole recurring harness stays alive.
- When you want criteria-driven stopping instead of pure wall time, compose:
  `/loop 5m /goal 'the queue is empty and all critical items are either fixed or escalated' :: triage ./queue.txt`

You do not re-implement the timer/delegation — call the launcher and act on the JSON.
