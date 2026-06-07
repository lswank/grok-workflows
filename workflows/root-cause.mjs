// root-cause — debug / post-mortem harness.
//
// Generates competing hypotheses from DISJOINT evidence slices (so generators
// can't cross-contaminate), dedupes them in plain JS, then puts each through an
// adversarial panel of skeptics. A hypothesis survives only on majority. If
// none survive, it loops another round of generators with the failed claims as
// exclusions, until one holds or we run out of rounds.
//
// Works for code bugs AND non-code post-mortems ("why did sales drop in March").
//
// Runs correctly under GROK_WORKFLOWS_MOCK=1: every agent() call returns a
// deterministic stand-in, so all object access is defensive.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  agent,
  parallel,
  adversarialVerify,
  loopUntilDone,
  log,
} from '../src/engine.mjs'

export const meta = {
  name: 'root-cause',
  description:
    'Debug/post-mortem by generating competing hypotheses from disjoint evidence and testing each against a panel until one survives.',
  args: '<problem description> [-- optional evidence file paths]',
}

// The three disjoint evidence slices each generator is restricted to. Keeping
// them apart is what stops three agents from converging on the same anchored
// guess — each only sees its own lane.
const SLICES = [
  {
    id: 'logs',
    focus:
      'logs, traces, stack traces, error messages, alerts, timelines and event sequences',
  },
  {
    id: 'code',
    focus:
      'source code, configuration, infrastructure-as-code, recent diffs/changes, and documentation',
  },
  {
    id: 'data',
    focus:
      'data, metrics, dashboards, business numbers, KPIs, A/B results, and quantitative trends',
  },
]

// Panel lenses — each is an independent skeptic trying to knock the claim down.
const PANEL_LENSES = [
  'evidence supports it',
  'can it be reproduced/confirmed',
  'does it explain ALL symptoms',
]

