---
name: eval-skill
description: Lightweight eval harness — runs the SAME task N independent ways, each in its own isolated git worktree and fresh context window, then grades the candidates with separate evaluator agents (per-candidate rubric scoring + a pairwise tournament) to pick and explain the best. Use when the user wants to try a task several ways and compare, asks to "run this N ways and pick the best", wants an A/B/N bake-off of approaches, wants an impartial eval of candidate solutions against a rubric, or asks for /eval-skill.
metadata:
  short-description: "Run a task N ways in isolated worktrees, then grade/compare to pick the best"
---

# /eval-skill — run a task N ways, then grade to pick the best

Runs the bundled grok-workflows harness, which produces N independent candidate
solutions to the SAME task (each in its own isolated git worktree, each a fresh
context window), then grades them with a SEPARATE set of evaluator agents: a
per-candidate absolute rubric score plus a pairwise tournament. The producers
never grade their own work, which structurally defeats self-preferential bias.
Nothing is auto-applied — candidate worktrees are left intact for review. You do
not re-implement any of this; you invoke the harness and act on its JSON.

## Usage
`/eval-skill <task to run N ways> [-- N] [:: rubric]`

- `-- N` sets the number of candidates (default 3, clamped to 2..8).
- `:: rubric` sets the grading rubric (free text). Both are optional.

Example: `/eval-skill implement a fizzbuzz function -- 4 :: correctness, simplicity`

## How it runs

This skill bundles an entrypoint at `<skill-dir>/scripts/run.mjs` (thin delegator
to the centralized launcher logic in `src/launcher.mjs`; self-location still works
via the passed `import.meta.url` from the delegator) —
`<skill-dir>` is this skill's own directory, whose absolute path is announced in
your system context when the skill loads. Derive the entrypoint path from that
announced SKILL.md path and inline the absolute path into a single
`run_terminal_cmd` call (don't rely on the working directory or a shell variable).
The launcher locates its bundled harness itself (via the delegator), so no
repository path is needed:

```bash
node <skill-dir>/scripts/run.mjs "<task to run N ways> [-- N] [:: rubric]"
```

The harness prints a single JSON object to stdout (progress logs go to stderr):

```json
{
  "winner": 3,
  "why": "Candidate #3 (\"...\") ranked first with rubric score 80/100 and won the pairwise tournament. ...",
  "ranking": [
    { "rank": 1, "candidate": 3, "approach": "...", "rubricScore": 80, "wonTournament": true }
  ],
  "rubric": "...",
  "scores": [ { "candidate": 1, "score": 60, "justification": "..." } ],
  "candidates": [ { "candidate": 1, "approach": "...", "summary": "..." } ],
  "tournamentWinner": 3,
  "requested": 3,
  "produced": 3,
  "worktreesLeftForReview": true,
  "note": "Outputs were NOT auto-applied. ..."
}
```

## What to do with the result

1. Parse the JSON from stdout.
2. Report the `winner` and the `why` explanation as the headline answer, then
   show the `ranking` (rank, candidate #, approach, rubricScore, wonTournament)
   as a short table.
3. Surface the grading detail the user cares about: each candidate's `approach`
   and `summary` from `candidates`, and the rubric `scores` with justifications.
4. Mention coverage honestly: `produced` vs `requested` — if `produced < requested`,
   some candidate producers failed and were dropped (nothing was silently capped).
5. Remind the user that outputs were NOT auto-applied: each candidate ran in its
   own git worktree (see the `note` field). To apply the winner, they inspect the
   worktrees (`git worktree list`) and cherry-pick the winning candidate's changes.
   Only apply changes if the user explicitly asks.
6. If `winner` is `null` (e.g. `produced` is 0), tell the user all candidate
   producers failed and suggest re-running or simplifying the task.

Do not re-run the task yourself or re-grade the candidates — the harness already
ran the producers and the impartial evaluators. Your job is to relay and act on
its verdict.
