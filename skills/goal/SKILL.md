---
name: goal
description: >
  Wrap any task or sub-workflow with a hard, verifiable completion criterion. Repeats the
  inner work (delegating to other harnesses when named) until a dedicated checker agent
  confirms the criterion is fully met. Use when the user says "/goal", "keep going until",
  "do not stop until the following is true", or wants a hard stop condition instead of a
  fixed number of passes. Composes with /loop.
metadata:
  short-description: "Loop a workflow or task until a checker confirms a hard criterion is met"
---

# /goal — hard completion requirement for workflows and tasks

Runs the bundled grok-workflows goal harness. It repeatedly executes the inner task
(or delegates to another named harness such as deep-research / triage / migrate) and
has an independent checker agent evaluate the output against your explicit criterion.
Stops only when the checker says "met" (or max rounds / dry streak). This structurally
prevents agentic laziness and goal drift on "when is it actually done?" questions.

## Usage
`/goal <criterion> :: <inner-workflow-or-task>`

Examples:
```
/goal the report cites >= 5 distinct sources and every claim survived adversarial verification :: deep-research Node.js permission model changes v20 to v22
/goal the migration touched every callsite and an adversarial reviewer approved with zero issues :: migrate rename the User model to Account across the whole repo
/goal all extracted claims have high-quality primary sources and no contradictions remain :: deep-verify ./docs/architecture.md
```

## How it runs

This skill bundles an entrypoint at `<skill-dir>/scripts/run.mjs` (thin delegator to the
centralized launcher in `src/launcher.mjs`). Grok announces the absolute skill path; the
launcher locates the harness from its own on-disk location.

The harness returns a JSON object:
```json
{
  "criterion": "the report ...",
  "task": "deep-research ...",
  "met": true,
  "rounds": 3,
  "finalResult": { ... the last inner result ... },
  "attempts": [ { "attempt": 2, "result": {...}, "check": { "met": true, "reason": "..." } } ]
}
```

## What to do with the result

1. If `met` is true, present `finalResult` (or the inner harness's primary artifact) as the answer.
2. Surface the number of rounds and the final checker's `reason` — this is the evidence that the hard requirement was satisfied.
3. If `met` is false after max rounds, tell the user the criterion was not achieved and surface the last checker's suggestions (if any) for how to adjust scope or the criterion.
4. You do **not** re-implement the loop/checker logic — invoke the harness and act on its JSON.

The checker is intentionally a separate agent from the workers (defeats self-preferential bias). The inner delegation lets you say "keep doing /triage on the queue until the queue is empty per the goal".
