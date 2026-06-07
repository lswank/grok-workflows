// rule-mine — mine recurring corrections from past sessions / review comments,
// cluster them, adversarially verify each candidate rule, drop the vague ones
// with a skeptic persona, and distill the survivors into ready-to-paste
// AGENTS.md (Grok) / CLAUDE.md rule bullets.
//
// Harness shape (per the grok-workflows authoring contract):
//   Stage 1  fan-out extractors    — parallel agents read slices, pull candidates
//   Stage 2  cluster               — one agent groups near-duplicates into themes
//   Stage 3  generate-and-filter   — draft a rule per cluster, then adversarial
//                                     verify + a SKEPTIC persona that rejects
//                                     vague/overbroad rules; keep only survivors
//   Stage 4  synthesis             — format survivors as markdown bullets
//
// Runs correctly under GROK_WORKFLOWS_MOCK=1: schema agents return objects,
// plain agents return strings, failed agents return null — all handled.
// The skeptic 'reject' boolean now uses strictSchema:true + coerceBoolean
// (see "Schema validation pitfalls & recommended patterns" in SPEC.md).

import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  agent,
  parallel,
  adversarialVerify,
  generateAndFilter,
  log,
  coerceBoolean,
} from '../src/engine.mjs'

export const meta = {
  name: 'rule-mine',
  description:
    'Mine recurring corrections from past sessions/review comments, cluster them, verify each, and distill survivors into AGENTS.md/CLAUDE.md rules.',
  args: '<path to sessions/transcripts/review-comments file or dir>',
}

// How many characters per slice handed to a single extractor agent. No silent
// cap on total content — we slice ALL of it and log the slice count.
const SLICE_CHARS = 12000

// ---------------------------------------------------------------------------
// Input loading: accept a file or a directory of files; concatenate into a
// labeled corpus, then slice for parallel extraction.
// ---------------------------------------------------------------------------

async function loadCorpus(input, ctx) {
  const target = path.resolve(ctx?.cwd || process.cwd(), input)
  let st
  try {
    st = await stat(target)
  } catch (err) {
    throw new Error(`cannot read input "${input}": ${err.message}`)
  }

  const files = []
  if (st.isDirectory()) {
    const entries = await readdir(target, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isFile()) continue
      if (e.name.startsWith('.')) continue
      files.push(path.join(target, e.name))
    }
    files.sort()
  } else {
    files.push(target)
  }

  const parts = []
  for (const f of files) {
    try {
      const body = await readFile(f, 'utf8')
      parts.push(`### SOURCE: ${path.basename(f)}\n${body}`)
    } catch (err) {
      log(`skip unreadable file ${f}: ${err.message}`)
    }
  }
  const corpus = parts.join('\n\n')
  if (!corpus.trim()) throw new Error(`no readable content found at "${input}"`)
  // Report files actually INGESTED, not merely discovered: an unreadable file is
  // skipped above, so files.length would overstate coverage in the log and stats.
  return { corpus, fileCount: parts.length }
}

function sliceCorpus(corpus, size = SLICE_CHARS) {
  const slices = []
  for (let i = 0; i < corpus.length; i += size) {
    slices.push(corpus.slice(i, i + size))
  }
  return slices
}

// ---------------------------------------------------------------------------
// Defensive normalizers — under mock mode (or a flaky agent) a schema agent may
// hand back `{mock:true}` or an unexpected shape. Never crash; coerce to the
// arrays/strings the pipeline expects.
// ---------------------------------------------------------------------------

function asArray(obj, key) {
  if (!obj || typeof obj !== 'object') return []
  const v = obj[key]
  return Array.isArray(v) ? v : []
}

