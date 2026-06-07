// write-workflow — the "have Claude write a workflow" / "ultracode" experience.
// Given a task description (e.g. "audit every API for missing auth with 3 reviewers then a lead"),
// it produces a complete, reusable, saveable .mjs orchestration script that uses the engine
// primitives, immediately executes a version of it for the described task (so you get a result now),
// and returns the full script source so it can be saved via `grok-workflows save <name> --script -`
// (or the harness can auto-save when you append ` --save-as my-audit`).
//
// This is the faithful recreation + extension of Claude Code's "Claude writes the script for the
// task you describe, and a runtime executes it" + "save it as a command of your own".
//
// The generated script is parameterized on `input` (the per-invocation argument) and follows the
// same meta + run + cli tail contract as all bundled harnesses. It can be checked into
// .grok/workflows/ for the team or ~/.grok/workflows/ for personal use.

import {
  agent,
  log,
  coerceBoolean,
} from '../src/engine.mjs'
import { isMain, cli } from '../src/runner.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { loadWorkflowMap } from './_shared.mjs'

export const meta = {
  name: 'write-workflow',
  description:
    'Have Claude write a brand-new reusable JS orchestration script for your exact process, execute it immediately, and make it saveable as a first-class command. The dynamic "Claude writes the harness" part of the spec.',
  args: '<description of the desired workflow> [--save-as <name>]',
}

function parseWriteInput(input) {
  let s = String(input || '').trim()
  let saveAs = null
  const m = s.match(/\s+--save-as\s+([A-Za-z0-9._-]+)\s*$/)
  if (m) {
    saveAs = m[1]
    s = s.slice(0, m.index).trim()
  }
  if (!s) throw new Error('write-workflow needs a description of the orchestration you want')
  return { description: s, saveAs }
}

