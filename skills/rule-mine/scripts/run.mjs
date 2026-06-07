// Self-locating launcher for this grok-workflows plugin skill.
//
// A grok plugin skill bundles helpers under scripts/. grok announces this skill's
// absolute path in the orchestrator's system context, so the SKILL.md tells the
// model to run THIS file by that announced absolute path. We then locate the rest
// of the plugin (the workflow harness + engine) RELATIVE TO OUR OWN on-disk
// location — never from the working directory — so it runs in any cwd, git repo or
// not, and even when the skill dir is reached through a symlink (Node resolves
// import.meta.url to the real path). The skill name is derived from the directory
// name, which is why this file is identical across every skill.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'

const skillDir = dirname(dirname(fileURLToPath(import.meta.url))) // <plugin>/skills/<name>
const pluginRoot = join(skillDir, '..', '..')                    // <plugin>
const name = basename(skillDir)                                  // e.g. "deep-research"
const harness = join(pluginRoot, 'workflows', `${name}.mjs`)

spawn(process.execPath, [harness, ...process.argv.slice(2)], { stdio: 'inherit' }).on(
  'exit',
  (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  }
)
