---
name: triage
description: Classify a support/bug backlog, dedupe each item against what is already tracked, and route every item to merge, queue, or human escalation. Use when the user wants to triage a backlog, sort/process a list of bug reports or support tickets, dedupe an issue queue, decide what to escalate, or asks for /triage.
metadata:
  short-description: "Classify, dedupe, and route a bug/support backlog (quarantined classifier + deterministic router)"
---

# /triage — classify, dedupe, and route a backlog

Runs the bundled grok-workflows harness, which streams each backlog item through
a quarantined read-only classifier (category, severity, duplicate detection), a
deterministic JS router (merge / queue / escalate), and a trusted action agent
that writes an escalation note only for high/critical items. The untrusted
backlog text never drives a privileged action — prompt injection in a bug report
is treated as data, not commands. You do not re-implement any of this; you invoke
the harness and act on its JSON.

## Usage
`/triage <path-to-backlog-file> [:: <path-to-tracked-items-file>]`

The backlog file is one item per line, or a JSON array of strings/objects
(`{id?, title?, body?, text?}`). The optional `:: tracked-file` (same format)
supplies already-tracked items so the classifier can flag duplicates against
them.

## How it runs

Execute the bundled harness with `run_terminal_cmd` (replace `<repo>` with this
repository's absolute path, and pass the backlog path, quoted):

```bash
node <repo>/workflows/triage.mjs "<path-to-backlog-file>"
```

With a tracked-items file for dedupe:

```bash
node <repo>/workflows/triage.mjs "<path-to-backlog-file> :: <path-to-tracked-file>"
```

The harness prints a single JSON object to stdout (progress logs go to stderr):

```json
{
  "triaged": [
    {
      "item": "#1",
      "category": "auth",
      "severity": "critical",
      "action": "escalate",
      "summary": "One-sentence description of the issue.",
      "actionNote": "Escalation note for a human owner (escalate items only).",
      "isDuplicateOf": "#3"
    }
  ],
  "counts": {
    "total": 6,
    "bySeverity": { "critical": 1, "high": 1, "medium": 1, "low": 3 },
    "byAction": { "merge": 1, "queue": 3, "escalate": 2 },
    "duplicates": 1
  }
}
```

`action` is one of:
- `merge` — a duplicate of a tracked or earlier item (`isDuplicateOf` is set).
- `escalate` — high/critical, non-duplicate; carries an `actionNote`.
- `queue` — low/medium; parked for normal handling.

## What to do with the result

1. Parse the JSON from stdout.
2. Lead with `counts` — give the user the shape of the backlog at a glance
   (totals, severity breakdown, how many escalate vs queue vs merge).
3. Surface the `escalate` items first, with their `actionNote` and `summary`,
   since those are what need a human now. Then list `merge` (duplicates, with
   `isDuplicateOf`) and `queue` items.
4. If the user asked for a report or file, write a markdown summary grouped by
   `action` (Escalate / Merge / Queue) to a `.md` file.
5. If any item came back with `category: "unknown"` and `summary: "Unclassified
   item."`, tell the user those failed classification and were defaulted safely
   (the harness never drops or silently caps items) so they can re-run or inspect
   them.

Delegate the orchestration to the harness — do not classify, dedupe, or route
items yourself.