function asString(v, fallback = '') {
  if (typeof v === 'string') return v
  if (v == null) return fallback
  try {
    return JSON.stringify(v)
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// Stage 1 — parallel extractors. Each agent reads one slice and pulls candidate
// corrections / recurring mistakes with the evidence that supports them.
// ---------------------------------------------------------------------------

const extractSchema = {
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['correction', 'evidence'],
        properties: {
          correction: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
  },
}

async function extractCandidates(slices) {
  const results = await parallel(
    slices.map((slice, i) => () =>
      agent(
        `You are reviewing a slice (#${i + 1} of ${slices.length}) of past agent ` +
          `sessions, transcripts, and/or code-review comments. Extract every ` +
          `RECURRING correction or mistake — places where a human corrected the ` +
          `agent, a reviewer pushed back, or the same error appears more than once.\n\n` +
          `For each, give:\n` +
          `- "correction": the corrective behavior the agent should have followed, ` +
          `phrased as an instruction.\n` +
          `- "evidence": a short verbatim-ish quote or specific reference from the ` +
          `text showing the mistake actually happened.\n\n` +
          `Only include things grounded in THIS text. If nothing recurs, return an ` +
          `empty list.\n\n--- CONTENT ---\n${slice}`,
        {
          schema: extractSchema,
          label: `extract #${i + 1}`,
          // Untrusted content: no shell, no sub-spawning.
          disallowedTools: ['run_terminal_cmd', 'Agent'],
        }
      )
    )
  )

  const candidates = []
  for (const r of results.filter(Boolean)) {
    for (const c of asArray(r, 'candidates')) {
      const correction = asString(c?.correction).trim()
      const evidence = asString(c?.evidence).trim()
      if (correction) candidates.push({ correction, evidence })
    }
  }
  return candidates
}

// ---------------------------------------------------------------------------
// Stage 2 — cluster near-duplicate candidates into themes (one agent, barrier:
// it needs all candidates at once to dedup across slices).
// ---------------------------------------------------------------------------

const clusterSchema = {
  type: 'object',
  required: ['clusters'],
  properties: {
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        required: ['theme', 'instances', 'exampleEvidence'],
        properties: {
          theme: { type: 'string' },
          instances: { type: 'number' },
          exampleEvidence: { type: 'string' },
        },
      },
    },
  },
}

async function clusterCandidates(candidates) {
  const listing = candidates
    .map(
      (c, i) =>
        `${i + 1}. CORRECTION: ${c.correction}\n   EVIDENCE: ${c.evidence}`
    )
    .join('\n')

  const out = await agent(
    `Group these extracted corrections into THEMES, merging near-duplicates that ` +
      `say the same thing in different words. For each theme return:\n` +
      `- "theme": a short label for the recurring problem/correction.\n` +
      `- "instances": how many of the listed candidates fall under it (a number).\n` +
      `- "exampleEvidence": the single most concrete piece of evidence for it.\n\n` +
      `Prefer fewer, sharper themes over many overlapping ones.\n\n` +
      `--- CANDIDATES ---\n${listing}`,
    {
      schema: clusterSchema,
      label: 'cluster',
      disallowedTools: ['run_terminal_cmd', 'Agent'],
    }
  )

  const clusters = asArray(out, 'clusters')
    .map((c) => ({
      theme: asString(c?.theme).trim(),
      instances: Number(c?.instances) || 1,
      exampleEvidence: asString(c?.exampleEvidence).trim(),
    }))
    .filter((c) => c.theme)

  // Fallback: if clustering produced nothing usable (e.g. mock returns {mock:true}),
  // degrade gracefully by treating each candidate as its own singleton theme so
  // the rest of the pipeline still exercises end-to-end.
  if (clusters.length === 0 && candidates.length) {
    log('cluster returned no themes — falling back to singleton clusters')
    return candidates.map((c) => ({
      theme: c.correction,
      instances: 1,
      exampleEvidence: c.evidence,
    }))
  }
  return clusters
}

// ---------------------------------------------------------------------------
// Stage 3 — generate-and-filter. For each cluster: draft a candidate rule, then
// gate it through (a) a SKEPTIC persona that rejects vague/overbroad rules and
// (b) adversarial verification asking whether the rule would have PREVENTED a
// real, specific mistake without causing false positives. Survivors only.
// ---------------------------------------------------------------------------

const ruleSchema = {
  type: 'object',
  required: ['rule'],
  properties: {
    rule: { type: 'string' },
    rationale: { type: 'string' },
  },
}

const skepticSchema = {
  type: 'object',
  required: ['reject', 'reason'],
  properties: {
    reject: { type: 'boolean' },
    reason: { type: 'string' },
  },
}

