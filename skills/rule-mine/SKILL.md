---
name: rule-mine
description: Mine recurring corrections and repeated mistakes out of past sessions, transcripts, or code-review comments, cluster them, verify each one would have prevented a real mistake, and distill the survivors into ready-to-paste AGENTS.md/CLAUDE.md rules. Use when the user wants to turn past feedback into standing guardrails, "extract rules from my sessions", "what should I add to AGENTS.md / CLAUDE.md", mine review comments for patterns, or asks for /rule-mine.
metadata:
  short-description: "Mine recurring corrections into verified AGENTS.md/CLAUDE.md rules"
---

# /rule-mine — distill recurring corrections into guardrail rules

Turns a pile of past sessions / transcripts / review comments into a short,
verified set of rules for an AGENTS.md (Grok) or CLAUDE.md file. It extracts
candidate corrections in parallel, clusters near-duplicates into themes, drafts
one rule per theme, then runs a SKEPTIC persona plus adversarial verification so
only rules that would have prevented a real, specific mistake survive.

## Usage
`/rule-mine <path to a sessions/transcripts/review-comments file or directory>`

## How it runs

This skill delegates to the bundled grok-workflows harness — do NOT re-implement
the extraction/clustering/verification inline. It bundles a self-locating launcher
at `<skill-dir>/scripts/run.mjs`, where `<skill-dir>` is this skill's own directory
(its absolute path is announced in your system context). Derive the launcher path
from that announced SKILL.md path and inline the absolute path into a single
`run_terminal_cmd` call — don't rely on the working directory or a shell variable:

```bash
node <skill-dir>/scripts/run.mjs "<path to file or dir>"
```

(The launcher locates its bundled harness itself, so no repository path is needed.
Set `GROK_WORKFLOWS_MOCK=1` to dry-run without spending xAI credits.)

The harness prints a JSON object to stdout:

```json
{
  "rules":   [{ "rule", "theme", "instances", "evidence", "rationale" }],
  "rejected":[{ "rule", "theme", "rejectedBy", "reason" }],
  "markdown": "## Mined rules\n- ...",
  "stats":   { "files", "slices", "candidates", "clusters", "survived", "rejected" }
}
```

## What to do with the result

1. Parse the JSON from stdout (progress logs go to stderr — ignore them).
2. Summarize for the user: how many candidates were found, how many clusters,
   how many rules survived vs. were rejected, and by what (skeptic vs. verifier).
3. Present the `markdown` block — it is paste-ready bullets under a
   `## Mined rules` heading. If the user asks, append it to their AGENTS.md or
   CLAUDE.md (confirm the target file first; show the diff before writing).
4. If the user wants detail on a dropped rule, surface the matching entry from
   `rejected` with its `reason`.

Keep your own output focused on the survivors and the recommended file edit; the
harness already did the mining and verification.
