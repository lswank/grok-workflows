# grok-workflows engine spec (authoring contract)

This is the contract every workflow file in `workflows/` and every `SKILL.md` in
`skills/` must follow. Read it fully before writing a harness.

## What this is

`grok-workflows` is a dynamic-workflow engine for **Grok Code** (the `grok`
CLI), modeled on Claude Code's built-in Workflow tool. The atomic unit is a
**Grok headless agent**: a child `grok -p … --output-format json --yolo`
process with its own fresh context window. The engine (`src/engine.mjs`) wraps
that process as `agent()` and provides orchestration combinators on top.

Each agent is a separate OS process → separate context window. That is what
structurally defeats the three failure modes the Claude Code team documents:
**agentic laziness** (stopping at 35/50 items), **self-preferential bias** (an
agent blessing its own output), and **goal drift** (losing the original
objective across compactions).

## The engine API (import from `../src/engine.mjs`)

```js
import {
  agent, parallel, pipeline, log,
  adversarialVerify, fanOutSynthesize, classifyAndRoute,
  generateAndFilter, loopUntilDone, tournament,
  config, setConcurrency,
} from '../src/engine.mjs'
```

### `agent(prompt, opts?) → Promise<string | object | null>`
Spawns one Grok headless agent.
- Without `opts.schema`: resolves to the agent's final text (string).
- With `opts.schema` (a JSON Schema): the agent is instructed to emit ONLY
  matching JSON; the engine parses + lightly validates and resolves to the
  **object**. Retries on parse failure (`config.retries`, default 2).
- Resolves to **`null`** if the agent fails after all retries. Always
  `.filter(Boolean)` aggregated results.

Key `opts`: `model`, `effort` (low|medium|high|xhigh|max), `schema`, `label`,
`isolation:'worktree'` (file-mutating agents that must not collide), `tools`
(allowlist), `disallowedTools` (e.g. `['Agent']` to block sub-spawning,
`['run_terminal_cmd']` to block shell), `maxTurns`, `rules` (guardrail string),
`cwd`, `noProjectRoot`, `sessionId`, `allow`, `deny`, `disableWebSearch`,
`strictSchema`.

**Schema validation is lightweight by default.** With `schema` set, the engine
only checks that the value is the right top-level kind and that top-level
`required` keys exist — it does NOT enforce nested types, `enum` values, or array
`items`. So a present-but-wrong field (a string where a number was declared, a
winner outside an enum, a missing nested key) passes through, and your workflow
must defend against it (coerce/guard). To make the engine enforce the full
schema instead, pass `strictSchema: true` per call (or set `config.strictSchema`
/ `GROK_WORKFLOWS_STRICT_SCHEMA=1` globally): a deep validator then checks nested
`type` (incl. unions like `["string","null"]` and `integer`), `enum` membership,
nested `required`, and `items`, and a mismatch is retried like any other
parse failure (ultimately `null`). Use it when a malformed field is better
retried than silently coerced; keep the lenient default when you'd rather coerce.

### `parallel(thunks) → Promise<(T|null)[]>`
**Barrier.** Runs all thunks concurrently (capped at `config.concurrency`),
awaits everything, returns results in order. Failures become `null` — never
rejects. Use only when you genuinely need all results together (dedup/merge,
early-exit on zero, cross-item comparison).

### `pipeline(items, ...stages) → Promise<(any|null)[]>`
**No barrier — the default for multi-stage work.** Each item flows through all
stages independently; item A can be in stage 3 while B is in stage 1. Each stage
is `(prev, originalItem, index) => Promise<any>`. A throwing stage drops that
item to `null` and skips its rest.

### Higher-order patterns
- `adversarialVerify(claim, {voters|lenses, prompt, agentOpts}) → {survives, refuted, kept, votes}`
  N skeptics each try to refute; majority decides.
- `fanOutSynthesize(items, worker, synthesize) → result`
  Worker per item (fresh context), then one synthesis agent (barrier).
- `classifyAndRoute(input, routes, {labels, agentOpts}) → {label, result, classification}`
  Classifier labels input → router picks handler. `routes.default` is the fallback.
- `generateAndFilter(generate, keep, {key, rounds}) → kept[]`
  Generate candidates → dedupe by `key` → keep those the verifier passes.
