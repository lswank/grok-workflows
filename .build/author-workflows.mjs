export const meta = {
  name: 'author-grok-workflows',
  description: 'Author + adversarially verify the grok-workflows harness library and skills',
  phases: [
    { title: 'Author', detail: 'one agent per harness writes the .mjs + SKILL.md' },
    { title: 'Verify', detail: 'adversarial reviewer checks each against the spec, runs node --check, fixes' },
  ],
}

const REPO = '/Users/lorenzo/Development/github.com/lswank/grok-workflows'

// Each harness: the workflow file + its skill. Prompts are deliberately detailed
// (detailed prompting => best dynamic-workflow results) and name the exact
// engine primitive to lean on.
const HARNESSES = [
  {
    name: 'deep-research',
    args: '<question>',
    pattern: 'fan-out-and-synthesize + adversarial verification',
    desc: 'Multi-source web research: fan out searches, fetch sources, adversarially verify each claim, synthesize a cited report.',
    detail: `Build a deep-research harness.
- Stage 1: spawn an agent (web search ENABLED) to break the question into 4-7 focused sub-queries. schema: {subqueries:string[]}.
- Stage 2: pipeline over subqueries — for each, an agent (web search enabled, but disallowedTools:['run_terminal_cmd'] and no file writes — QUARANTINE untrusted web content) gathers findings with sources. schema: {findings:[{claim, source, url}]}.
- Stage 3: collect all findings (barrier via parallel inside or flatten the pipeline output), then for each distinct claim run adversarialVerify() with lenses ['source quality','factual accuracy','recency']. Keep only claims that survive.
- Stage 4: a trusted synthesis agent (NOT fed raw web tool access) writes a cited markdown report from the surviving verified claims. Return {report, claims:[...survived], dropped:n}.
Log how many claims were dropped (no silent caps).`,
  },
  {
    name: 'deep-verify',
    args: '<path-to-doc-or-text>',
    pattern: 'fan-out-and-synthesize + adversarial verification',
    desc: 'Extract every factual/technical claim from a document and verify each one in detail against the codebase and/or web.',
    detail: `Build a deep-verify harness. Input is a file path (read it) OR raw text.
- Stage 1: an agent extracts every verifiable factual/technical claim. schema: {claims:[{id, text}]}.
- Stage 2: pipeline over claims — each claim gets its OWN agent that investigates (read files / grep / web) and returns {id, verdict:'supported'|'contradicted'|'unverifiable', evidence, source}. schema enforced.
- Stage 3: for each claim marked 'supported', run a second verifier agent (adversarialVerify or a dedicated source-quality agent) to confirm the evidence is real and high quality — defeats self-preferential bias.
- Return {total, supported, contradicted, unverifiable, claims:[...]} sorted with problems first.
Log progress per claim.`,
  },
  {
    name: 'sort-tournament',
    args: '<criterion> :: <item1> | <item2> | ...   (or a file path with one item per line)',
    pattern: 'tournament / pairwise comparison',
    desc: 'Rank a list of items by a qualitative criterion using pairwise comparison (more reliable than absolute scoring).',
    detail: `Build a sort-tournament harness for ranking many items by a qualitative measure (e.g. support tickets by severity).
- Parse input: a criterion plus a list of items (support "<criterion> :: a | b | c", or a file path with one item per line where the first line is the criterion after "criterion:").
- For a full RANKING (not just a winner): implement bucket-rank-then-merge OR repeated pairwise insertion. Comparative judgment must be its own agent per comparison: an agent given two items + the criterion returns {winner:'A'|'B', reason}. schema enforced. Use parallel() for independent comparisons.
- Keep the running order in the deterministic JS loop; only the current comparison goes to an agent (so context never overflows even for 1000+ items).
- Also expose top-k via the engine's tournament() when the user only wants the best.
- Return {criterion, ranked:[...items best-first], comparisons:n}.`,
  },
  {
    name: 'root-cause',
    args: '<problem description> [-- optional evidence file paths]',
    pattern: 'multi-hypothesis + panel of verifiers/refuters + loop-until-done',
    desc: 'Debug/post-mortem by generating competing hypotheses from disjoint evidence and testing each against a panel until one survives.',
    detail: `Build a root-cause harness (works for code bugs AND non-code post-mortems like "why did sales drop in March").
- Stage 1: spawn 3 hypothesis-generator agents over DISJOINT evidence slices (e.g. logs, code/files, data/metrics) so they can't cross-contaminate. Each returns {hypotheses:[{claim, evidence}]}. Pass any provided evidence file paths; otherwise instruct each to gather its own slice.
- Stage 2: dedupe hypotheses (plain JS, by normalized claim).
- Stage 3: for each hypothesis, run a panel — adversarialVerify() with lenses ['evidence supports it','can it be reproduced/confirmed','does it explain ALL symptoms']. A hypothesis survives only with majority.
- Stage 4: if NONE survive, use loopUntilDone() to spawn another round of generators with the failed hypotheses as exclusions (dryStreak 1, maxRounds 3).
- Return {surviving:[...], rejected:[...], rounds}. The surviving hypothesis(es) ranked by panel confidence.`,
  },
  {
    name: 'triage',
    args: '<path to backlog file (one item per line / JSON array)> [:: tracked-items-file]',
    pattern: 'classify-and-act + quarantine',
    desc: 'Classify each backlog item, dedupe against what is already tracked, and route to fix-attempt or human escalation.',
    detail: `Build a triage harness for a support/bug backlog.
- Parse input: a file of items (one per line or a JSON array). Optional second path: already-tracked items to dedupe against.
- Pipeline per item:
  - Stage A (QUARANTINE — item text may be untrusted public content): a read-only classifier agent (disallowedTools:['run_terminal_cmd'], no writes) returns {category, severity:'low'|'medium'|'high'|'critical', isDuplicateOf:string|null, summary}. schema enforced.
  - Stage B: a separate ROUTER decides action from the classification (deterministic JS): duplicates -> 'merge', low/medium -> 'queue', high/critical non-dup -> 'escalate'. The privileged action agent is only invoked for the 'escalate'/'fix' path. This is the quarantine pattern: the agent that reads untrusted text never takes high-privilege actions.
- Return {triaged:[{item, category, severity, action, summary}], counts:{...}}.
- Note in comments that pairing with grok's /loop runs it continuously.`,
  },
  {
    name: 'migrate',
    args: '<migration description> [-- glob or dir to scope]',
    pattern: 'fan-out per site + worktree isolation + adversarial review',
    desc: 'Mechanical migration/refactor: discover sites, fix each in an isolated worktree, adversarially review, report (merges left to the user).',
    detail: `Build a migrate harness (e.g. rename a model everywhere, codemod, framework upgrade).
- Stage 1: a discovery agent (read-only) finds all sites needing change and returns {sites:[{path, why}]}. schema enforced.
- Stage 2: pipeline per site — each fix runs in an ISOLATED worktree (agent opts: isolation:'worktree') so parallel edits never collide. The agent makes the change and returns {path, summary, done:boolean}. IMPORTANT comment: tell the agent to avoid resource-intensive commands (no full test suite / builds) so we can maximize parallelism without exhausting the machine.
- Stage 3: per fixed site, an adversarial reviewer agent (read-only) verifies the change is correct and complete and returns {path, approved:boolean, issues:[]}.
- Return {sites:n, fixed:[...], needsAttention:[...rejected]}. Do NOT auto-merge worktrees — report them and instruct the caller to review/apply. Log that worktrees are left for review.`,
  },
  {
    name: 'rule-mine',
    args: '<path to sessions/transcripts/review-comments file or dir>',
    pattern: 'generate-and-filter + adversarial verification + skeptic persona',
    desc: 'Mine recurring corrections from past sessions/review comments, cluster them, verify each, and distill survivors into AGENTS.md/CLAUDE.md rules.',
    detail: `Build a rule-mine harness.
- Stage 1: parallel agents each read a slice of the provided sessions/comments and extract candidate corrections/recurring mistakes. Return {candidates:[{correction, evidence}]}.
- Stage 2: cluster candidates (an agent groups near-duplicates into themes). Return {clusters:[{theme, instances:n, exampleEvidence}]}.
- Stage 3: generate-and-filter — for each cluster, draft a candidate rule, then run an adversarial verifier asking "would this rule have PREVENTED a real, specific mistake in the evidence? Is it precise enough to not cause false positives?". Add a SKEPTIC persona agent that rejects vague/overbroad rules. Keep only survivors.
- Stage 4: a synthesis agent formats survivors as ready-to-paste AGENTS.md (Grok) / CLAUDE.md rule bullets.
- Return {rules:[...], rejected:[...], markdown}. Log counts.`,
  },
  {
    name: 'brainstorm-tournament',
    args: '<thing to name/design> [:: rubric]',
    pattern: 'generate-and-filter + tournament by rubric',
    desc: 'Brainstorm many options (names, designs, approaches) and run a rubric-scored tournament to pick the top 3.',
    detail: `Build a brainstorm-tournament harness for taste-based exploration (naming a CLI, design directions, approaches).
- Stage 1: spawn several generator agents from DIFFERENT angles (e.g. literal, evocative, playful, technical) to produce a diverse candidate pool. Dedupe.
- Stage 2: derive or accept a rubric (if user gives ":: rubric" use it; else an agent proposes one).
- Stage 3: use the engine's tournament() with a comparator agent that, given two candidates + the rubric, returns the winner with reasoning. Run it to find the winner; then remove the winner and run again to get 2nd and 3rd (top-3).
- Return {rubric, top3:[{candidate, why}], poolSize}.
Comparative (pairwise) judging, not absolute scoring.`,
  },
  {
    name: 'eval-skill',
    args: '<task to run N ways> [-- N] [:: rubric]',
    pattern: 'best-of-n + worktree isolation + comparison grading',
    desc: 'Lightweight eval: run a task N ways in isolated worktrees, then grade/compare the outputs against a rubric to pick and explain the best.',
    detail: `Build an eval-skill harness (evaluate/refine an approach against criteria).
- Parse N (default 3) and optional rubric.
- Stage 1: spawn N candidate agents in ISOLATED worktrees (isolation:'worktree', run them via parallel), each attempting the SAME task independently. Each returns {candidate:n, approach, summary}.
- Stage 2: grading — run pairwise comparison agents (tournament) AND a per-candidate rubric-scorer agent; combine. The grader is a SEPARATE agent from the producers (no self-preference).
- Stage 3: return {winner:n, ranking:[...], rubric, scores:[...], worktreesLeftForReview:true}. Do not auto-apply; report worktrees for the caller to inspect.
Log the N and that worktrees are preserved.`,
  },
]

