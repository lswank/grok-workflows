// loop — recurring execution of a (bundled or plain) workflow / task at a fixed interval.
// Pairs with /goal for hard stop conditions. Exceeds Claude's /loop by being a first-class
// harness you can invoke directly or via /workflow, with built-in delegation to other
// grok-workflows harnesses, MOCK support, and structured history in the result.
//
// Usage (standalone or via CLI):
//   node workflows/loop.mjs '30s deep-research What is the current state of Node permission model?'
//   node workflows/loop.mjs '5m triage ./incidents.txt --max 3'
//   GROK_WORKFLOWS_MOCK=1 node workflows/loop.mjs '10s check the build'
//
// Syntax:
//   <interval> <subcommand or free-form task> [options]
//   interval: 10s | 2m | 1h | 1d  (seconds, minutes, hours, days)
//   options: --max N   (max iterations; default 0 = unlimited until dry or manual stop)
//            --no-fire  (do not run immediately; wait first interval)
//
// When the subcommand matches a known harness name (deep-research, triage, ...), loop
// delegates to that harness's run() directly (no extra process). Otherwise the remainder
// is treated as a plain prompt and run via a single agent() each tick (useful for light
// recurring checks).
//
// The loop uses a deterministic interval timer and surfaces per-run results + a stop reason.
// Combine with goal harness for "loop until the goal agent says the criterion is met".

import {
  agent,
  log,
  config,
  resetTotalAgents,
} from '../src/engine.mjs'
import { isMain, cli } from '../src/runner.mjs'
import { setTimeout as sleep } from 'node:timers/promises'
import { loadWorkflowMap } from './_shared.mjs'  // shared loader for delegation (see below)

export const meta = {
  name: 'loop',
  description:
    'Run another workflow (or a plain task) repeatedly on an interval. Supports --max iters and composes with /goal. First-class /loop for Grok (exceeds by shipping the primitive).',
  args: '<interval> <workflow-or-task> [--max N] [--no-fire]',
}

function parseInterval(s) {
  const m = String(s || '').trim().match(/^(\d+)\s*(s|m|h|d)$/i)
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  const mul = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit]
  return n * mul
}

function parseLoopInput(input) {
  const raw = String(input || '').trim()
  // options at end
  let rest = raw
  let maxIters = 0
  let fireImmediately = true
  const maxMatch = rest.match(/\s+--max\s+(\d+)\s*$/i)
  if (maxMatch) {
    maxIters = Number(maxMatch[1])
    rest = rest.slice(0, maxMatch.index).trim()
  }
  if (/\s+--no-fire\s*$/i.test(rest)) {
    fireImmediately = false
    rest = rest.replace(/\s+--no-fire\s*$/i, '').trim()
  }
  // first token(s) until we see something that looks like the sub
  const tokens = rest.split(/\s+/)
  let i = 0
  let intervalStr = tokens[i] || ''
  let iv = parseInterval(intervalStr)
  if (iv == null && tokens[i + 1]) {
    // allow "30 s" or "2 m"
    intervalStr = tokens[i] + tokens[i + 1]
    iv = parseInterval(intervalStr)
    if (iv != null) i += 1
  }
  if (iv == null) {
    throw new Error('loop needs an interval like "30s" or "5m" as first token')
  }
  i += 1
  const sub = tokens.slice(i).join(' ').trim()
  if (!sub) throw new Error('loop needs a sub-workflow or task after the interval')
  return { intervalMs: iv, subcommand: sub, maxIters, fireImmediately, original: raw }
}

async function runSub(subcommand, cwd) {
  // Try to delegate to a known bundled/user workflow by name.
  const workflows = await loadWorkflowMap() // excludes 'loop' itself
  const [maybeName, ...rest] = subcommand.split(/\s+/)
  const mod = workflows.get(maybeName)
  if (mod && typeof mod.run === 'function') {
    const subInput = rest.join(' ')
    log(`loop: delegating to harness "${maybeName}"`)
    // Reset agent counter between top-level sub-runs so the global cap doesn't
    // accumulate across loop ticks in a long-lived process.
    resetTotalAgents(0)
    return mod.run(subInput, { cwd })
  }
  // Fallback: treat entire subcommand as a prompt for a single focused agent.
  // This makes `/loop 1m "is the build green in the current branch?"` useful.
  log(`loop: no harness match for first token; running as plain agent task`)
  resetTotalAgents(0)
  return agent(subcommand, { label: 'loop-tick' })
}

export async function run(input, ctx = {}) {
  const cwd = ctx.cwd || process.cwd()
  const { intervalMs, subcommand, maxIters, fireImmediately } = parseLoopInput(input)

  const history = []
  let iters = 0
  let stopReason = 'max-iters'

  if (fireImmediately) {
    log(`loop: immediate tick 0 (interval ${intervalMs}ms, sub="${subcommand.slice(0, 60)}...")`)
    const res = await runSub(subcommand, cwd)
    history.push({ iter: 0, result: res, ts: Date.now() })
    iters = 1
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (maxIters > 0 && iters >= maxIters) {
      stopReason = 'max-iters'
      break
    }
    await sleep(intervalMs)
    log(`loop: tick ${iters} (sub="${subcommand.slice(0, 60)}...")`)
    const res = await runSub(subcommand, cwd)
    history.push({ iter: iters, result: res, ts: Date.now() })
    iters += 1

    // Simple built-in "dry" heuristic for plain agent tasks: two consecutive null/empty
    // results stop early (user can override with --max or wrap with goal).
    const lastUsedHarness = history.some((h) => h.result && typeof h.result === 'object' && h.result !== null && !Array.isArray(h.result) && (h.result.triaged || h.result.report || h.result.surviving || h.result.ranking))
    if (!lastUsedHarness && history.length >= 2) {
      const last = history[history.length - 1].result
      const prev = history[history.length - 2].result
      if (!last && !prev) {
        stopReason = 'dry-streak'
        log('loop: two consecutive empty results, stopping')
        break
      }
    }
  }

  const last = history.length ? history[history.length - 1].result : null
  return {
    subcommand,
    intervalMs,
    iters: history.length,
    stopReason,
    lastResult: last,
    historySummary: history.map((h) => ({
      iter: h.iter,
      ts: h.ts,
      hasResult: h.result != null,
      type: typeof h.result,
    })),
  }
}

function modForSubcommandWasUsed(history) {
  // heuristic: if any result looks like a harness-shaped object, we delegated
  return history.some((h) => h.result && typeof h.result === 'object' && !Array.isArray(h.result))
}

// Support direct node execution + the standard CLI tail.
if (isMain(import.meta.url)) {
  // We bypass the generic cli() because loop's input parsing is special (interval first).
  // Still honor -h and print usage.
  const input = process.argv.slice(2).join(' ').trim()
  if (!input || input === '-h' || input === '--help') {
    process.stderr.write(
      `${meta.name} — ${meta.description}\n\n` +
        `Usage: node workflows/loop.mjs ${meta.args}\n` +
        `Examples:\n  node workflows/loop.mjs '30s deep-research What changed in Node 20 vs 22?'\n` +
        `  node workflows/loop.mjs '5m triage ./backlog.txt --max 4'\n`
    )
    process.exit(input ? 0 : 1)
  }
  run(input, { cwd: process.cwd() })
    .then((result) => {
      process.stdout.write(JSON.stringify(result ?? null, null, 2) + '\n')
      process.exit(0)
    })
    .catch((err) => {
      process.stderr.write(`\x1b[31m${meta.name} failed:\x1b[0m ${err?.stack || err}\n`)
      process.exit(1)
    })
}
