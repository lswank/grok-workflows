// brainstorm-tournament — taste-based exploration via generate-and-filter +
// rubric-scored tournament.
//
// Naming a CLI, choosing a design direction, picking an approach — these are
// taste calls where absolute "score each option 1-10" judging is noisy and
// self-inconsistent. This harness instead:
//   1. Spawns several generator agents from DIFFERENT angles (literal,
//      evocative, playful, technical) so the candidate pool is genuinely
//      diverse, then dedupes.
//   2. Derives a rubric (or accepts a user-supplied one after "::").
//   3. Runs the engine's tournament() with a PAIRWISE comparator agent that,
//      given two candidates + the rubric, returns the winner with reasoning.
//      We find the winner, remove it, run again for 2nd, then 3rd — a top-3.
//
// Primitives used: parallel() barriers for generation + the per-rank dedupe/
// comparison sweeps, and tournament() for the pairwise brackets.

import { agent, parallel, tournament, log } from '../src/engine.mjs'

export const meta = {
  name: 'brainstorm-tournament',
  description:
    'Brainstorm many options (names, designs, approaches) and run a rubric-scored tournament to pick the top 3.',
  args: '<thing to name/design> [:: rubric]',
}

// Generation angles — each is a separate agent with a fresh context window so
// the pool doesn't collapse to one voice. Add/remove freely.
const ANGLES = [
  {
    label: 'literal',
    guidance:
      'Be plain, descriptive, and unmistakable. Options should say exactly what the thing is. ' +
      'Favor clarity over cleverness.',
  },
  {
    label: 'evocative',
    guidance:
      'Be metaphorical and evocative. Reach for imagery, mood, and connotation. ' +
      'Options should suggest a feeling or a story, not just a function.',
  },
  {
    label: 'playful',
    guidance:
      'Be playful, witty, and memorable. Puns, mashups, unexpected twists, and a sense of humor are welcome. ' +
      'Options should be fun to say out loud.',
  },
  {
    label: 'technical',
    guidance:
      'Be precise and credible to an expert audience. Lean on domain terms, conventions, and accuracy. ' +
      'Options should signal competence and fit the field.',
  },
]

const PER_ANGLE = 6 // candidates requested per angle

/** Normalize a candidate's display string for dedupe + comparison. */
function candText(c) {
  if (c == null) return ''
  if (typeof c === 'string') return c.trim()
  if (typeof c === 'object') return String(c.name ?? c.candidate ?? c.text ?? c.title ?? '').trim()
  return String(c).trim()
}

