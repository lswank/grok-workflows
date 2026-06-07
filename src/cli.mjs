#!/usr/bin/env node
// grok-workflows CLI — discover and run bundled + user-saved workflow harnesses by name.
//
//   grok-workflows list
//   grok-workflows run <name> "<input>"
//   grok-workflows <name> "<input>"          (shorthand)
//   grok-workflows save <name> --script <path-or-stdin> [--project]
//   grok-workflows runs
//
// User workflows live in ~/.grok/workflows/*.mjs (personal) or ./.grok/workflows/*.mjs (project).
// Project wins on name conflicts. This enables "save the workflow for reuse" exactly as
// described in the Claude Code dynamic workflows spec.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'
import os from 'node:os'
import { loadWorkflowMap, WORKFLOW_LOCATIONS } from '../workflows/_shared.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// CLI keywords reserved for commands (not harness names via bare shorthand).
const RESERVED_NAMES = new Set(['list', 'run', 'save', 'runs', '-h', '--help'])

async function loadWorkflows() {
  // Delegate to the shared loader so CLI, loop, goal, and generate all see the same
  // set (bundled + ~/.grok/workflows + ./.grok/workflows). Project > personal > bundled.
  const map = await loadWorkflowMap()
  // For backward compat with the rest of this file we attach a lightweight shape.
  for (const [k, v] of map) {
    if (!v.file) v.file = v.meta?.name || k
  }
  return map
}

function printList(workflows) {
  process.stdout.write('grok-workflows — dynamic workflows for Grok Code\n\n')
  process.stdout.write('Usage:\n  grok-workflows <name> "<input>"\n  grok-workflows list\n  grok-workflows save <name> --script <file> [--project]\n  grok-workflows runs\n\n')
  process.stdout.write('Available workflows (project > personal > bundled):\n')
  if (workflows.size === 0) {
    process.stdout.write('  (none found)\n')
  } else {
    for (const [name, mod] of [...workflows].sort((a, b) => a[0].localeCompare(b[0]))) {
      const src = mod.source ? ` [${mod.source}]` : ''
      process.stdout.write(`  ${name.padEnd(20)} ${mod.meta?.description || '(no description)'}${src}\n`)
    }
  }
}

async function cmdSave(rest) {
  // grok-workflows save <name> --script /path/to/generated.mjs [--project]
  let name = rest.shift()
  let scriptPath = null
  let toProject = false
  while (rest.length) {
    const t = rest.shift()
    if (t === '--script') scriptPath = rest.shift()
    else if (t === '--project') toProject = true
    else if (!scriptPath && t && !t.startsWith('--')) scriptPath = t
  }
  if (!name || !scriptPath) {
    process.stderr.write('Usage: grok-workflows save <name> --script <path-to-.mjs-or-> [--project]\n')
    process.exit(1)
  }
  let code
  if (scriptPath === '-' || scriptPath === '/dev/stdin') {
    code = readFileSync(0, 'utf8')
  } else {
    code = readFileSync(scriptPath, 'utf8')
  }
  const targetDir = toProject ? WORKFLOW_LOCATIONS.project : WORKFLOW_LOCATIONS.personal
  try { mkdirSync(targetDir, { recursive: true }) } catch {}
  const outPath = join(targetDir, `${name}.mjs`)
  writeFileSync(outPath, code, 'utf8')
  process.stdout.write(`Saved workflow "${name}" to ${outPath}\n`)
  process.stdout.write(`Run it with: grok-workflows ${name} "<your input>"\n`)
  process.exit(0)
}

async function cmdRuns() {
  // Placeholder for run history. Real runs are recorded by harnesses that opt in
  // (or by a future central runner). For now list the standard locations and note
  // that `GROK_WORKFLOWS_RUNS_DIR` or ~/.grok/workflows/runs can be used by tools.
  const runsDir = join(os.homedir(), '.grok', 'workflows', 'runs')
  process.stdout.write('grok-workflows runs — lightweight history (opt-in per harness today)\n')
  process.stdout.write(`Check ${runsDir} (or $GROK_WORKFLOWS_RUNS_DIR) for persisted run artifacts.\n`)
  process.stdout.write('Use /workflows (or grok-workflows list) to see available; save custom ones with `save`.\n')
  process.exit(0)
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const workflows = await loadWorkflows()

  if (!cmd || cmd === 'list' || cmd === '-h' || cmd === '--help') {
    printList(workflows)
    process.exit(0)
  }

  if (cmd === 'save') {
    await cmdSave(rest)
    return
  }
  if (cmd === 'runs') {
    await cmdRuns()
    return
  }

  const name = cmd === 'run' ? rest.shift() : cmd
  const input = rest.join(' ').trim()
  const mod = workflows.get(name)
  if (!mod) {
    process.stderr.write(`Unknown workflow "${name}". Run \`grok-workflows list\`.\n`)
    process.exit(1)
  }
  if (!input) {
    process.stderr.write(`Usage: grok-workflows ${name} ${mod.meta?.args || '<input>'}\n`)
    process.exit(1)
  }
  try {
    const result = await mod.run(input, { cwd: process.cwd() })
    process.stdout.write(JSON.stringify(result ?? null, null, 2) + '\n')
  } catch (err) {
    process.stderr.write(`${name} failed: ${err?.stack || err}\n`)
    process.exit(1)
  }
}

main()
