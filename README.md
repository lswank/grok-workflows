# grok-workflows

**Dynamic workflows for [Grok Code](https://x.ai) (the `grok` CLI).**

A small, dependency-free orchestration engine that lets you build multi-agent
*harnesses* on top of Grok's headless mode — fan-out, pipelines, tournaments,
adversarial verification, and loop-until-done — plus a library of ready-to-run
harnesses you can invoke from the command line or as Grok slash-commands.

It's the Grok analog of Claude Code's built-in dynamic workflows: instead of one
agent planning and executing in a single context window, you spawn many focused
Grok agents, each with its own fresh context, and coordinate them with plain
JavaScript.

---

## Why

When a single agent plans *and* executes a long, parallel, or adversarial task
in one context window, three failure modes creep in:

- **Agentic laziness** — it stops at 35 of 50 items and calls it done.
- **Self-preferential bias** — it rates its own output highly when asked to judge it.
- **Goal drift** — the original objective decays across compactions.

Giving each unit of work its own Grok process — its own context window, its own
goal — structurally defeats all three. A deterministic JS loop holds the
structure; the agents just do the focused work. That is what this engine
provides.

Every agent here is a real `grok -p … --output-format json --yolo` child
process. Nothing about the orchestration is magic — it's `child_process` + a
concurrency limiter + the patterns from the
[Claude Code dynamic-workflows playbook](https://www.anthropic.com/news), ported
to Grok's CLI.

---

## Requirements

- **Node ≥ 18** (uses only `node:*` built-ins; zero npm dependencies).
- **The `grok` CLI** on your `PATH` and authenticated (`grok login`, or set
  `XAI_API_KEY`). See Grok's headless-mode docs.
  - Point at a specific binary with `GROK_BIN=/path/to/grok` if it's not on `PATH`.

You do **not** need an API key to develop or test the orchestration logic — see
[Testing without spending credits](#testing-without-spending-credits).

---

## Quick start

```bash
git clone https://github.com/lswank/grok-workflows
cd grok-workflows

# list the bundled harnesses
node src/cli.mjs list

# run one
node workflows/deep-research.mjs "Did Postgres add MERGE in v15 or v16?"
node workflows/sort-tournament.mjs "severity :: login broken | typo in footer | data loss on save"
node workflows/triage.mjs ./incidents.txt
```

Each harness prints a JSON result to **stdout**; progress narration goes to
**stderr** (silence it with `GROK_WORKFLOWS_QUIET=1`).

---

## The bundled harnesses

| Harness | What it does | Core pattern |
|---|---|---|
| **deep-research** | Fan out web searches, fetch sources, adversarially verify each claim, synthesize a cited report. | fan-out + verify |
| **deep-verify** | Extract every factual/technical claim from a doc and verify each against the codebase and/or web. | fan-out + adversarial verify |
| **sort-tournament** | Rank a list by a qualitative criterion via pairwise comparison (beats absolute scoring). | tournament |
| **root-cause** | Generate competing hypotheses from *disjoint* evidence, test each against a panel until one survives. | multi-hypothesis + loop-until-done |
| **triage** | Classify each backlog item, dedupe against what's tracked, route to fix or escalation (with quarantine). | classify-and-act |
| **migrate** | Discover change sites, fix each in an isolated worktree, adversarially review, report. | fan-out + worktree isolation |
| **rule-mine** | Mine recurring corrections from past sessions/reviews, cluster, verify, distill into `AGENTS.md` rules. | generate-and-filter |
| **brainstorm-tournament** | Brainstorm many options (names, designs), run a rubric-scored tournament, return the top 3. | generate + tournament |
| **eval-skill** | Run a task N ways in isolated worktrees, grade against a rubric, pick and explain the best. | best-of-N + grading |

Run any of them with `node workflows/<name>.mjs "<input>"`, or
`node src/cli.mjs <name> "<input>"`.

---

## Using them inside Grok (install as a plugin)

grok-workflows ships as a **grok plugin** — one user-scoped install that exposes
every harness as a slash command in *every* Grok session, in any directory (git
repo or not). No per-repo setup, no `<repo>` placeholder to edit, no `PATH`
changes.

Install it once with `grok plugin install` — from GitHub, or from a local clone:

```bash
# from GitHub (shorthand, full URL, or user/repo@ref all work)
grok plugin install lswank/grok-workflows --trust

# …or from a local checkout
git clone https://github.com/lswank/grok-workflows && cd grok-workflows
grok plugin install . --trust

grok inspect            # confirm the skills are discovered
```

Then, inside Grok — from anywhere. Either name a harness directly:

```
/deep-research Did Postgres add MERGE in v15 or v16?
/triage ./incidents.txt
/root-cause why did checkout conversion drop 12% last week
```

…or use the umbrella **`/workflow`** entry (also triggered by saying `ultracode`)
and let it route your task to the right harness:

```
/workflow rank these incidents by severity: login broken | footer typo | data loss
ultracode research whether Postgres added MERGE in v15 or v16
```

`/workflow` picks the best-fit harness and hands off to it. Whichever way you
enter, the chosen harness spawns real headless `grok -p` subprocesses on your
account (one per parallel unit of work) — that's the engine doing its fan-out.
Prefix any invocation's environment with `GROK_WORKFLOWS_MOCK=1` for a free,
deterministic dry run.

**How invocation works (no path anywhere):** each skill bundles a tiny
self-locating launcher at `skills/<name>/scripts/run.mjs`. Grok announces the
skill's absolute path in its system context; the skill tells the model to run that
launcher, and the launcher finds its sibling harness from its *own* on-disk
location (`import.meta.url`) — not from the working directory — so it works in any
cwd and even through symlinks. Nothing is tied to where you cloned anything.

> **A note on git:** the launcher and most harnesses run anywhere. Two harnesses —
> `migrate` and `eval-skill` — use git-worktree isolation and therefore need the
> *target* workspace to be a git repo (that's inherent to what they do, not how
> they're invoked). The other seven run in any directory.

Manage the plugin with `grok plugin list`, `grok plugin update grok-workflows`,
and `grok plugin uninstall grok-workflows`. Pair the repeatable ones with Grok's
`/loop` to run them continuously (e.g. `/loop 1h /triage ./incidents.txt`).

---

## Writing your own harness

The engine is the whole API. Import it and compose:

```js
import { agent, parallel, pipeline, log, adversarialVerify } from '../src/engine.mjs'

// agent(): one Grok headless process. Returns text, or a validated object if
// you pass a JSON Schema. Returns null if it fails after retries.
const plan = await agent('Break this question into 5 search queries.', {
  schema: { type: 'object', required: ['queries'], properties: { queries: { type: 'array' } } },
})

// pipeline(): each item flows through all stages independently (no barrier).
const results = await pipeline(
  plan.queries,
  (q) => agent(`Search and summarize: ${q}`, { disableWebSearch: false }),
  (summary, q) => agent(`Extract verifiable claims from: ${summary}`, { schema: claimsSchema }),
)

// parallel(): a barrier — use only when a stage truly needs all prior results.
const verdicts = await parallel(claims.map((c) => () => adversarialVerify(c.text)))
```

### The primitives

| Function | Shape | Use it for |
|---|---|---|
| `agent(prompt, opts?)` | → `string \| object \| null` | one Grok agent; pass `schema` for structured output |
| `parallel(thunks)` | barrier → `(T\|null)[]` | when you need *all* results together |
| `pipeline(items, ...stages)` | no barrier → `(any\|null)[]` | **the default** for multi-stage work |
| `adversarialVerify(claim, opts?)` | → `{survives, refuted, kept, votes}` | kill plausible-but-wrong findings |
| `fanOutSynthesize(items, worker, synth)` | → `result` | map-then-merge |
| `classifyAndRoute(input, routes, opts?)` | → `{label, result}` | route by type / model |
| `generateAndFilter(gen, keep, opts?)` | → `kept[]` | ideas → dedupe → verify |
| `loopUntilDone(roundFn, opts?)` | → `items[]` | unknown-size discovery |
| `tournament(items, comparator)` | → `{winner, rounds}` | pick the best by pairwise comparison |

`agent()` options include `model`, `effort`, `schema`, `isolation:'worktree'`,
`tools` / `disallowedTools` (e.g. `['Agent']` to block sub-spawning,
`['run_terminal_cmd']` to quarantine untrusted-content agents), `maxTurns`,
`rules`, `allow` / `deny`, `disableWebSearch`, `strictSchema` (enforce the full
schema — nested types, enums, array items — instead of just top-level keys), and
more. See
[`src/SPEC.md`](./src/SPEC.md) for the full authoring contract, and
[`src/engine.mjs`](./src/engine.mjs) for the JSDoc on every function.

A workflow file exports `meta` and `run(input, ctx)` and ends with a small CLI
tail so it runs standalone — copy any file in [`workflows/`](./workflows) as a
template.

---

## Configuration

All via environment variables (or mutate the exported `config` object):

| Variable | Default | Effect |
|---|---|---|
| `GROK_BIN` | `grok` | path to the grok binary |
| `GROK_WORKFLOWS_MODEL` | (grok default) | default model for agents that don't set one |
| `GROK_WORKFLOWS_CONCURRENCY` | `min(8, cores−2)` | max agents running at once |
| `GROK_WORKFLOWS_RETRIES` | `2` | per-agent retries on failure / bad JSON |
| `GROK_WORKFLOWS_TIMEOUT_MS` | `0` (off) | per-agent timeout |
| `GROK_WORKFLOWS_MAX_AGENTS` | `1000` | runaway-loop backstop |
| `GROK_WORKFLOWS_QUIET` | unset | `1` silences progress narration |
| `GROK_WORKFLOWS_MOCK` | unset | `1` stubs every agent (no grok spawned) |

---

## Testing without spending credits

Set `GROK_WORKFLOWS_MOCK=1` and `agent()` returns a deterministic stand-in
instead of spawning grok — so you can exercise all the orchestration logic for
free. The test suite runs entirely in this mode:

```bash
npm test          # 17 engine tests, no grok required
```

For richer harness tests, assign `config.mock` to a task-aware function that
returns correctly-shaped JSON for each schema your harness uses.

---

## How it maps to Grok's CLI

| This engine | Grok CLI |
|---|---|
| `agent(prompt, {schema})` | `grok -p <prompt> --output-format json --yolo` + JSON parse |
| `opts.model` / `opts.effort` | `-m` / `--effort` |
| `opts.isolation:'worktree'` | `--worktree` |
| `opts.tools` / `opts.disallowedTools` | `--tools` / `--disallowed-tools` |
| `opts.allow` / `opts.deny` | `--allow` / `--deny` |
| `opts.sessionId` | `-s` (named session reuse) |

`agent()` reads only **stdout** (the single JSON object Grok emits with
`--output-format json`); Grok's diagnostic logging goes to stderr and is ignored.

---

## License

MIT © Lorenzo Swank
