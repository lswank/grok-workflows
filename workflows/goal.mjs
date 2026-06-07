// goal — wrap any task or sub-workflow with a hard, verifiable completion criterion.
// Repeats (via loopUntilDone) until a dedicated checker agent declares the criterion met,
// or max rounds / dry streak. This directly implements the "pair with /goal to set a
// hard completion requirement" pattern from the Claude Code dynamic workflows blog.
//
// Exceeds the baseline by being a first-class harness (usable standalone, via /workflow,
// and composable with /loop).
//
// Usage:
//   node workflows/goal.mjs 'all claims have sources and the report is >= 800 words :: deep-research What changed in Node permission model between v20 and v22?'
//   node workflows/goal.mjs 'the fix is merged and tests pass with no regressions :: migrate rename User to Account -- src/'
//   GROK_WORKFLOWS_MOCK=1 node workflows/goal.mjs 'the answer is clearly written and cites 3+ independent sources :: explain the engine cap logic'

import {
  agent,
  loopUntilDone,
  log,
  coerceBoolean,
  resetTotalAgents,
} from '../src/engine.mjs'
import { isMain } from '../src/runner.mjs'
import { loadWorkflowMap } from './_shared.mjs'

export const meta = {
  name: 'goal',
  description:
    'Run a task or sub-workflow repeatedly until a checker agent confirms a hard completion criterion is met. First-class /goal (exceeds by shipping the primitive + composability with loop).',
  args: '<criterion> :: <workflow-or-task>',
}

function parseGoalInput(input) {
  const raw = String(input || '').trim()
  // Split on the first top-level " :: " (allows :: inside the task).
  const sep = raw.indexOf(' :: ')
  if (sep === -1) {
    // No explicit criterion — synthesize a sensible default and treat whole as task.
    return {
      criterion: 'The work is complete, correct, high-quality, and directly answers the request with no obvious gaps.',
      task: raw,
    }
  }
  const criterion = raw.slice(0, sep).trim()
  const task = raw.slice(sep + 4).trim()
  if (!criterion || !task) throw new Error('goal needs both <criterion> :: <task>')
  return { criterion, task }
}

async function runInner(task, cwd) {
  const workflows = await loadWorkflowMap()
  const [maybeName, ...rest] = task.split(/\s+/)
  const mod = workflows.get(maybeName)
  if (mod && typeof mod.run === 'function') {
    const sub = rest.join(' ')
    log(`goal: delegating inner to harness "${maybeName}"`)
    resetTotalAgents(0)
    return mod.run(sub, { cwd })
  }
  log(`goal: running inner task as plain agent`)
  resetTotalAgents(0)
  return agent(task, { label: 'goal-inner' })
}

export async function run(input, ctx = {}) {
  const cwd = ctx.cwd || process.cwd()
  const { criterion, task } = parseGoalInput(input)

  log(`goal: criterion="${criterion.slice(0, 80)}..." task="${task.slice(0, 80)}..."`)

  const checkerSchema = {
    type: 'object',
    required: ['met', 'reason'],
    properties: {
      met: { type: 'boolean' },
      reason: { type: 'string' },
      suggestions: { type: 'array', items: { type: 'string' } },
    },
  }

  const acc = await loopUntilDone(
    async (round, previous) => {
      const last = previous.length ? previous[previous.length - 1] : null
      const lastSummary = last ? JSON.stringify(last).slice(0, 3000) : '(no prior result)'

      log(`goal: round ${round} — running inner`)
      const innerResult = await runInner(task, cwd)

      const checkPrompt =
        `You are a strict goal checker. The user's hard completion criterion is:\n` +
        `${criterion}\n\n` +
        `Here is the most recent result from the worker (truncated):\n${lastSummary}\n\n` +
        `Decide whether the criterion is FULLY met. Be conservative — partial progress is not enough. ` +
        `If met, set met=true and give a one-sentence reason. If not, met=false and list the concrete gaps.`

      const check = await agent(checkPrompt, {
        label: `goal-check-${round}`,
        schema: checkerSchema,
        strictSchema: true,
      })

      const met = coerceBoolean(check?.met) === true
      if (met) {
        log(`goal: checker says met on round ${round}`)
        return { done: true, items: [innerResult] }
      }
      // Record the attempt + the check feedback so later rounds (and final) can see why we continued.
      return {
        items: [{ attempt: round, result: innerResult, check }],
      }
    },
    { maxRounds: 12, dryStreak: 2 }
  )

  const final = acc.length ? acc[acc.length - 1] : null
  const met = acc.length > 0 && (!final || !final.check || coerceBoolean(final.check?.met))

  return {
    criterion,
    task,
    met: !!met,
    rounds: acc.length,
    finalResult: final && final.result ? final.result : final,
    attempts: acc,
  }
}

// Direct execution support (the generic cli() tail also works because our input contains " :: ").
if (isMain(import.meta.url)) {
  // Reuse the runner for -h / help; the run() above handles real input.
  const { cli } = await import('../src/runner.mjs')
  cli(meta, run)
}