export async function run(input, ctx = {}) {
  const cwd = ctx.cwd || process.cwd()
  const { description, saveAs } = parseWriteInput(input)

  log(`write-workflow: planning orchestration for: ${description.slice(0, 80)}...`)

  // 1. Design the shape (which primitives, how many agents, verification, isolation, etc.).
  const design = await agent(
    `You are an expert at building dynamic multi-agent workflows using the grok-workflows engine.\n\n` +
      `User request: ${description}\n\n` +
      `Available primitives (import from '../src/engine.mjs' or 'grok-workflows/engine'):\n` +
      `- agent(prompt, {schema?, model?, effort?, isolation:'worktree', disallowedTools?, ...})\n` +
      `- parallel(thunks) — barrier for when you truly need all results together\n` +
      `- pipeline(items, ...stages) — the default; items flow independently through stages\n` +
      `- adversarialVerify(claim, {voters?, lenses?}) — N skeptics try to refute; majority wins\n` +
      `- fanOutSynthesize(items, worker, synthesize)\n` +
      `- classifyAndRoute(input, routes)\n` +
      `- generateAndFilter(generate, keep)\n` +
      `- loopUntilDone(roundFn, {maxRounds?, dryStreak?})\n` +
      `- tournament(items, comparator)\n` +
      `- log(msg), coerceBoolean(v)\n\n` +
      `Return a compact JSON design:\n` +
      `{\n  "name": "kebab-case-short-name",\n  "pattern": "one of: fan-out-and-synthesize | adversarial | tournament | loop-until | classify-and-act | generate-and-filter | custom-pipeline",\n  "phases": ["short", "phase", "list"],\n  "keyTechniques": ["adversarialVerify", "worktree isolation for mutating agents", "quarantine for untrusted input", ...],\n  "suggestedModelsOrEffort": "optional note",\n  "stopConditions": "how the script knows it is done"\n}`,
    {
      label: 'write-design',
      schema: {
        type: 'object',
        required: ['name', 'pattern', 'phases'],
        properties: {
          name: { type: 'string' },
          pattern: { type: 'string' },
          phases: { type: 'array', items: { type: 'string' } },
          keyTechniques: { type: 'array', items: { type: 'string' } },
          suggestedModelsOrEffort: { type: 'string' },
          stopConditions: { type: 'string' },
        },
      },
    }
  )

  const wfName = (design?.name || 'custom-workflow').replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  log(`write-workflow: design ready — ${wfName} (${design?.pattern || 'custom'})`)

  // 2. Code generation — emit a complete, standalone, saveable .mjs that follows the contract.
  // Use array + join to avoid any backtick-balancing issues with long prompts containing fence chars.
  const promptLines = [
    'Write a COMPLETE, runnable grok-workflows harness script (the full contents of a workflows/<name>.mjs file).',
    'Task the user wants automated: ' + description,
    'Design summary: ' + JSON.stringify(design || {}, null, 2),
    'Hard requirements for the emitted code:',
    '1. ESM .mjs, no external deps.',
    '2. Exactly: export const meta = { name: "' + wfName + '", description: "...", args: "<input>" }',
    '   export async function run(input, ctx = {}) { ... return result }',
    '3. At the bottom: import { isMain, cli } from "../src/runner.mjs"',
    '   if (isMain(import.meta.url)) cli(meta, run)',
    '4. Import ONLY from "../src/engine.mjs" (or "grok-workflows/engine" as fallback). Use the primitives listed above.',
    "5. The 'input' to run() is the per-invocation argument (a question, a path, a list, etc.). Do NOT hard-code the user's example task inside the script; parameterize on input.",
    '6. Use log() for progress. Return a useful JSON result object.',
    '7. Apply quality patterns from the spec: fresh contexts, adversarial verification where a finding is produced, quarantine for untrusted input, worktree for mutating steps, loopUntilDone for unknown size work.',
    '8. Include a short header comment explaining the pattern and why it defeats agentic laziness / bias / drift.',
    '9. Make the script robust to the usual schema foot-guns (use coerceBoolean for booleans, strictSchema where a control field drives flow).',
    '',
    'Output ONLY the raw JavaScript code (no code fences, no prose before or after). The code must be directly writable to disk and executable via node workflows/' + wfName + '.mjs "some input".'
  ]
  const codePrompt = promptLines.join('\n')

  const generatedCodeRaw = await agent(codePrompt, { label: 'write-code' })
  // Strip accidental fences if the model ignored "ONLY the code".
  let code = String(generatedCodeRaw || '').trim()
  code = code.replace(/^```(?:js|javascript)?\s*/i, '').replace(/```\s*$/i, '').trim()

  if (!code || code.length < 200) {
    // Fallback minimal valid script so the user still gets *something* usable.
    code =
      `// ${wfName} — generated fallback (the code writer returned very little).\n` +
      `import { agent, log } from '../src/engine.mjs'\n` +
      `import { isMain, cli } from '../src/runner.mjs'\n\n` +
      `export const meta = { name: '${wfName}', description: 'Generated for: ${description.replace(/'/g, '')}', args: '<input>' }\n\n` +
      `export async function run(input, ctx = {}) {\n` +
      `  log('running generated fallback for: ' + input)\n` +
      `  const out = await agent('Perform the following task and return a concise result: ' + input, { label: 'fallback-worker' })\n` +
      `  return { input, result: out }\n` +
      `}\n\n` +
      `if (isMain(import.meta.url)) cli(meta, run)\n`
  }

  log(`write-workflow: code generated (${code.length} bytes)`)

  // 3. Execute the generated script immediately against the user's described task so they get value *now*.
  // We write to a temp file and import it (fresh context, exactly as a saved one would be loaded).
  const tmpDir = join(os.tmpdir(), 'grok-workflows-generated')
  try { mkdirSync(tmpDir, { recursive: true }) } catch {}
  const tmpFile = join(tmpDir, `${wfName}-${Date.now()}.mjs`)
  writeFileSync(tmpFile, code, 'utf8')

  let execResult = null
  let execError = null
  try {
    const mod = await import(tmpFile)
    if (typeof mod.run === 'function') {
      // Pass a sensible input derived from the original description (the "example" the user gave).
      // The generated script is expected to treat this as its runtime argument.
      const derivedInput = description.replace(/^(a |an |the )?custom (workflow|harness|orchestration|script) (that |to |for )?/i, '')
      log(`write-workflow: executing the just-generated script with derived input`)
      execResult = await mod.run(derivedInput, { cwd })
    }
  } catch (e) {
    execError = e?.message || String(e)
    log(`write-workflow: generated script execution hit: ${execError}`)
  }

  // 4. Optional auto-save into the user's personal workflows dir.
  let savedTo = null
  if (saveAs) {
    const targetDir = join(os.homedir(), '.grok', 'workflows')
    try { mkdirSync(targetDir, { recursive: true }) } catch {}
    const dest = join(targetDir, `${saveAs}.mjs`)
    writeFileSync(dest, code, 'utf8')
    savedTo = dest
    log(`write-workflow: auto-saved to ${savedTo}`)
  }

  return {
    name: wfName,
    description,
    design: design || null,
    script: code,
    executed: execResult != null,
    result: execResult,
    execError,
    savedTo,
    howToSaveManually: 'grok-workflows save ' + (saveAs || wfName) + ' --script -   (then paste the script field)',
    howToRunSaved: `grok-workflows ${saveAs || wfName} "<your per-run input>"`,
  }
}

if (isMain(import.meta.url)) cli(meta, run)
