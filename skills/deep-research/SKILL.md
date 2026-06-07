---
name: deep-research
description: Multi-source web research that fans out searches, fetches sources, adversarially verifies each claim, and synthesizes a cited markdown report. Use when the user wants deep, fact-checked research on a topic, asks you to "research X thoroughly", wants a sourced report, or asks for /deep-research.
metadata:
  short-description: "Deep multi-source research with an adversarially-verified, cited report"
---

# /deep-research — fan-out web research with adversarial verification

Runs the bundled grok-workflows harness, which decomposes the question into
sub-queries, gathers sourced findings per sub-query in quarantined web agents,
adversarially verifies every distinct claim (source quality, factual accuracy,
recency), and has a trusted synthesis agent write a cited report. You do not
re-implement any of this — you invoke the harness and act on its JSON.

## Usage
`/deep-research <question>`

## How it runs

This skill bundles a self-locating launcher at `<skill-dir>/scripts/run.mjs` —
`<skill-dir>` is this skill's own directory, whose absolute path is announced in
your system context when the skill loads. Derive the launcher path from that
announced SKILL.md path and inline the absolute path into a single
`run_terminal_cmd` call (don't rely on the working directory or a shell variable).
The launcher locates its bundled harness itself, so no repository path is needed:

```bash
node <skill-dir>/scripts/run.mjs "<question>"
```

The harness prints a single JSON object to stdout (progress logs go to stderr):

```json
{
  "question": "...",
  "subqueries": ["...", "..."],
  "report": "# ...markdown report with inline [Source](url) citations...",
  "claims": [{ "claim": "...", "source": "...", "url": "...", "subquery": "..." }],
  "dropped": 7,
  "droppedBreakdown": { "duplicates": 2, "refuted": 4, "verifierFailed": 1 }
}
```

## What to do with the result

1. Parse the JSON from stdout.
2. Present `report` to the user as the primary answer (it is already cited
   markdown). If the user asked for a file, write `report` to a `.md` file.
3. Mention the verification stats: how many claims survived (`claims.length`)
   and how many were `dropped` (with the `droppedBreakdown`), so the user knows
   nothing was silently capped.
4. If `claims` is empty, tell the user nothing survived verification and suggest
   narrowing the question.

Do not paraphrase away the inline citations — they are the point of this skill.
