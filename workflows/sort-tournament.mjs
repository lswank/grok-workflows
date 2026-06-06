// sort-tournament — rank a list of items by a qualitative criterion using
// pairwise comparison instead of absolute scoring.
//
// Why pairwise? Absolute 1-10 scoring drifts: the same item gets a 6 in one
// call and an 8 in another, and the scale is uncalibrated across items. Asking
// an agent "which of these two is more X, and why?" is a much more stable
// judgment. We keep the running order in a deterministic JS loop and hand only
// the *current pair* to a fresh agent, so context never overflows even for
// 1000+ items.
//
// Two modes:
//   - full RANKING: repeated binary-search insertion sort. Each inserted item
//     is placed by O(log n) pairwise comparisons against the already-sorted
//     prefix. Comparisons at the same insertion step that are independent are
//     batched with parallel(); but because binary-search insertion is inherently
//     sequential (each comparison decides the next), we parallelise across the
//     bucket pre-pass instead (see below).
//   - top-k / "just the winner": delegates to the engine's tournament().
//
// To keep total comparisons sane and exploit parallelism, full ranking first
// does a parallel "bucket" pre-pass: every item is compared once against a small
// set of fixed pivots to get a coarse rank, then exact order within/around
// buckets is settled by pairwise insertion. This is the bucket-rank-then-merge
// strategy from the spec.

import { agent, parallel, tournament, log } from '../src/engine.mjs'

export const meta = {
  name: 'sort-tournament',
  description:
    'Rank a list of items by a qualitative criterion using pairwise comparison (more reliable than absolute scoring).',
  args: '<criterion> :: <item1> | <item2> | ...   (or a file path with one item per line)',
}

// The schema every comparison agent must satisfy. Because we pass a schema,
// agent() returns an OBJECT (or null on failure) — never a bare string.
const COMPARE_SCHEMA = {
  type: 'object',
  required: ['winner', 'reason'],
  properties: {
    winner: { enum: ['A', 'B'] },
    reason: { type: 'string' },
  },
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

/**
 * Parse the user's input into { criterion, items, topK }.
 *
 * Supported forms:
 *   "<criterion> :: a | b | c"                 inline list
 *   "<criterion> :: a | b | c  top:5"          inline list, top-5 only
 *   "/path/to/file"                            file, first line "criterion: ..."
 */
async function parseInput(input, ctx = {}) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('empty input')

  // top:N modifier (anywhere in the trailing portion).
  let topK = null
  const topMatch = raw.match(/(?:^|\s)top[:=](\d+)\s*$/i)
  let work = raw
  if (topMatch) {
    topK = Math.max(1, Number(topMatch[1]))
    work = raw.slice(0, topMatch.index).trim()
  }

  // File path? (no "::" separator and the path exists.)
  if (!work.includes('::')) {
    const candidate = resolveMaybePath(work, ctx)
    if (candidate && existsSync(candidate)) {
      const text = await readFile(candidate, 'utf8')
      return { ...parseFileText(text), topK }
    }
    throw new Error(
      'input must be "<criterion> :: item1 | item2 | ..." or a path to a file ' +
        '(first line "criterion: ...", one item per line)'
    )
  }

  const sep = work.indexOf('::')
  const criterion = work.slice(0, sep).trim()
  const itemsPart = work.slice(sep + 2)
  const items = splitItems(itemsPart)
  if (!criterion) throw new Error('missing criterion before "::"')
  return { criterion, items, topK }
}

function resolveMaybePath(p, ctx) {
  if (!p) return null
  if (p.startsWith('/') || p.startsWith('~')) {
    return p.startsWith('~') ? p.replace(/^~/, process.env.HOME || '~') : p
  }
  // Relative to ctx.cwd if given.
  if (ctx?.cwd) return `${ctx.cwd.replace(/\/$/, '')}/${p}`
  return p
}

function parseFileText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
  if (!lines.length) throw new Error('file is empty')
  let criterion = ''
  let start = 0
  const first = lines[0]
  const m = first.match(/^criterion\s*:\s*(.+)$/i)
  if (m) {
    criterion = m[1].trim()
    start = 1
  } else {
    // No explicit criterion line — treat first line as the criterion anyway.
    criterion = first
    start = 1
    log(`no "criterion:" prefix found; using first line as criterion`)
  }
  const items = lines.slice(start)
  if (!criterion) throw new Error('could not determine criterion from file')
  return { criterion, items }
}