async function draftRule(cluster) {
  const out = await agent(
    `Draft ONE actionable rule for an AGENTS.md / CLAUDE.md guardrails file that ` +
      `addresses this recurring problem.\n\n` +
      `Theme: ${cluster.theme}\n` +
      `Observed ${cluster.instances} time(s).\n` +
      `Example evidence: ${cluster.exampleEvidence}\n\n` +
      `The rule must be: imperative, specific enough to be testable, and tied to ` +
      `the concrete failure above — not a platitude. Return "rule" (the bullet ` +
      `text) and "rationale" (why it earns a permanent place).`,
    {
      schema: ruleSchema,
      label: `draft: ${cluster.theme.slice(0, 32)}`,
      disallowedTools: ['run_terminal_cmd', 'Agent'],
    }
  )
  const rule = asString(out?.rule).trim()
  if (!rule) return null
  return {
    theme: cluster.theme,
    instances: cluster.instances,
    evidence: cluster.exampleEvidence,
    rule,
    rationale: asString(out?.rationale).trim(),
  }
}

// SKEPTIC persona — rejects vague, overbroad, or unfalsifiable rules outright.
async function skepticReject(candidate) {
  const out = await agent(
    `You are THE SKEPTIC. You despise vague, overbroad, motherhood-and-apple-pie ` +
      `rules that clutter a guardrails file without changing behavior. Your job is ` +
      `to REJECT any rule that is not crisp and operational.\n\n` +
      `Reject (reject=true) if the rule is: vague ("be careful", "write good code"), ` +
      `overbroad (applies to everything, so guides nothing), unfalsifiable (you ` +
      `can't tell if it was followed), or redundant with common sense already ` +
      `assumed of any competent agent.\n` +
      `Keep (reject=false) only if it is specific, testable, and clearly tied to a ` +
      `concrete recurring failure.\n\n` +
      `Rule: ${candidate.rule}\n` +
      `Tied to evidence: ${candidate.evidence}`,
    {
      schema: skepticSchema,
      label: `skeptic: ${candidate.theme.slice(0, 28)}`,
      strictSchema: true, // guarantee boolean 'reject' (see SPEC.md schema pitfalls; without this a string "true" would be ignored by the typeof guard)
      disallowedTools: ['run_terminal_cmd', 'Agent'],
    }
  )
  // Under mock, {mock:true} has no `reject` key -> treat as "don't reject" so the
  // pipeline still surfaces a result. With strictSchema the real agent returns boolean;
  // we use coerceBoolean for explicitness and per the new SPEC pitfalls section.
  const reject = coerceBoolean(out && out.reject)
  if (reject) {
    log(`skeptic rejected: ${candidate.theme} — ${asString(out?.reason).slice(0, 80)}`)
    candidate._rejectedBy = 'skeptic'
    candidate._rejectReason = asString(out?.reason).trim()
  }
  return !reject
}

// Adversarial verification — would this rule have PREVENTED a real, specific
// mistake in the evidence, precisely enough to avoid false positives?
async function rulePrevents(candidate) {
  const claim =
    `The rule "${candidate.rule}" would have PREVENTED this real, specific ` +
    `mistake — and is precise enough that following it would NOT trigger on ` +
    `legitimate work (no false positives). Evidence of the mistake: ` +
    `${candidate.evidence}`
  const verdict = await adversarialVerify(claim, {
    lenses: ['would-have-prevented-the-real-mistake', 'precision-no-false-positives'],
    agentOpts: { disallowedTools: ['run_terminal_cmd', 'Agent'] },
  })
  if (!verdict.survives) {
    log(`verifier refuted: ${candidate.theme} (refuted=${verdict.refuted}/${verdict.kept})`)
    candidate._rejectedBy = 'verifier'
    candidate._rejectReason = (verdict.votes.find((v) => v?.refuted)?.reason || '').trim()
  }
  return verdict.survives
}

// ---------------------------------------------------------------------------
// Stage 4 — synthesis. Format the survivors as ready-to-paste markdown bullets
// for AGENTS.md (Grok) / CLAUDE.md.
// ---------------------------------------------------------------------------

