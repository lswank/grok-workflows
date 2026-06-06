// eval-skill — lightweight eval harness.
//
// Run the SAME task N independent ways (each in its own isolated git worktree,
// each its own fresh context window), then GRADE the candidates with a separate
// set of agents — pairwise tournament + per-candidate rubric scoring — to pick
// and explain the best. The producers never grade themselves, which is the
// whole point: it structurally defeats self-preferential bias.
//
// We do not auto-apply anything. The candidate worktrees are left intact for the
// caller to inspect / cherry-pick the winner from.
//
// Primitives used: agent(isolation:'worktree'), parallel() barriers (Stage 1
// needs all candidates before grading; the tournament needs both sides of a
// match), tournament(), and schema-constrained grader agents.

import { agent, parallel, tournament, log } from '../src/engine.mjs'

export const meta = {
  name: 'eval-skill',
  description:
    'Lightweight eval: run a task N ways in isolated worktrees, then grade/compare the outputs against a rubric to pick and explain the best.',
  args: '<task to run N ways> [-- N] [:: rubric]',
}

// --------------------------------------------------------------------------
// Input parsing.  "<task> -- 4 :: clarity, correctness, simplicity"
//   -- N   sets the number of candidates (default 3)
//   :: ... sets the grading rubric (free text)
// Both are optional and order-independent.
// --------------------------------------------------------------------------

const DEFAULT_N = 3
const DEFAULT_RUBRIC =
  'correctness (does it actually solve the task), simplicity/clarity, robustness (edge cases & failure handling), and overall quality'

function parseInput(input) {
  let task = String(input || '').trim()
  let rubric = DEFAULT_RUBRIC
  let n = DEFAULT_N

  // Pull the rubric (everything after the first "::").
  const rubricIdx = task.indexOf('::')
  if (rubricIdx !== -1) {
    const r = task.slice(rubricIdx + 2).trim()
    task = task.slice(0, rubricIdx).trim()
    if (r) rubric = r
  }

  // Pull N (a "-- <int>" token, anywhere in what remains).
  const nMatch = task.match(/(?:^|\s)--\s*(\d+)\b/)
  if (nMatch) {
    const parsed = parseInt(nMatch[1], 10)
    if (Number.isFinite(parsed) && parsed > 0) n = parsed
    task = task.replace(nMatch[0], ' ').trim()
  }

  // Clamp to something sane; log if we clamp so there are no silent caps.
  const MAX_N = 8
  if (n > MAX_N) {
    log(`requested N=${n} exceeds cap ${MAX_N}; clamping to ${MAX_N}`)
    n = MAX_N
  }
  if (n < 2) {
    log(`N=${n} is too small to compare; bumping to 2`)
    n = 2
  }

  return { task, rubric, n }
}

// --------------------------------------------------------------------------
// Stage 1 — N independent producers, each in an isolated worktree.
// --------------------------------------------------------------------------

const CANDIDATE_SCHEMA = {
  type: 'object',
  required: ['candidate', 'approach', 'summary'],
  properties: {
    candidate: { type: 'number' },
    approach: { type: 'string' },
    summary: { type: 'string' },
  },
}

async function produceCandidate(task, rubric, n, i) {
  const candidateNo = i + 1
  const prompt =
    `You are candidate #${candidateNo} of ${n} independently attempting the SAME task. ` +
    `You are working in your own isolated git worktree, so make whatever changes the task ` +
    `requires directly in the working tree — do not worry about colliding with other candidates.\n\n` +
    `TASK:\n${task}\n\n` +
    `Pursue your own distinct, well-reasoned approach (don't assume what the others will do). ` +
    `Your work will later be graded by a SEPARATE evaluator against this rubric, so optimize for it:\n${rubric}\n\n` +
    `When done, report what you did. Set "candidate" to ${candidateNo}, "approach" to a short ` +
    `name/description of the strategy you took, and "summary" to a concrete account of the ` +
    `changes you made and why they satisfy the task and rubric.`

  const res = await agent(prompt, {
    isolation: 'worktree',
    schema: CANDIDATE_SCHEMA,
    effort: 'high',
    label: `produce#${candidateNo}`,
  })
  if (!res) return null
  // Normalize: schema returns an object, but be defensive.
  return {
    candidate: Number(res.candidate) || candidateNo,
    approach: String(res.approach ?? '').trim() || `approach ${candidateNo}`,
    summary: String(res.summary ?? '').trim(),
  }
}