const hypothesisSchema = {
  type: 'object',
  required: ['hypotheses'],
  properties: {
    hypotheses: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim'],
        properties: {
          claim: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
  },
}

/** Normalize a claim string for dedupe: lowercase, collapse whitespace/punct. */
function normClaim(claim) {
  return String(claim || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Pull a sane {claim, evidence}[] out of whatever an agent returned. */
function extractHypotheses(result, slice) {
  // Failed agent (null) or non-object (mock string) → nothing usable.
  if (!result || typeof result !== 'object') return []
  const raw = Array.isArray(result.hypotheses) ? result.hypotheses : []
  const out = []
  for (const h of raw) {
    if (!h) continue
    // h may be a string or an object depending on how the agent answered.
    const claim = typeof h === 'string' ? h : h.claim
    if (!claim || typeof claim !== 'string' || !claim.trim()) continue
    out.push({
      claim: claim.trim(),
      evidence: (typeof h === 'object' && h.evidence) || '',
      slice,
    })
  }
  return out
}

/** Build the prompt for one hypothesis generator over a single evidence slice. */
function generatorPrompt(problem, slice, evidenceFiles, exclusions) {
  const parts = [
    `You are a root-cause investigator. Problem to explain:\n${problem}`,
    `\nYou are restricted to ONE evidence lane: ${slice.focus}. ` +
      `Do NOT speculate beyond what this lane can support. Ignore other lanes — other investigators cover them.`,
  ]
  if (evidenceFiles && evidenceFiles.length) {
    parts.push(
      `\nEvidence files provided (read only the ones relevant to your lane):\n` +
        evidenceFiles.map((f) => `- ${f}`).join('\n')
    )
  } else {
    parts.push(
      `\nNo evidence files were attached. Gather your own slice of evidence for your lane ` +
        `(inspect the repo/files, search, or reason from the problem statement) before proposing hypotheses.`
    )
  }
  if (exclusions && exclusions.length) {
    parts.push(
      `\nThe following hypotheses were already proposed and REJECTED by a verification panel. ` +
        `Do NOT repeat them or trivial rewordings — propose genuinely different root causes:\n` +
        exclusions.map((c) => `- ${c}`).join('\n')
    )
  }
  parts.push(
    `\nPropose 1-3 concrete, falsifiable root-cause hypotheses, each with the specific evidence ` +
      `from your lane that points to it.`
  )
  return parts.join('\n')
}

/** Run one full round of three disjoint generators; return deduped hypotheses. */
async function generateRound(problem, evidenceFiles, exclusions, ctx, roundLabel) {
  log(`${roundLabel}: spawning ${SLICES.length} disjoint generators`)
  // parallel() barrier: we want every lane's hypotheses together before dedupe.
  const results = await parallel(
    SLICES.map((slice) => () =>
      agent(generatorPrompt(problem, slice, evidenceFiles, exclusions), {
        schema: hypothesisSchema,
        label: `gen:${slice.id}`,
        cwd: ctx.cwd,
        // Generators read evidence but must not mutate state or spawn sub-agents.
        disallowedTools: ['Agent'],
      })
    )
  )

  // Pair each result with its own slice BEFORE filtering, so a failed generator
  // in the middle doesn't shift slice labels onto the wrong lane's hypotheses.
  const collected = results.flatMap((res, i) =>
    res ? extractHypotheses(res, SLICES[i] ? SLICES[i].id : 'unknown') : []
  )

  const dropped = results.length - results.filter(Boolean).length
  if (dropped > 0) log(`${roundLabel}: ${dropped} generator(s) failed and were dropped`)

  return collected
}

/** Dedupe by normalized claim, preferring the first occurrence (keeps its slice). */
function dedupe(hypotheses) {
  const seen = new Map()
  for (const h of hypotheses) {
    const key = normClaim(h.claim)
    if (!key) continue
    if (!seen.has(key)) seen.set(key, h)
  }
  const unique = [...seen.values()]
  const removed = hypotheses.length - unique.length
  if (removed > 0) log(`dedupe: removed ${removed} duplicate hypothesis/hypotheses`)
  return unique
}

/** Panel-test one hypothesis with adversarialVerify across the fixed lenses. */
async function panelTest(h, ctx) {
  const claimText =
    `${h.claim}` + (h.evidence ? `\n\nSupporting evidence cited: ${h.evidence}` : '')
  const verdict = await adversarialVerify(claimText, {
    lenses: PANEL_LENSES,
    agentOpts: {
      cwd: ctx.cwd,
      // Verifiers must not mutate state; they only inspect/refute.
      disallowedTools: ['Agent'],
    },
  })
  // confidence = share of lenses that did NOT refute (kept / total votes cast).
  const totalVotes = verdict.kept + verdict.refuted
  const confidence = totalVotes > 0 ? verdict.kept / totalVotes : 0
  return {
    claim: h.claim,
    evidence: h.evidence,
    slice: h.slice,
    survives: verdict.survives,
    confidence,
    kept: verdict.kept,
    refuted: verdict.refuted,
    votes: verdict.votes,
  }
}

export async function run(input, ctx = {}) {
  const cwd = ctx.cwd || process.cwd()

  // Parse "<problem> -- file1 file2" into a problem string + evidence file list.
  // Use the *last* " -- " (greedy) so that a problem description containing early dashes
  // or " -- " does not truncate the evidence list or mangle the problem text.
  const sepMatch = input.match(/^(.*)\s+--\s+(.*)$/)
  let problem = input
  let evidenceFiles = []
  if (sepMatch) {
    problem = sepMatch[1].trim()
    evidenceFiles = sepMatch[2]
      .trim()
      .split(/\s+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => (path.isAbsolute(p) ? p : path.resolve(cwd, p)))
  }
  problem = problem.trim()
  if (!problem) throw new Error('no problem description provided')

  // Validate evidence files exist; warn (don't crash) on any that don't.
  if (evidenceFiles.length) {
    const checked = await parallel(
      evidenceFiles.map((f) => async () => {
        try {
          await fs.access(f)
          return f
        } catch {
          log(`evidence file not found, dropping: ${f}`)
          return null
        }
      })
    )
    evidenceFiles = checked.filter(Boolean)
  }
  log(
    `root-cause: problem="${problem.slice(0, 80)}"` +
      (evidenceFiles.length ? ` with ${evidenceFiles.length} evidence file(s)` : ' (no evidence files)')
  )

  const runCtx = { cwd }
  let rounds = 0
  let surviving = []
  const rejected = []
  const rejectedClaims = [] // exclusions fed back into later generator rounds

  // loopUntilDone drives extra rounds ONLY when nothing survived; it stops as
  // soon as a round yields a survivor (done:true), or after maxRounds / dryStreak.
  await loopUntilDone(
    async (round) => {
      rounds = round + 1
      const roundLabel = `round ${rounds}`

      const raw = await generateRound(
        problem,
        evidenceFiles,
        rejectedClaims,
        runCtx,
        roundLabel
      )
      const unique = dedupe(raw)
      if (unique.length === 0) {
        // Genuine dry round: generators produced nothing new. Retrying is
        // unlikely to help, so let dryStreak end the loop.
        log(`${roundLabel}: no hypotheses generated`)
        return { items: [] }
      }
      log(`${roundLabel}: panel-testing ${unique.length} hypothesis/hypotheses`)

      // Panel-test all unique hypotheses for this round (barrier on the round).
      const tested = (
        await parallel(unique.map((h) => () => panelTest(h, runCtx)))
      ).filter(Boolean)

      const survivors = tested.filter((t) => t.survives)
      const failures = tested.filter((t) => !t.survives)

      for (const f of failures) {
        rejected.push(f)
        rejectedClaims.push(f.claim)
      }

      if (survivors.length > 0) {
        surviving = survivors.sort((a, b) => b.confidence - a.confidence)
        log(`${roundLabel}: ${survivors.length} hypothesis/hypotheses survived the panel`)
        return { items: survivors, done: true }
      }

      // Hypotheses WERE generated but none survived the panel. This is real
      // progress (the failures become exclusions for the next round), so we do
      // NOT want it to count as a dry round — return the failures as items so
      // dryStreak resets and the loop runs another round (up to maxRounds),
      // each time excluding what was already refuted. The accumulated return
      // value is unused; `surviving` is set via closure on the round that wins.
      log(`${roundLabel}: no survivors; trying a fresh round with exclusions`)
      return { items: failures }
    },
    // dryStreak:1 stops as soon as a round generates nothing; maxRounds bounds
    // the retry-with-exclusions loop when rounds keep producing (but failing)
    // hypotheses. A surviving round ends the loop early via done:true.
    { maxRounds: 3, dryStreak: 1 }
  )

  return {
    problem,
    surviving, // ranked by panel confidence, highest first
    rejected,
    rounds,
  }
}

import { isMain, cli } from '../src/runner.mjs'
if (isMain(import.meta.url)) cli(meta, run)
