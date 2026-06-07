export const meta = {
  name: 'verify-remaining-grok-workflows',
  description: 'Adversarially verify the 6 rate-limited harnesses and create their missing skills',
  phases: [{ title: 'VerifyAndSkill' }],
}

const REPO = '/Users/lorenzo/Development/github.com/lswank/grok-workflows'

// name -> a realistic sample input for the mock run
const REMAINING = [
  { name: 'deep-verify', sample: '/tmp/gw_doc.txt', kind: 'reads a file or raw text of claims' },
  { name: 'root-cause', sample: 'Why did the nightly test suite start failing after the deploy?', kind: 'problem description' },
  { name: 'triage', sample: '/tmp/gw_backlog.txt', kind: 'reads a backlog file (one item per line)' },
  { name: 'migrate', sample: 'rename the User model to Account everywhere -- src/', kind: 'migration description + scope' },
  { name: 'brainstorm-tournament', sample: 'a name for a CLI todo tool :: short and memorable', kind: 'thing to name :: rubric' },
  { name: 'eval-skill', sample: 'implement a fizzbuzz function -- 3', kind: 'task -- N :: rubric' },
]

phase('VerifyAndSkill')

const schema = {
  type: 'object',
  required: ['name', 'passed', 'ranMockOK', 'skillCreated', 'fixes'],
  properties: {
    name: { type: 'string' },
    passed: { type: 'boolean' },
    ranMockOK: { type: 'boolean' },
    skillCreated: { type: 'boolean' },
    fixes: { type: 'array' },
    remainingConcerns: { type: 'array' },
  },
}

const results = await parallel(
  REMAINING.map((h) => () =>
    agent(
      `You are an ADVERSARIAL reviewer + finisher for the grok-workflows harness "${h.name}". It was authored but never verified and has NO skill yet. Be rigorous and uncharitable; FIX problems in place.

Read the contract and engine API FIRST:
- ${REPO}/src/SPEC.md
- ${REPO}/src/engine.mjs
- ${REPO}/src/runner.mjs

Then review (and rewrite as needed):
- ${REPO}/workflows/${h.name}.mjs

Checks:
1. Imports only real engine exports (agent, parallel, pipeline, log, adversarialVerify, fanOutSynthesize, classifyAndRoute, generateAndFilter, loopUntilDone, tournament, config, setConcurrency). Flag/fix any invented API.
2. agent() schemas are valid JSON Schema with a "required" array; returned objects are used accordingly; results are .filter(Boolean)'d; pipeline vs parallel chosen per SPEC.
3. exports meta + run; has the isMain/cli tail; meta.name === '${h.name}'.
4. Guards against null agent results and against the default mock (schema calls may return {mock:true} which the engine rejects -> null): the harness must degrade gracefully, never throw.

CRITICAL — verify the REAL logic with a TASK-AWARE mock (not just graceful degradation). Create a tiny driver under /tmp that imports the engine, sets config.mock to a function returning correctly-SHAPED JSON for each schema this harness uses (inspect the workflow to see the schemas), imports { run } from the workflow, and calls run() on this sample input: ${JSON.stringify(h.sample)} (${h.kind}). Confirm the returned object is fully populated (stages 2..N actually ran and produced data), exits cleanly, and matches the harness's documented return shape. Example skeleton:

  // /tmp/drive_${h.name}.mjs
  import { config } from '${REPO}/src/engine.mjs'
  config.mock = async (prompt) => { /* return JSON string shaped for whichever schema the prompt asks for */ }
  const { run } = await import('${REPO}/workflows/${h.name}.mjs')
  console.log(JSON.stringify(await run(${JSON.stringify(h.sample)}, {cwd:'/tmp'}), null, 2))

Run: \`node /tmp/drive_${h.name}.mjs\`. If results are empty/under-populated because your mock shapes are wrong, fix the mock; if they're empty because the HARNESS is buggy, fix the harness. Iterate until the populated result proves the full pipeline works. Also run \`node --check ${REPO}/workflows/${h.name}.mjs\`.

Then CREATE THE SKILL:
- ${REPO}/skills/${h.name}/SKILL.md
- YAML frontmatter: name: ${h.name}; description (what it does + trigger phrases incl. "or asks for /${h.name}"); metadata.short-description.
- Body: a focused Grok skill telling Grok's MAIN agent to run the bundled harness via run_terminal_cmd ("node <repo>/workflows/${h.name}.mjs \\"<input>\\"") and then act on the printed JSON (summarize / write a report / apply). It must DELEGATE to the harness, not reimplement orchestration. Match the style of the existing ${REPO}/skills/deep-research/SKILL.md (read it for reference).

Return JSON: {name:'${h.name}', passed, ranMockOK, skillCreated, fixes:[...], remainingConcerns:[...]}.`,
      { label: `verify+skill:${h.name}`, phase: 'VerifyAndSkill', schema, agentType: 'general-purpose' }
    )
  )
)

return { results: results.filter(Boolean) }
