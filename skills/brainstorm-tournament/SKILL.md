---
name: brainstorm-tournament
description: Brainstorm many options for a naming/design/approach decision from diverse angles, then run a rubric-scored pairwise tournament to pick the top 3. Use when the user wants help naming a tool/product/project, choosing a design direction, picking among approaches, asks you to "brainstorm options and pick the best", wants a ranked shortlist of ideas, or asks for /brainstorm-tournament.
metadata:
  short-description: "Brainstorm from many angles, then rubric-tournament to a top-3"
---

# /brainstorm-tournament — diverse generation + rubric-scored pairwise tournament

Runs the bundled grok-workflows harness, which generates candidates from several
distinct angles (literal, evocative, playful, technical) in fresh agent contexts
so the pool is genuinely diverse, dedupes them, derives or accepts a judging
rubric, and runs a pairwise tournament (one agent per match) to find #1, #2, and
#3. Pairwise comparison beats noisy absolute scoring for taste calls. You do not
re-implement any of this — you invoke the harness and act on its JSON.

## Usage
`/brainstorm-tournament <thing to name/design> [:: rubric]`

Everything before `::` is the subject; anything after `::` is an optional
user-supplied rubric. If no rubric is given, the harness derives one.

## How it runs

This skill bundles a self-locating launcher at `<skill-dir>/scripts/run.mjs` —
`<skill-dir>` is this skill's own directory, whose absolute path is announced in
your system context when the skill loads. Derive the launcher path from that
announced SKILL.md path and inline the absolute path into a single
`run_terminal_cmd` call (don't rely on the working directory or a shell variable).
The launcher locates its bundled harness itself, so no repository path is needed:

```bash
node <skill-dir>/scripts/run.mjs "<thing to name/design> :: <optional rubric>"
```

The harness prints a single JSON object to stdout (progress logs go to stderr):

```json
{
  "rubric": "the rubric that was applied (user-supplied or derived)",
  "top3": [
    { "candidate": "Winner name", "why": "one-line deciding reason" },
    { "candidate": "Runner-up", "why": "..." },
    { "candidate": "Third place", "why": "..." }
  ],
  "poolSize": 24
}
```

## What to do with the result

1. Parse the JSON from stdout.
2. Present `top3` as the primary answer — list each `candidate` with its `why`,
   in rank order (#1 first). Lead with the #1 pick.
3. State which `rubric` was applied so the user can see the basis for the ranking,
   and mention `poolSize` (how many unique candidates were considered) so they
   know the shortlist came from a broad pool, not a silent cap.
4. If `top3` is empty (`poolSize` 0), tell the user no candidates survived and
   suggest rephrasing the subject or supplying a clearer rubric, then re-run.

Do not invent or re-rank candidates yourself — the tournament ranking is the
point of this skill. If the user wants more than three, re-run with a refined
subject or rubric rather than padding the list.