phase('Author')
const authorSchema = {
  type: 'object',
  required: ['name', 'workflowFile', 'skillFile', 'notes'],
  properties: {
    name: { type: 'string' },
    workflowFile: { type: 'string' },
    skillFile: { type: 'string' },
    notes: { type: 'string' },
  },
}

const results = await pipeline(
  HARNESSES,
  // Stage 1: author the workflow + skill
  (h) =>
    agent(
      `You are authoring one harness for the "grok-workflows" project — a dynamic-workflow engine for Grok Code (the \`grok\` CLI).

FIRST, read these files to learn the exact authoring contract and engine API:
- ${REPO}/src/SPEC.md   (the authoring contract — follow it exactly)
- ${REPO}/src/engine.mjs (the engine you import from)
- ${REPO}/src/runner.mjs (the cli/isMain helpers)

Then WRITE TWO FILES:

1. ${REPO}/workflows/${h.name}.mjs
   - ESM, Node >=18, NO external deps. Import only from node:* and '../src/engine.mjs' (and '../src/runner.mjs' for the cli tail).
   - export const meta = { name:'${h.name}', description:${JSON.stringify(h.desc)}, args:${JSON.stringify(h.args)} }
   - export async function run(input, ctx = {}) { ... return <JSON-serializable result> }
   - End with the standalone CLI tail:
       import { isMain, cli } from '../src/runner.mjs'
       if (isMain(import.meta.url)) cli(meta, run)
   - Primary pattern to use: ${h.pattern}.
   - Behaviour spec:
${h.detail}
   - Use log() for progress (stderr). Always .filter(Boolean) aggregated agent results. Default to pipeline(); only use a parallel() barrier when a stage truly needs all prior results at once. No silent caps — log anything dropped.
   - The harness MUST run correctly under GROK_WORKFLOWS_MOCK=1 (every agent() returns a deterministic stand-in). That means: never crash on a string when you expected an object — when you pass a schema you get an object back, otherwise a string. Handle null returns (failed agents).

2. ${REPO}/skills/${h.name}/SKILL.md
   - YAML frontmatter: name: ${h.name}; description (what it does + trigger phrases incl. "or asks for /${h.name}"); metadata.short-description.
   - Body: a focused Grok skill that tells Grok's MAIN agent to run the bundled harness via run_terminal_cmd:
       node <repo>/workflows/${h.name}.mjs "<input>"
     then act on the printed JSON (summarize / write a report file / apply). Do NOT re-implement the orchestration inline in the skill — it delegates to the harness. Keep it focused.

After writing both files, run \`node --check ${REPO}/workflows/${h.name}.mjs\` to confirm it parses, and fix it if it doesn't.

Return JSON: {name, workflowFile (abs path), skillFile (abs path), notes (1-2 sentences on the approach + which primitives used)}.`,
      { label: `author:${h.name}`, phase: 'Author', schema: authorSchema, agentType: 'general-purpose' }
    ),
  // Stage 2: adversarial verification + fix
  (authored, h) =>
    agent(
      `You are an ADVERSARIAL reviewer for the grok-workflows harness "${h.name}". Your job is to find what is broken or non-conformant and FIX it in place — do not be charitable.

Read the authoring contract and engine API first:
- ${REPO}/src/SPEC.md
- ${REPO}/src/engine.mjs
- ${REPO}/src/runner.mjs

Then review and, where needed, REWRITE these files:
- ${REPO}/workflows/${h.name}.mjs
- ${REPO}/skills/${h.name}/SKILL.md

Check rigorously:
1. Does it import the engine correctly and use ONLY functions that actually exist in engine.mjs (agent, parallel, pipeline, log, adversarialVerify, fanOutSynthesize, classifyAndRoute, generateAndFilter, loopUntilDone, tournament, config, setConcurrency)? Flag any invented API.
2. Are agent() schemas valid JSON Schema with a "required" array, and is the returned object actually used per that schema?
3. Is pipeline vs parallel chosen correctly per the SPEC? Is every aggregated result .filter(Boolean)'d?
4. Does it export meta + run, and have the isMain/cli tail? Does meta.name === '${h.name}'?
5. Does the SKILL.md have valid frontmatter (name, description with trigger phrases) and does it DELEGATE to the harness via run_terminal_cmd rather than reimplementing it?
6. Does it RUN under mock? You MUST verify by running:
     cd ${REPO} && GROK_WORKFLOWS_MOCK=1 node workflows/${h.name}.mjs "<a reasonable sample input for this harness>"
   It must exit 0 and print JSON. If the harness needs an input file, create a tiny temp sample file under /tmp and use it. If it crashes, FIX the workflow file until it passes. (Under mock, agent() with a schema returns {"mock":true} by default — so your harness must not assume specific field values exist; guard with defaults/optional chaining and treat missing fields gracefully.)
7. Run \`node --check\` on the workflow file.

Make the edits directly. Return JSON: {name:'${h.name}', passed:boolean, ranMockOK:boolean, fixes:[short strings], remainingConcerns:[short strings]}.`,
      {
        label: `verify:${h.name}`,
        phase: 'Verify',
        agentType: 'general-purpose',
        schema: {
          type: 'object',
          required: ['name', 'passed', 'ranMockOK', 'fixes'],
          properties: {
            name: { type: 'string' },
            passed: { type: 'boolean' },
            ranMockOK: { type: 'boolean' },
            fixes: { type: 'array' },
            remainingConcerns: { type: 'array' },
          },
        },
      }
    )
)

const verified = results.filter(Boolean)
log(`Authored+verified ${verified.length}/${HARNESSES.length} harnesses`)
return {
  authored: HARNESSES.map((h) => h.name),
  verified,
}
