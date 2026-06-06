#!/usr/bin/env node
// grok-workflows CLI — discover and run bundled workflow harnesses by name.
//
//   grok-workflows list
//   grok-workflows run <name> "<input>"
//   grok-workflows <name> "<input>"          (shorthand)

import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKFLOWS_DIR = join(__dirname, '..', 'workflows')

async function loadWorkflows() {
  let files
  try {
    files = (await readdir(WORKFLOWS_DIR)).filter((f) => f.endsWith('.mjs'))
  } catch {
    return new Map()
  }
  const map = new Map()
  for (const file of files) {
    try {
      const mod = await import(join(WORKFLOWS_DIR, file))
      if (mod.meta?.name && typeof mod.run === 'function') {
        map.set(mod.meta.name, { ...mod, file })
      }
    } catch (err) {
      process.stderr.write(`(skipping ${file}: ${err.message})\n`)
    }
  }
  return map
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const workflows = await loadWorkflows()

  if (!cmd || cmd === 'list' || cmd === '-h' || cmd === '--help') {
    process.stdout.write('grok-workflows — dynamic workflows for Grok Code\n\n')
    process.stdout.write('Usage:\n  grok-workflows <name> "<input>"\n  grok-workflows list\n\n')
    process.stdout.write('Available workflows:\n')
    if (workflows.size === 0) {
      process.stdout.write('  (none found)\n')
    } else {
      for (const [name, mod] of [...workflows].sort()) {
        process.stdout.write(`  ${name.padEnd(20)} ${mod.meta.description}\n`)
      }
    }
    process.exit(0)
  }

  const name = cmd === 'run' ? rest.shift() : cmd
  const input = rest.join(' ').trim()
  const mod = workflows.get(name)
  if (!mod) {
    process.stderr.write(`Unknown workflow "${name}". Run \`grok-workflows list\`.\n`)
    process.exit(1)
  }
  if (!input) {
    process.stderr.write(`Usage: grok-workflows ${name} ${mod.meta.args || '<input>'}\n`)
    process.exit(1)
  }
  try {
    const result = await mod.run(input, { cwd: process.cwd() })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } catch (err) {
    process.stderr.write(`${name} failed: ${err?.stack || err}\n`)
    process.exit(1)
  }
}

main()
