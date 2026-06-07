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

const child = spawn(process.execPath, [harness, ...process.argv.slice(2)], { stdio: 'inherit' })

// Forward signals to the harness (and thus to its grok -p children + worktrees) so that
// aborts / interrupts from the caller (e.g. tool timeout, ^C, or Grok cancelling the run)
// do not leave orphaned agent processes or git worktrees.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (child && !child.killed) child.kill(sig)
  })
}

child.on('error', (err) => {
  process.stderr.write(`[grok-workflows launcher] failed to start harness: ${err.message}\n`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    // Re-raise on self so the parent shell/tool sees the correct signal exit status (e.g. 130 for SIGINT).
    process.kill(process.pid, signal)
  } else {
    process.exit(code ?? 0)
  }
})
