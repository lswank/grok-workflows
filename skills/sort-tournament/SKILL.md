---
name: sort-tournament
description: Rank a list of items by a qualitative criterion using pairwise comparison instead of unreliable absolute scoring. Use when the user wants to sort/rank/prioritize many items by a fuzzy quality (severity, urgency, quality, risk, fit, importance), triage support tickets, pick the best few of a set, or asks for /sort-tournament.
metadata:
  short-description: "Rank items by a qualitative criterion via pairwise comparison"
---

# /sort-tournament — Qualitative ranking by pairwise comparison

Ranks a list of items by a soft, qualitative criterion (e.g. "support tickets by
severity", "feature ideas by impact", "candidates by seniority"). It uses
**pairwise comparison** — each judgment is "which of these two is more X?" run in
its own fresh agent — which is far more reliable than asking a model for absolute
1–10 scores that drift between calls.

The running order is held in a deterministic loop; only the current pair is ever
sent to an agent, so it scales to hundreds or thousands of items without context
overflow.

## Usage
`/sort-tournament <criterion> :: <item1> | <item2> | <item3> ...`

Variants:
- Top-k only (the best few): append `top:N` —
  `/sort-tournament severity :: ticket A | ticket B | ... top:5`
- From a file (one item per line, first line `criterion: ...`):
  `/sort-tournament /path/to/items.txt`

## How it runs

This skill delegates to the bundled grok-workflows harness — do NOT re-implement
the ranking inline. Run it with `run_terminal_cmd`:

```bash
node <repo>/workflows/sort-tournament.mjs "<criterion> :: item1 | item2 | ..."
```

(Replace `<repo>` with the absolute path to this grok-workflows checkout. For a
long item list, write the items to a temp file with `criterion: ...` as the first
line and pass that file path instead.)

The harness prints a JSON object to stdout:

```json
{ "criterion": "...", "ranked": ["best", "...", "worst"], "comparisons": 42 }
```

(`top:N` runs additionally return `mode: "tournament-top-k"` and may include
`unranked`.)

## What to do with the result

After the command prints its JSON:
1. Parse the `ranked` array (already best-first).
2. Present a numbered, ranked list to the user, grouping or annotating as the
   task implies (e.g. for ticket triage, label the top group "address first").
3. If the user asked for a written deliverable, write a short report file with
   the ranking and note `comparisons` (how many pairwise judgments backed it).
4. If the user wants action taken (reorder a backlog, label tickets), use the
   ranking to drive that — one item at a time.

Keep your summary focused on the ranking; the per-comparison reasoning stays
inside the harness.
