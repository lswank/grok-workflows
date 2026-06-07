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

export function launchFromScript(importMetaUrl) {
  const skillDir = dirname(dirname(fileURLToPath(importMetaUrl))) // <plugin>/skills/<name>
  const pluginRoot = join(skillDir, '..', '..')                    // <plugin>
  const name = basename(skillDir)                                  // e.g. "deep-research"
  const harness = join(pluginRoot, 'workflows', `${name}.mjs`)

  const child = spawn(process.execPath, [harness, ...process.argv.slice(2)], {
    stdio: 'inherit',
    // detached:true gives the harness its own process group (Unix). This lets us
    // kill the whole tree (-pid) so grok -p children + any in-flight worktrees
    // started by --worktree also receive the signal. Prevents the orphans that
    // the previous single child.kill() left behind in many real interrupt cases.
    detached: process.platform !== 'win32'
  })

  /**
   * Kill the harness child (and, on Unix, its process group). This is the improved
   * version that addresses the "launcher only kills direct child" hypothesis.
   * Windows falls back to killing the child process (no portable pgid kill without
   * extra modules).
   */
  function killTree(signal) {
    if (!child || child.killed) return
    if (process.platform === 'win32' || !child.pid) {
      try { child.kill(signal) } catch {}
    } else {
      try {
        process.kill(-child.pid, signal)
      } catch (e) {
        // group kill failed (not group leader, already exited, permission, etc.)
        try { child.kill(signal) } catch {}
      }
    }
  }

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => killTree(sig))
  }

  // Best-effort cleanup if the launcher process itself is shutting down for other
  // reasons (e.g. uncaught exception in the parent context).
  process.on('beforeExit', () => killTree('SIGTERM'))

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
}
