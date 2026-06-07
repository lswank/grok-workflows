---
name: workflow
description: >
  Umbrella entry point for the grok-workflows multi-agent engine. Routes a task to
  the best-fit bundled harness, which spawns multiple headless grok subprocesses
  (real `grok -p` instances on your account, each its own fresh context) to defeat
  agentic laziness, self-preferential bias, and goal drift. Use when the user types
  "/workflow", says "ultracode", or asks to run a task as a multi-agent workflow,
  orchestrate it with parallel grok subagents/subprocesses, fan it out, or "run the
  grok-workflows engine".
when-to-use: >
  Triggers: "/workflow <task>", "ultracode <task>", "run this as a workflow", "use
  the grok-workflows engine", "spawn grok subagents for this", "fan this out",
  "multi-agent orchestrate this". Also use when a request clearly matches one of the
  bundled harnesses (deep research, ranking, root-cause, triage, migration, etc.)
  and the user wants it run as a real multi-agent job rather than answered inline.
metadata:
  short-description: "Route a task to the right grok-workflows harness (spawns real grok subprocesses)"
---

# /workflow — route a task to the right grok-workflows harness

grok-workflows is a multi-agent engine: each **harness** orchestrates many headless
**grok subprocesses** — real `grok -p … --output-format json --yolo` instances, each
with its own fresh context window — so long, parallel, or adversarial tasks don't
suffer agentic laziness, self-preferential bias, or goal drift. Those subprocesses
run on the user's own grok account and spend their credits.

This skill is the front door: it does NOT do the work itself. It picks the single
best-fit harness for the user's task and hands off to that harness's skill, which
bundles the launcher and the result-handling.

## Usage
`/workflow <your task>` — or just say `ultracode <your task>`.

## How to route

1. Read the user's task and pick the **single best-fit** harness from the table
   below. Match on intent, not keywords.
2. **Invoke that harness's skill** (e.g. `/deep-research …`). Reformat the user's
   task into that skill's documented input syntax (see its `## Usage`). Each harness
   skill self-locates and runs its bundled `workflows/<name>.mjs`, whose engine
   spawns the grok subprocesses.
3. Act on the JSON the chosen harness prints, exactly as that skill instructs.
4. If **nothing** fits cleanly, say so, show the user this table, and ask which they
   want — do not force a bad match.

| If the user wants to… | Harness | Hand off to |
|---|---|---|
| Research a topic / fact-check from the web, with a sourced report | **deep-research** | `/deep-research <question>` |
| Fact-check a document or its claims against the codebase/web | **deep-verify** | `/deep-verify <path-or-text>` |
| Rank / prioritize / sort a list by a fuzzy quality (severity, impact, fit, …) | **sort-tournament** | `/sort-tournament <criterion> :: a \| b \| c` |
| Brainstorm options (name / design / approach) and pick the top few | **brainstorm-tournament** | `/brainstorm-tournament <thing> [:: rubric]` |
| Debug / post-mortem — why did X break, fail, regress, or drop | **root-cause** | `/root-cause <problem> [-- evidence files]` |
| Classify, dedupe, and route a bug / support backlog | **triage** | `/triage <backlog-file> [:: tracked-file]` |
| Make a mechanical change across many files (rename, swap a lib, …) | **migrate** | `/migrate <change> [-- scope]` |
| Mine past sessions / reviews into AGENTS.md / CLAUDE.md rules | **rule-mine** | `/rule-mine <file-or-dir>` |
| Run a task N independent ways and grade to pick the best | **eval-skill** | `/eval-skill <task> [-- N] [:: rubric]` |

## Notes

- **It spends grok credits.** The chosen harness spawns one headless `grok -p` per
  parallel unit of work (each comparison, each verifier, each candidate). For a
  free, deterministic dry run, set `GROK_WORKFLOWS_MOCK=1` in the environment before
  invoking — every grok subprocess is then replaced by a stand-in.
- **Direct-launcher fallback.** If you cannot invoke the sibling skill for some
  reason, run its bundled launcher directly: it lives next to this skill at
  `<dirname of this SKILL.md>/../<harness>/scripts/run.mjs` (derive the absolute path
  from this skill's announced location, the same way Grok's bundled skills reference
  their `scripts/` helpers), and takes the same input string as the `/<harness>`
  command.
- Keep your own output focused on relaying and acting on the harness's result — the
  harness already did the orchestration.
