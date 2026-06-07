---
name: root-cause
description: Debug/post-mortem harness that generates competing root-cause hypotheses from disjoint evidence lanes, then puts each through an adversarial panel of skeptics, returning only the hypotheses that survive (ranked by confidence). Use when the user wants to find the root cause of a bug, outage, regression, or business anomaly, asks "why did X break / fail / drop", wants a post-mortem or RCA, or asks for /root-cause.
metadata:
  short-description: "Adversarially-tested root-cause analysis from disjoint evidence lanes"
---

# /root-cause — competing hypotheses, adversarially tested

Runs the bundled grok-workflows harness, which spawns three disjoint evidence-lane
investigators (logs, code, data) that each propose falsifiable root-cause
hypotheses without seeing each other's lane, dedupes them in plain JS, then puts
every distinct hypothesis through an adversarial panel of skeptics. A hypothesis
survives only on majority; if none survive, the harness loops a fresh round with
the rejected claims excluded. You do not re-implement any of this — you invoke the
harness and act on its JSON.

## Usage
`/root-cause <problem description> [-- evidence_file1 evidence_file2 ...]`

The optional `--` separates the problem statement from evidence file paths to feed
the investigators (logs, diffs, dashboards, etc.).

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
node <skill-dir>/scripts/run.mjs "<problem description>"
```

With evidence files:

```bash
node <skill-dir>/scripts/run.mjs "<problem description> -- /path/to/build.log /path/to/diff.txt"
```

**Lane isolation note:** The three disjoint evidence-lane investigators (logs/code/data) are kept apart by prompt instructions (e.g. "STRICTLY restricted to ONE evidence lane... STRICTLY ignore any files, paths... cross lanes, refuse... supportable *only* from your lane's allowed focus") plus `disallowedTools: ['Agent']`. Full technical isolation is not applied because the code lane needs `run_terminal_cmd` to inspect the repo for hypotheses. The problem statement and evidence files are treated as potentially adversarial. See `src/SPEC.md` (rule 9 and the constrain note) for the explicit call-out of this prompt-only tradeoff and the guardrail details. (Cross-ref from the harness implementation.)

The harness prints a single JSON object to stdout (progress logs go to stderr):

```json
{
  "problem": "...",
  "surviving": [
    {
      "claim": "...",
      "evidence": "...",
      "slice": "logs|code|data",
      "survives": true,
      "confidence": 0.67,
      "kept": 2,
      "refuted": 1,
      "votes": [{ "refuted": false, "reason": "..." }]
    }
  ],
  "rejected": [{ "claim": "...", "survives": false, "confidence": 0.0, "...": "..." }],
  "rounds": 1
}
```

## What to do with the result

1. Parse the JSON from stdout.
2. Present `surviving` as the answer, ranked as given (highest `confidence` first).
   For each, lead with the `claim`, then its `evidence` and which `slice` it came
   from. If the user asked for a write-up, render a short post-mortem / RCA
   document; otherwise summarize inline.
3. Report the panel verdicts honestly: show `confidence` (= kept / total votes)
   and the `kept`/`refuted` split so the user knows how strongly each hypothesis
   held up. Surface a notable dissenting `reason` from `votes` when useful.
4. Mention the `rejected` hypotheses briefly so the user sees what was ruled out
   and why — nothing was silently dropped.
5. If `surviving` is empty, tell the user no hypothesis survived adversarial
   testing after `rounds` round(s); suggest providing more evidence files via
   `--` or sharpening the problem description, and optionally list the `rejected`
   claims as leads that were considered but did not hold.

Delegate the orchestration to the harness — do not spawn your own investigator or
verifier agents.

(See src/SPEC.md for why the "disjoint evidence lanes" isolation is prompt-only rather than using worktree/deny isolation for these agents.)