// --------------------------------------------------------------------------
// Stage 2a — per-candidate rubric scorer (absolute score, separate agent).
// --------------------------------------------------------------------------

const SCORE_SCHEMA = {
  type: 'object',
  required: ['candidate', 'score', 'justification'],
  properties: {
    candidate: { type: 'number' },
    score: { type: 'number' }, // 0..100
    justification: { type: 'string' },
  },
}

async function scoreCandidate(task, rubric, cand) {
  const prompt =
    `You are an impartial evaluator. You did NOT produce any of these candidates. ` +
    `Score the following candidate solution to a task, on a 0-100 scale, strictly against the rubric.\n\n` +
    `TASK:\n${task}\n\nRUBRIC:\n${rubric}\n\n` +
    `CANDIDATE #${cand.candidate}\nApproach: ${cand.approach}\nWhat it did: ${cand.summary}\n\n` +
    `Be discerning — reserve high scores for genuinely strong work. Set "candidate" to ${cand.candidate}.`

  const res = await agent(prompt, {
    schema: SCORE_SCHEMA,
    effort: 'medium',
    disallowedTools: ['run_terminal_cmd'],
    label: `score#${cand.candidate}`,
  })
  if (!res) return null
  let score = Number(res.score)
  if (!Number.isFinite(score)) score = 0
  score = Math.max(0, Math.min(100, score))
  return {
    candidate: Number(res.candidate) || cand.candidate,
    score,
    justification: String(res.justification ?? '').trim(),
  }
}

// --------------------------------------------------------------------------
// Stage 2b — pairwise comparison (tournament). The comparator is its own agent.
// --------------------------------------------------------------------------

const COMPARE_SCHEMA = {
  type: 'object',
  required: ['winner'],
  properties: {
    winner: { type: 'number' }, // the winning candidate number
    reason: { type: 'string' },
  },
}

function makeComparator(task, rubric) {
  return async (a, b) => {
    const prompt =
      `You are an impartial judge comparing two candidate solutions to the SAME task. ` +
      `You did NOT produce either one. Pick the single better candidate strictly against the rubric.\n\n` +
      `TASK:\n${task}\n\nRUBRIC:\n${rubric}\n\n` +
      `CANDIDATE A (#${a.candidate})\nApproach: ${a.approach}\nWhat it did: ${a.summary}\n\n` +
      `CANDIDATE B (#${b.candidate})\nApproach: ${b.approach}\nWhat it did: ${b.summary}\n\n` +
      `Decide which is better overall. Set "winner" to either ${a.candidate} or ${b.candidate}.`

    const res = await agent(prompt, {
      schema: COMPARE_SCHEMA,
      effort: 'medium',
      disallowedTools: ['run_terminal_cmd'],
      label: `compare ${a.candidate}v${b.candidate}`,
    })
    // On failure or an unrecognized winner, default to A (tournament tolerates this).
    if (!res) return a
    const w = Number(res.winner)
    if (w === a.candidate) return a
    if (w === b.candidate) return b
    return a
  }
}

// --------------------------------------------------------------------------
// run()
// --------------------------------------------------------------------------