- `loopUntilDone(roundFn, {maxRounds, dryStreak}) → accItems[]`
  Repeat `roundFn(round, acc)` until it returns `{done:true}` or `dryStreak`
  rounds yield no new items. `roundFn` returns `{items:[…]}` or an array.
- `tournament(items, comparator) → {winner, rounds}`
  Single-elimination bracket; `comparator(a,b)` resolves to the winner.

## Authoring rules for `workflows/*.mjs`

1. **ESM, Node ≥ 18, no external deps.** `.mjs` extension. Import only from
   `node:*` and `../src/engine.mjs`.
2. **Export `meta` and `run`:**
   ```js
   export const meta = {
     name: 'deep-research',
     description: 'One-line summary.',
     args: '<question>',           // usage hint for the CLI
   }
   export async function run(input, ctx = {}) { /* … */ return result }
   ```
   `input` is the user's argument string. `ctx` may carry `{ cwd }`. `run` must
   return a JSON-serializable result (the CLI prints it).
3. **Make it runnable standalone too:** end the file with
   ```js
   import { isMain, cli } from '../src/runner.mjs'
   if (isMain(import.meta.url)) cli(meta, run)
   ```
   so `node workflows/deep-research.mjs "question"` works.
4. **Pick the right primitive.** Default to `pipeline()`. Reach for a `parallel()`
   barrier only when a stage truly needs all prior results at once.
5. **Always `.filter(Boolean)`** aggregated agent results before using them.
6. **Use `log()`** for progress (it writes to stderr; stdout stays clean for the
   final JSON result). Never `console.log` partial state to stdout.
7. **No silent caps.** If you bound coverage (top-N, sampling, no-retry),
   `log()` what was dropped.
8. **Constrain untrusted-content agents.** If an agent reads web/untrusted input,
   give it `disallowedTools:['run_terminal_cmd']` and no write tools (quarantine
   pattern); let a separate trusted agent take privileged actions.

## Authoring rules for `skills/<name>/SKILL.md`

Each workflow gets a sibling skill so it's invocable inside Grok as a slash
command. The skill ships inside the grok-workflows **plugin** and invokes its
harness through a bundled self-locating launcher — never a hardcoded path. Two
files per skill:

1. `skills/<name>/scripts/run.mjs` — the launcher. It is byte-identical across
   every skill: it derives the skill name from its own directory and spawns
   `<plugin-root>/workflows/<name>.mjs`, locating the plugin from its OWN path
   (`import.meta.url`), not from `cwd`. Copy it verbatim from any existing skill.
2. `skills/<name>/SKILL.md` — format (see Grok's skills doc):

```markdown
---
name: deep-research
description: <what it does + trigger phrases, e.g. "Use when … or asks for /deep-research">
metadata:
  short-description: "Deep multi-source research with cited report"
---

# /deep-research — <title>

<1–2 sentence overview.>

## Usage
`/deep-research <question>`

## How it runs
This skill bundles a self-locating launcher at `<skill-dir>/scripts/run.mjs`,
where `<skill-dir>` is this skill's own directory — its absolute path is announced
in your system context. Derive the launcher path from that announced SKILL.md path
and inline the absolute path into a single `run_terminal_cmd` call (don't rely on
cwd or a shell variable). The launcher finds its bundled harness itself:

\`\`\`bash
node <skill-dir>/scripts/run.mjs "<question>"
\`\`\`

…followed by what the agent should do with the result (summarize, write a file,
etc).
```

This `<skill-dir>` is NOT a placeholder the user edits — Grok announces every
skill's absolute path at load time (the same convention Grok's own bundled skills
use for their `scripts/` helpers), so the model resolves it at runtime. The skill
body should tell Grok's main agent to run the launcher and then act on the JSON it
prints — NOT to re-implement the orchestration inline. One skill per workflow.

The repo doubles as a grok plugin: `.claude-plugin/plugin.json` is the manifest,
and `skills/` + `workflows/` + `src/` all travel together when it's installed via
`grok plugin install`.

## Testing without burning xAI credits

Set `GROK_WORKFLOWS_MOCK=1` (or assign `config.mock`) to make every `agent()`
call return a deterministic stand-in instead of spawning grok. The test suite
relies on this. Workflows must therefore not depend on real grok output shape
beyond what `agent()` returns (string, or object matching the schema you pass).
