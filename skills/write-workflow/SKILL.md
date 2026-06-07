---
name: write-workflow
description: >
  Have Claude write a brand new reusable JavaScript orchestration script (a full dynamic workflow harness)
  tailored to the exact process you describe. The script is executed immediately for the current task and
  the full source is returned so you can save it (grok-workflows save <name> --script -) and re-run it later
  as a first-class command. This is the "Claude writes the script, you can rerun it" core of the dynamic
  workflows feature. Triggered by "write a workflow", "create a custom harness", "ultracode a new script for",
  or when /workflow decides no bundled harness is a perfect fit for a novel multi-agent process.
metadata:
  short-description: "Claude writes a complete saveable .mjs workflow script for your task and runs it now"
---

# /write-workflow — Claude writes a custom workflow script for you

This skill runs the bundled `write-workflow` harness. It asks a planner agent to design the right
shape (which engine primitives, verification steps, isolation, loop strategy, etc.), then a code
agent emits a complete, contract-following `workflows/<name>.mjs` file, executes it immediately
(so you get a result for the current ask), and returns the full source + execution result.

You can then persist it with the CLI `save` command (or ask the model to do the save for you).

## Usage
`/write-workflow <full description of the orchestration and quality process you want> [--save-as <name>]`

The description should be rich: the goal, the data, the verification steps, number of reviewers,
whether worktree isolation or quarantine is needed, stop conditions, etc.

Example:
```
/write-workflow a 4-reviewer adversarial design review for landing-page copy: 3 independent reviewers score against a rubric (clarity, conversion, brand, accessibility), a 4th lead synthesizes and picks a winner via tournament, then a goal checker confirms the chosen variant meets the bar. Input will be the original copy + brand guidelines. --save-as design-review-copy
```

After the run you will receive JSON containing:
- `script`: the full .mjs source (copy this to save)
- `result`: what the generated script produced when run on a derived version of your description
- `savedTo`: path if you used --save-as
- `howToRunSaved`

Once saved, the workflow appears in `grok-workflows list` and can be invoked as `grok-workflows <name> "actual input for a real run"`.

## How it runs

Self-locating launcher → harness. The harness itself uses the engine (planner + code writer + one execution of the emitted script). No user code is eval'ed in the orchestrator process; it is written to a temp file and imported.

The generated script follows the exact same authoring contract as every other harness in the plugin (see src/SPEC.md). It can be checked into a repo under .grok/workflows/ or kept personal.

## What to do with the result

1. Show the user the `result` of the immediate execution (that's the answer for today's task).
2. Offer the `script` for inspection / editing.
3. If they like it, run the save step (or the harness already did if --save-as was supplied).
4. Future invocations of the saved name will run the exact same orchestration — repeatable and auditable, exactly as the Claude Code dynamic workflows spec intends.

You never write the multi-agent logic yourself; you describe the desired harness and the tool produces + exercises it.