export async function run(input, ctx = {}) {
  const { task, rubric, n } = parseInput(input)
  if (!task) {
    throw new Error('No task provided. Usage: eval-skill "<task to run N ways> [-- N] [:: rubric]"')
  }

  log(`eval-skill: running task ${n} ways in isolated worktrees`)
  log(`rubric: ${rubric}`)

  // --- Stage 1: produce N candidates in parallel, each isolated. We need ALL
  // candidates before we can grade/compare, so a parallel() barrier is correct.
  const produced = (
    await parallel(
      Array.from({ length: n }, (_, i) => () => produceCandidate(task, rubric, n, i))
    )
  ).filter(Boolean)

  const dropped = n - produced.length
  if (dropped > 0) log(`note: ${dropped} of ${n} candidate producers failed and were dropped`)

  if (produced.length === 0) {
    log('all candidate producers failed; nothing to grade')
    return {
      winner: null,
      ranking: [],
      rubric,
      scores: [],
      candidates: [],
      requested: n,
      produced: 0,
      worktreesLeftForReview: true,
      note: 'All candidate producers failed; no winner could be determined. Worktrees (if any) are preserved.',
    }
  }

  log(`graded as ${produced.length} candidate(s) survived production`)

  // --- Stage 2: grade. Two independent grader families run concurrently:
  //   (a) per-candidate absolute rubric scores, and
  //   (b) a pairwise tournament.
  // Both are separate agents from the producers (no self-preference).
  const comparator = makeComparator(task, rubric)
  const [scoresRaw, bracket] = await Promise.all([
    parallel(produced.map((c) => () => scoreCandidate(task, rubric, c))),
    produced.length > 1
      ? tournament(produced, comparator)
      : Promise.resolve({ winner: produced[0], rounds: [] }),
  ])

  const scores = scoresRaw.filter(Boolean)
  const droppedScores = produced.length - scores.length
  if (droppedScores > 0) log(`note: ${droppedScores} rubric-scorer agent(s) failed and were dropped`)

  // --- Stage 3: combine signals into a ranking and pick the winner.
  const scoreByCand = new Map(scores.map((s) => [s.candidate, s]))
  const tourneyWinner = bracket?.winner?.candidate ?? null

  const combined = produced.map((c) => {
    const s = scoreByCand.get(c.candidate)
    const rubricScore = s ? s.score : null
    const tournamentBonus = c.candidate === tourneyWinner ? 1 : 0
    // Combined ordering key: rubric score first, tournament win breaks ties.
    const sortKey = (rubricScore ?? -1) * 10 + tournamentBonus * 5
    return {
      candidate: c.candidate,
      approach: c.approach,
      summary: c.summary,
      rubricScore,
      rubricJustification: s ? s.justification : null,
      wonTournament: c.candidate === tourneyWinner,
      sortKey,
    }
  })

  combined.sort((a, b) => b.sortKey - a.sortKey || a.candidate - b.candidate)

  const ranking = combined.map((c, i) => ({
    rank: i + 1,
    candidate: c.candidate,
    approach: c.approach,
    rubricScore: c.rubricScore,
    wonTournament: c.wonTournament,
  }))

  const winner = combined[0]?.candidate ?? null
  const winnerEntry = combined[0] || null

  log(
    `winner: candidate #${winner} (tournament winner: #${tourneyWinner ?? 'n/a'}); ` +
      `worktrees preserved for review`
  )

  return {
    winner,
    why: winnerEntry
      ? `Candidate #${winner} ("${winnerEntry.approach}") ranked first` +
        (winnerEntry.rubricScore != null ? ` with rubric score ${winnerEntry.rubricScore}/100` : '') +
        (winnerEntry.wonTournament ? ' and won the pairwise tournament' : '') +
        '. ' +
        (winnerEntry.rubricJustification || '')
      : null,
    ranking,
    rubric,
    scores: scores.map((s) => ({
      candidate: s.candidate,
      score: s.score,
      justification: s.justification,
    })),
    candidates: produced,
    tournamentWinner: tourneyWinner,
    requested: n,
    produced: produced.length,
    worktreesLeftForReview: true,
    note:
      'Outputs were NOT auto-applied. Each candidate ran in its own git worktree; ' +
      'inspect them and apply the winner manually. Use `git worktree list` to find them.',
  }
}

import { isMain, cli } from '../src/runner.mjs'
if (isMain(import.meta.url)) cli(meta, run)