function splitItems(s) {
  return String(s)
    .split('|')
    .map((x) => x.trim())
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// The single comparison primitive — one fresh agent per pairwise comparison.
// Returns -1 if A should rank ABOVE B, +1 if B should rank above A, 0 on a
// failed/ambiguous comparison (caller decides how to break the tie).
// ---------------------------------------------------------------------------

function comparePrompt(criterion, a, b) {
  return (
    `You are judging two items against a single qualitative criterion. ` +
    `Decide which item ranks HIGHER on the criterion.\n\n` +
    `Criterion (higher = more of this): ${criterion}\n\n` +
    `Item A:\n${a}\n\n` +
    `Item B:\n${b}\n\n` +
    `Return the winner ("A" or "B") — the one that ranks higher on the criterion — ` +
    `and a one-sentence reason. Pick exactly one; do not refuse or call it a tie.`
  )
}

/**
 * Run one comparison agent. Returns { dir, reason } where dir is -1 (A wins),
 * +1 (B wins). Defaults to A-wins on a null/failed agent so the deterministic
 * loop always makes progress; logs the fallback.
 */
async function compareOnce(criterion, a, b, label) {
  const res = await agent(comparePrompt(criterion, a, b), {
    schema: COMPARE_SCHEMA,
    label: label || `cmp`,
    // A comparison reads only the two strings we give it — quarantine it.
    disallowedTools: ['run_terminal_cmd', 'Agent'],
  })
  // With a schema, a successful agent() yields an object; failure yields null.
  if (!res || typeof res !== 'object') {
    log(`comparison failed (null); defaulting A>B for: ${label || 'cmp'}`)
    return { dir: -1, reason: '(comparison failed; kept prior order)', failed: true }
  }
  const winner = res.winner === 'B' ? 'B' : 'A'
  return { dir: winner === 'A' ? -1 : 1, reason: String(res.reason ?? ''), failed: false }
}

// ---------------------------------------------------------------------------
// Full ranking — binary-search insertion using pairwise comparisons.
//
// The order lives entirely in JS (`sorted`, an array of item objects). For each
// new item we binary-search its insertion point: log2(n) comparisons, each its
// own agent with a fresh context. The current comparison is the ONLY thing that
// goes to an agent, so a 1000-item list never overflows any context window.
// ---------------------------------------------------------------------------

async function rankByInsertion(criterion, items) {
  const sorted = [] // best-first; entries: { value }
  let comparisons = 0
  for (let idx = 0; idx < items.length; idx++) {
    const value = items[idx]
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      comparisons++
      const { dir } = await compareOnce(
        criterion,
        value,
        sorted[mid].value,
        `insert ${idx + 1}/${items.length} vs #${mid + 1}`
      )
      // dir === -1 => value ranks above sorted[mid] => go left.
      if (dir <= 0) hi = mid
      else lo = mid + 1
    }
    sorted.splice(lo, 0, { value })
    log(`placed item ${idx + 1}/${items.length} at rank ${lo + 1}/${sorted.length}`)
  }
  return { ranked: sorted.map((s) => s.value), comparisons }
}

// ---------------------------------------------------------------------------
// Bucket pre-pass (parallel) — gives insertion sort a warm start and exploits
// the parallel() barrier for genuinely independent comparisons.
//
// We pick up to P evenly-spaced pivots, then compare EVERY non-pivot item
// against EVERY pivot concurrently. Each item's bucket = how many pivots it
// beats. Sorting by bucket (desc) yields a coarse best-first order; the
// subsequent insertion pass only has to fix local disorder, but for simplicity
// and determinism we still run a full insertion pass over the bucket-ordered
// list (insertion sort is near-linear on nearly-sorted input in *comparisons
// that change direction*, but worst-case is the same — so we cap usage of this
// path to medium lists and log it).
// ---------------------------------------------------------------------------