async function synthesizeMarkdown(rules) {
  if (!rules.length) return '## Mined rules\n\n_No rules survived verification._\n'

  const listing = rules
    .map(
      (r, i) =>
        `${i + 1}. RULE: ${r.rule}\n   THEME: ${r.theme} (seen ${r.instances}x)\n` +
        `   EVIDENCE: ${r.evidence}`
    )
    .join('\n')

  const md = await agent(
    `Format these verified rules as a ready-to-paste section for an AGENTS.md ` +
      `(Grok) / CLAUDE.md guardrails file. Use a "## Mined rules" heading and one ` +
      `concise imperative bullet ("- ...") per rule. No preamble, no commentary, ` +
      `no numbering — just the heading and the bullets.\n\n--- RULES ---\n${listing}`,
    {
      label: 'synthesize-markdown',
      disallowedTools: ['run_terminal_cmd', 'Agent'],
    }
  )

  const text = asString(md).trim()
  if (text && /-\s/.test(text)) return text

  // Deterministic fallback (e.g. mock returns a non-markdown ack): build it here
  // so the harness always yields paste-ready output.
  log('synthesis agent returned no usable markdown — building bullets locally')
  return (
    '## Mined rules\n\n' +
    rules.map((r) => `- ${r.rule}`).join('\n') +
    '\n'
  )
}

// ---------------------------------------------------------------------------
// run()
// ---------------------------------------------------------------------------

export async function run(input, ctx = {}) {
  const { corpus, fileCount } = await loadCorpus(input, ctx)
  const slices = sliceCorpus(corpus)
  log(`loaded ${fileCount} file(s), ${corpus.length} chars -> ${slices.length} slice(s)`)

  // Stage 1: parallel extraction.
  const candidates = await extractCandidates(slices)
  log(`stage 1: extracted ${candidates.length} candidate correction(s)`)
  if (!candidates.length) {
    return {
      rules: [],
      rejected: [],
      markdown: '## Mined rules\n\n_No recurring corrections found._\n',
      stats: { files: fileCount, slices: slices.length, candidates: 0, clusters: 0 },
    }
  }

  // Stage 2: cluster.
  const clusters = await clusterCandidates(candidates)
  log(`stage 2: ${clusters.length} cluster/theme(s)`)

  // Stage 3: generate-and-filter with skeptic + adversarial verification.
  // Track rejects out-of-band so we can report them; keep() flips the flag.
  const rejected = []
  const survivors = await generateAndFilter(
    // generate: one candidate rule per cluster (drafts run in parallel).
    async () => (await parallel(clusters.map((c) => () => draftRule(c)))).filter(Boolean),
    // keep: skeptic gate first (cheap reject), then adversarial verification.
    async (candidate) => {
      const passedSkeptic = await skepticReject(candidate)
      if (!passedSkeptic) {
        rejected.push(rejectionRecord(candidate))
        return false
      }
      const prevented = await rulePrevents(candidate)
      if (!prevented) {
        rejected.push(rejectionRecord(candidate))
        return false
      }
      return true
    },
    { key: (c) => c.rule.toLowerCase().replace(/\s+/g, ' ').trim() }
  )

  log(`stage 3: ${survivors.length} rule(s) survived, ${rejected.length} rejected`)

  // Stage 4: synthesize markdown.
  const markdown = await synthesizeMarkdown(survivors)
  log('stage 4: markdown synthesized')

  return {
    rules: survivors.map((r) => ({
      rule: r.rule,
      theme: r.theme,
      instances: r.instances,
      evidence: r.evidence,
      rationale: r.rationale,
    })),
    rejected,
    markdown,
    stats: {
      files: fileCount,
      slices: slices.length,
      candidates: candidates.length,
      clusters: clusters.length,
      survived: survivors.length,
      rejected: rejected.length,
    },
  }
}

function rejectionRecord(candidate) {
  return {
    rule: candidate.rule,
    theme: candidate.theme,
    rejectedBy: candidate._rejectedBy || 'unknown',
    reason: candidate._rejectReason || '',
  }
}

import { isMain, cli } from '../src/runner.mjs'
if (isMain(import.meta.url)) cli(meta, run)
