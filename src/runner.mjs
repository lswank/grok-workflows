// Shared CLI runner for workflow files. Lets every workflow be executed as
//   node workflows/<name>.mjs "<input>"
// while also being importable as a module (export const meta, export async run).

import { pathToFileURL } from 'node:url'
import { realpathSync } from 'node:fs'

/** True when this module file is the process entrypoint. */
export function isMain(importMetaUrl) {
  const invoked = process.argv[1]
  if (!invoked) return false
  // Compare against both the raw and the symlink-resolved argv path. import.meta.url
  // is canonicalized by Node, so on systems where the invocation path contains a
  // symlink (e.g. macOS /tmp -> /private/tmp), the raw comparison would wrongly
  // return false and the standalone CLI tail would never run.
  const candidates = new Set()
  try {
    candidates.add(pathToFileURL(invoked).href)
  } catch {
    /* ignore */
  }
  try {
    candidates.add(pathToFileURL(realpathSync(invoked)).href)
  } catch {
    /* invoked path may not exist on disk; the raw comparison still applies */
  }
  return candidates.has(importMetaUrl)
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
    // A run() that resolves to undefined (e.g. a missing return) would make
    // JSON.stringify yield the JS value undefined, printing the bare token
    // "undefined" — invalid JSON that breaks any downstream JSON.parse. Coerce to
    // null so stdout always stays valid JSON.
    process.stdout.write(JSON.stringify(result ?? null, null, 2) + '\n')
    process.exit(0)
  } catch (err) {
    process.stderr.write(`\x1b[31m${meta.name} failed:\x1b[0m ${err?.stack || err}\n`)
    process.exit(1)
  }
}