async function bucketWarmStart(criterion, items) {
  const n = items.length
  const P = Math.min(5, Math.max(1, Math.floor(Math.sqrt(n))))
  // Evenly spaced pivot indices.
  const pivotIdx = []
  for (let i = 0; i < P; i++) pivotIdx.push(Math.floor((i * (n - 1)) / Math.max(1, P - 1)))
  const pivotSet = new Set(pivotIdx)
  const pivots = pivotIdx.map((i) => items[i])

  // All (item, pivot) comparisons are independent -> parallel barrier.
  const jobs = []
  const meta2 = []
  items.forEach((value, i) => {
    if (pivotSet.has(i)) return
    pivots.forEach((p, pj) => {
      jobs.push(() => compareOnce(criterion, value, p, `bucket ${i + 1} vs pivot ${pj + 1}`))
      meta2.push({ i })
    })
  })
  log(`bucket pre-pass: ${jobs.length} parallel comparisons over ${P} pivots`)
  const results = (await parallel(jobs)).map((r, k) => ({ r, i: meta2[k].i }))

  // Score = pivots beaten (dir === -1 means item beats pivot).
  const wins = new Array(n).fill(0)
  for (const { r, i } of results) {
    if (r && r.dir === -1) wins[i] += 1
  }
  // Pivots get a mid score so they interleave reasonably.
  pivotIdx.forEach((i, rankAmongPivots) => {
    wins[i] = P - rankAmongPivots // earlier pivot (closer to original front) scores higher
  })
  const order = items
    .map((value, i) => ({ value, score: wins[i], i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((e) => e.value)
  const comparisons = results.filter(({ r }) => r && !r.failed).length
  return { warm: order, comparisons }
}

// ---------------------------------------------------------------------------
// Top-k via the engine's tournament() — used when the user only wants the best.
// We run a single-elimination bracket to find the winner, remove it, and repeat
// k times. Each match is its own comparison agent (fresh context).
// ---------------------------------------------------------------------------

async function topKByTournament(criterion, items, k) {
  // Box each item so identity is unique PER OCCURRENCE. Comparing/removing the
  // winner by value-identity (===) would otherwise drop every duplicate of the
  // selected value at once — silently losing real items. Boxes fix that.
  const comparator = async (a, b) => {
    const { dir } = await compareOnce(criterion, a.value, b.value, `match`)
    return dir <= 0 ? a : b
  }
  let pool = items.map((value, i) => ({ value, i }))
  const ranked = []
  let comparisons = 0
  const want = Math.min(k, pool.length)
  for (let r = 0; r < want && pool.length; r++) {
    const before = pool.length
    const { winner, rounds } = await tournament(pool, comparator)
    // Count matches actually played this bracket (sum of pair-matches per round).
    comparisons += countMatches(before)
    if (winner == null) break
    ranked.push(winner.value)
    pool = pool.filter((x) => x !== winner) // box identity → removes exactly one
    log(`top-k: selected #${r + 1} (${rounds.length} bracket rounds), ${pool.length} remain`)
  }
  return { ranked, comparisons, remaining: pool.map((x) => x.value) }
}

function countMatches(n) {
  // Single-elimination over n items plays roughly n-1 matches (byes excluded).
  return Math.max(0, n - 1)
}

// ---------------------------------------------------------------------------
// run()
// ---------------------------------------------------------------------------

export async function run(input, ctx = {}) {
  const { criterion, items, topK } = await parseInput(input, ctx)

  const cleaned = items.filter(Boolean)
  const dropped = items.length - cleaned.length
  if (dropped > 0) log(`dropped ${dropped} empty item(s)`)

  if (cleaned.length === 0) {
    return { criterion, ranked: [], comparisons: 0, note: 'no items to rank' }
  }
  if (cleaned.length === 1) {
    return { criterion, ranked: cleaned.slice(), comparisons: 0 }
  }

  log(`criterion: "${criterion}" — ${cleaned.length} items` + (topK ? `, top-${topK}` : ''))

  // ---- top-k path: only the best few are wanted. ----
  if (topK != null) {
    const { ranked, comparisons, remaining } = await topKByTournament(criterion, cleaned, topK)
    const result = { criterion, ranked, comparisons, mode: 'tournament-top-k', topK }
    if (remaining.length) {
      result.unranked = remaining.length
      log(`${remaining.length} item(s) left unranked (only top-${topK} requested)`)
    }
    return result
  }

  // ---- full ranking path. ----
  let toInsert = cleaned
  let warmComparisons = 0
  // For larger lists, do a parallel bucket pre-pass so insertion starts from a
  // nearly-sorted order (cheaper, and uses the parallel() barrier).
  if (cleaned.length >= 8) {
    const { warm, comparisons } = await bucketWarmStart(criterion, cleaned)
    toInsert = warm
    warmComparisons = comparisons
  }

  const { ranked, comparisons } = await rankByInsertion(criterion, toInsert)
  return {
    criterion,
    ranked,
    comparisons: comparisons + warmComparisons,
    mode: cleaned.length >= 8 ? 'bucket+insertion' : 'insertion',
    items: cleaned.length,
  }
}

// ---------------------------------------------------------------------------
// Standalone CLI tail.
// ---------------------------------------------------------------------------

import { isMain, cli } from '../src/runner.mjs'
if (isMain(import.meta.url)) cli(meta, run)
