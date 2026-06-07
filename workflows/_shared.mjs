// Shared helpers for workflow harnesses that need to discover and delegate to
// other (bundled + user-saved) workflows.
//
// This keeps the discovery logic in one place so loop, goal, generate-workflow,
// and the CLI all behave consistently when a user has saved custom workflows
// in ~/.grok/workflows or .grok/workflows.

import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BUNDLED_DIR = join(__dirname, '..', 'workflows')
const USER_DIR = join(os.homedir(), '.grok', 'workflows')
const PROJECT_DIR = join(process.cwd(), '.grok', 'workflows')

const RESERVED = new Set(['list', 'run', 'save', 'runs', '-h', '--help'])

/**
 * Load all discoverable workflows (bundled + personal + project).
 * Later locations override earlier names (project > personal > bundled).
 * Returns Map<name, {meta, run, file, source}>
 */
export async function loadWorkflowMap() {
  const map = new Map()
  const dirs = [
    { dir: BUNDLED_DIR, source: 'bundled' },
    { dir: USER_DIR, source: 'personal' },
    { dir: PROJECT_DIR, source: 'project' },
  ]
  for (const { dir, source } of dirs) {
    let files
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.mjs'))
    } catch {
      continue
    }
    for (const file of files) {
      const name = file.replace(/\.mjs$/, '')
      if (RESERVED.has(name)) continue
      try {
        const full = join(dir, file)
        const mod = await import(full)
        if (mod.meta?.name && typeof mod.run === 'function') {
          map.set(mod.meta.name, {
            meta: mod.meta,
            run: mod.run,
            file: full,
            source,
          })
        }
      } catch (err) {
        process.stderr.write(`(skipping user workflow ${file}: ${err.message})\n`)
      }
    }
  }
  return map
}

export const WORKFLOW_LOCATIONS = { bundled: BUNDLED_DIR, personal: USER_DIR, project: PROJECT_DIR }
