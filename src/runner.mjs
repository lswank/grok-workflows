// Shared CLI runner for workflow files. Lets every workflow be executed as
//   node workflows/<name>.mjs "<input>"
// while also being importable as a module (export const meta, export async run).

import { pathToFileURL } from 'node:url'

/** True when this module file is the process entrypoint. */
export function isMain(importMetaUrl) {
  const invoked = process.argv[1]
  if (!invoked) return false
  try {
    return importMetaUrl === pathToFileURL(invoked).href
  } catch {
    return false
  }
}

/**
 * Standard CLI wrapper. Joins argv into the input string, runs the workflow,
 * prints the result as pretty JSON to stdout, and sets a non-zero exit on error.
 *
 * @param {{name:string, description:string, args?:string}} meta
 * @param {(input:string, ctx?:object) => Promise<any>} run
 */
export async function cli(meta, run) {
  const input = process.argv.slice(2).join(' ').trim()
  if (!input || input === '-h' || input === '--help') {
    process.stderr.write(
      `${meta.name} — ${meta.description}\n\nUsage: node workflows/${meta.name}.mjs ${meta.args || '<input>'}\n`
    )
    process.exit(input ? 0 : 1)
  }
  try {
    const result = await run(input, { cwd: process.cwd() })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    process.exit(0)
  } catch (err) {
    process.stderr.write(`\x1b[31m${meta.name} failed:\x1b[0m ${err?.stack || err}\n`)
    process.exit(1)
  }
}