export async function run(input, ctx = {}) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('nothing to brainstorm — pass "<thing to name/design> [:: rubric]"')

  // Split off an optional user-supplied rubric after "::".
  const sepIdx = raw.indexOf('::')
  const subject = (sepIdx >= 0 ? raw.slice(0, sepIdx) : raw).trim()
  const userRubric = sepIdx >= 0 ? raw.slice(sepIdx + 2).trim() : ''
  if (!subject) throw new Error('the subject before "::" is empty')

  // -----------------------------------------------------------------------
  // Stage 1: generate from multiple angles (parallel barrier so we can dedupe
  // the whole pool at once), then dedupe.
  // -----------------------------------------------------------------------
  log(`brainstorm: generating candidates for "${subject}" from ${ANGLES.length} angles`)

  const genSchema = {
    type: 'object',
    required: ['candidates'],
    properties: {
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' }, note: { type: 'string' } },
        },
      },
    },
  }

  const batches = await parallel(
    ANGLES.map((angle) => () =>
      agent(
        `Brainstorm distinct options for the following. ${angle.guidance}\n\n` +
          `Subject: ${subject}\n\n` +
          `Produce about ${PER_ANGLE} options. Each option needs a short "name" (the option itself) ` +
          `and a one-line "note" explaining the idea. Make them genuinely different from one another.`,
        { schema: genSchema, label: `generate:${angle.label}` }
      )
    )
  )

  // Flatten + tolerate both the schema'd object shape and any stray string.
  const pool = []
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i]
    if (!b) {
      log(`generate:${ANGLES[i].label} failed — dropping that angle`)
      continue
    }
    const list = Array.isArray(b) ? b : Array.isArray(b.candidates) ? b.candidates : []
    for (const item of list) {
      const name = candText(item)
      if (!name) continue
      pool.push({
        name,
        note: typeof item === 'object' && item ? String(item.note ?? '').trim() : '',
        angle: ANGLES[i].label,
      })
    }
  }

  // Dedupe case-insensitively by name; keep first occurrence.
  const seen = new Set()
  const candidates = []
  let dropped = 0
  for (const c of pool) {
    const k = c.name.toLowerCase()
    if (seen.has(k)) {
      dropped++
      continue
    }
    seen.add(k)
    candidates.push(c)
  }
  if (dropped) log(`brainstorm: deduped ${dropped} duplicate candidate(s)`)
  log(`brainstorm: ${candidates.length} unique candidate(s) in the pool`)

  if (candidates.length === 0) {
    return { rubric: userRubric || '', top3: [], poolSize: 0 }
  }

  // -----------------------------------------------------------------------
  // Stage 2: derive or accept the rubric.
  // -----------------------------------------------------------------------
  let rubric = userRubric
  if (rubric) {
    log(`brainstorm: using user-supplied rubric`)
  } else {
    log(`brainstorm: deriving a rubric`)
    const rubricRes = await agent(
      `Propose a concise judging rubric for choosing the best option for this:\n\n` +
        `Subject: ${subject}\n\n` +
        `List 3-5 weighted criteria (e.g. memorability, clarity, fit, distinctiveness) ` +
        `appropriate to the subject. Keep it to a few lines that another judge could apply.`,
      {
        schema: {
          type: 'object',
          required: ['rubric'],
          properties: { rubric: { type: 'string' } },
        },
        label: 'derive-rubric',
      }
    )
    rubric =
      rubricRes && typeof rubricRes === 'object'
        ? String(rubricRes.rubric ?? '').trim()
        : String(rubricRes ?? '').trim()
    if (!rubric) {
      rubric =
        'Memorability, clarity of meaning, fit to the subject, distinctiveness, and ease of saying out loud.'
      log(`brainstorm: rubric derivation failed — falling back to a default rubric`)
    }
  }

  // -----------------------------------------------------------------------
  // Stage 3: pairwise tournament. The comparator is its own agent per match,
  // given the two candidates + the rubric, returning the winner + why.
  // Find #1, remove it, repeat for #2 and #3.
  // -----------------------------------------------------------------------
  const cmpSchema = {
    type: 'object',
    required: ['winner', 'why'],
    properties: { winner: { enum: ['A', 'B'] }, why: { type: 'string' } },
  }

  // Each match carries its own "why" out via a closure-shared map keyed by the
  // winning candidate name, so the final top-3 can report the deciding reason.
  const whyByName = new Map()

  const makeComparator = () => async (a, b) => {
    const an = candText(a)
    const bn = candText(b)
    const res = await agent(
      `You are judging two options against a rubric. Decide which is better. ` +
        `Be decisive; comparative judgment, not absolute scoring.\n\n` +
        `Rubric:\n${rubric}\n\n` +
        `Subject: ${subject}\n\n` +
        `Option A: ${an}${a?.note ? ` — ${a.note}` : ''}\n` +
        `Option B: ${bn}${b?.note ? ` — ${b.note}` : ''}\n\n` +
        `Return which option wins ("A" or "B") and a one-line "why".`,
      { schema: cmpSchema, label: `compare:${an} vs ${bn}` }
    )
    // Default to A on any failure (engine's tournament also coalesces null→A).
    const pickB = res && typeof res === 'object' && res.winner === 'B'
    const winner = pickB ? b : a
    const why = res && typeof res === 'object' ? String(res.why ?? '').trim() : ''
    if (why) whyByName.set(candText(winner).toLowerCase(), why)
    return winner
  }

  const top3 = []
  let remaining = candidates.slice()
  for (let rank = 1; rank <= 3 && remaining.length > 0; rank++) {
    log(`brainstorm: tournament round for rank #${rank} over ${remaining.length} candidate(s)`)
    const { winner } = await tournament(remaining, makeComparator())
    const winName = candText(winner)
    if (!winName) break
    top3.push({
      candidate: winName,
      why:
        whyByName.get(winName.toLowerCase()) ||
        (winner && winner.note ? winner.note : `Top pick at rank #${rank} by the rubric.`),
    })
    // Remove the winner and run again for the next rank.
    remaining = remaining.filter((c) => candText(c).toLowerCase() !== winName.toLowerCase())
  }

  log(`brainstorm: done — top ${top3.length} selected from a pool of ${candidates.length}`)
  return { rubric, top3, poolSize: candidates.length }
}

import { isMain, cli } from '../src/runner.mjs'
if (isMain(import.meta.url)) cli(meta, run)
