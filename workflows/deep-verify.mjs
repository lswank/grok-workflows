// deep-verify — extract every factual/technical claim from a document and verify
// each one in detail against the codebase and/or the web.
//
// Pattern: fan-out-and-synthesize + adversarial verification.
//
//   Stage 1 (one agent): extract every verifiable claim → {claims:[{id,text}]}.
//   Stage 2 (pipeline, one agent PER claim): a fresh investigator reads files /
//           greps / searches the web and returns a verdict + evidence + source.
//   Stage 3 (pipeline, second agent for 'supported' claims only): an adversarial
//           source-quality auditor tries to debunk the evidence — defeating the
//           self-preferential bias of a single agent blessing its own finding.
//
// Each claim is its own OS process / context window, so the run scales to large
// documents without agentic laziness (no stopping at 35/50) and without one
// agent's optimism contaminating another's.
//
// Runs correctly under GROK_WORKFLOWS_MOCK=1: agent() returns an object when a
// schema is passed and a string otherwise, and null on failure. Every branch
// here tolerates string / object / null defensively.

import { readFile } from 'node:fs/promises'
import { agent, pipeline, log } from '../src/engine.mjs'

export const meta = {
  name: 'deep-verify',
  description:
    'Extract every factual/technical claim from a document and verify each one in detail against the codebase and/or web.',
  args: '<path-to-doc-or-text>',
}

// --- schemas -------------------------------------------------------------

const EXTRACT_SCHEMA = {
  type: 'object',
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'text'],
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['id', 'verdict', 'evidence', 'source'],
  properties: {
    id: { type: 'string' },
    verdict: { enum: ['supported', 'contradicted', 'unverifiable'] },
    evidence: { type: 'string' },
    source: { type: 'string' },
  },
}

const AUDIT_SCHEMA = {
  type: 'object',
  required: ['evidenceHolds', 'reason'],
  properties: {
    evidenceHolds: { type: 'boolean' },
    quality: { enum: ['high', 'medium', 'low'] },
    reason: { type: 'string' },
  },
}

// --- helpers -------------------------------------------------------------

const VALID_VERDICTS = new Set(['supported', 'contradicted', 'unverifiable'])

// Problems first: contradicted, then unverifiable, then supported. Within a
// rank, downgraded-by-audit claims float above clean ones.
const VERDICT_RANK = { contradicted: 0, unverifiable: 1, supported: 2 }

/** Read the input: a readable file path becomes its contents; otherwise the raw
 * string is treated as the document text itself. */
async function resolveInput(input, ctx) {
  const candidate = String(input || '').trim()
  if (!candidate) throw new Error('deep-verify needs a file path or raw text')
  // Heuristic: a single-line-ish, path-shaped argument → try to read it.
  const looksLikePath =
    candidate.length < 1024 && !candidate.includes('\n') && /[\/.]/.test(candidate)
  if (looksLikePath) {
    try {
      const text = await readFile(candidate, 'utf8')
      log(`read document from file: ${candidate} (${text.length} chars)`)
      return text
    } catch (err) {
      log(`not a readable file (${err.code || err.message}); treating input as raw text`)
    }
  }
  log(`using raw input text (${candidate.length} chars)`)
  return candidate
}

/** Tolerate a schema'd agent returning a string (mock / stray text) instead of
 * the expected object. */
function asObject(maybe) {
  if (maybe && typeof maybe === 'object' && !Array.isArray(maybe)) return maybe
  if (typeof maybe === 'string') {
    try {
      const parsed = JSON.parse(maybe)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* fall through */
    }
  }
  return null
}

// --- run -----------------------------------------------------------------

export async function run(input, ctx = {}) {
  const document = await resolveInput(input, ctx)

  // ---- Stage 1: extract every verifiable claim (one agent) --------------
  log('stage 1: extracting verifiable claims')
  const extracted = asObject(
    await agent(
      'You are a meticulous fact-extraction agent. Read the document below and ' +
        'extract EVERY discrete, independently verifiable factual or technical ' +
        'claim it makes — version numbers, API signatures, behavioral assertions, ' +
        'statistics, names, dates, "X does Y" statements, configuration values, etc. ' +
        'Be exhaustive: do not stop early, do not summarize, do not merge distinct ' +
        'claims. Each claim must be a single self-contained, checkable statement ' +
        '(include enough context that it stands alone). Assign each a short stable ' +
        'id like "c1", "c2", …\n\n--- DOCUMENT ---\n' +
        document,
      {
        schema: EXTRACT_SCHEMA,
        label: 'extract-claims',
        effort: 'high',
        // Reading-only; no need to mutate anything.
        disallowedTools: ['Agent'],
      }
    )
  )

  let claims = Array.isArray(extracted?.claims) ? extracted.claims : []
  // Normalize + dedupe + ensure ids.
  const seen = new Set()
  claims = claims
    .map((c, i) => {
      const text = (c && typeof c === 'object' ? c.text : c)
      return {
        id: (c && typeof c === 'object' && c.id ? String(c.id) : `c${i + 1}`),
        text: typeof text === 'string' ? text.trim() : '',
      }
    })
    .filter((c) => {
      if (!c.text) return false
      const k = c.text.toLowerCase()
      if (seen.has(k)) {
        log(`dropping duplicate claim: ${c.id}`)
        return false
      }
      seen.add(k)
      return true
    })

  log(`stage 1 complete: ${claims.length} claims extracted`)
  if (claims.length === 0) {
    return { total: 0, supported: 0, contradicted: 0, unverifiable: 0, claims: [] }
  }

  // ---- Stages 2+3: pipeline, one chain per claim ------------------------
  // No barrier: claim A can be in its adversarial audit while claim B is still
  // being investigated. Each stage receives (prev, originalClaim, index).
  const results = await pipeline(
    claims,

    // Stage 2 — investigate this single claim and return a verdict.
    async (claim) => {
      log(`stage 2: investigating ${claim.id} — ${claim.text.slice(0, 70)}`)
      const verdict = asObject(
        await agent(
          'You are a rigorous, skeptical verification agent investigating ONE claim. ' +
            'Determine whether it is true by gathering concrete evidence: read the ' +
            'relevant source files, grep the codebase, and/or search the web as ' +
            'appropriate to the claim. Do not guess. Decide:\n' +
            "  - 'supported'   : concrete evidence confirms it.\n" +
            "  - 'contradicted': concrete evidence shows it is false.\n" +
            "  - 'unverifiable': you could not find decisive evidence either way.\n" +
            'Report the actual evidence you found (quote file paths + lines, or the ' +
            'specific fact/URL) and cite your source. Be honest — unverifiable is a ' +
            'valid, expected answer when evidence is genuinely absent.\n\n' +
            `Claim id: ${claim.id}\nClaim: ${claim.text}`,
          {
            schema: VERDICT_SCHEMA,
            label: `verify:${claim.id}`,
            effort: 'high',
            // Investigator must not delegate to sub-agents; it does the work.
            disallowedTools: ['Agent'],
          }
        )
      )

      if (!verdict) {
        log(`stage 2: ${claim.id} investigator failed — marking unverifiable`)
        return {
          id: claim.id,
          text: claim.text,
          verdict: 'unverifiable',
          evidence: 'Verification agent failed to return a result.',
          source: 'none',
          audited: false,
        }
      }

      const v = VALID_VERDICTS.has(verdict.verdict) ? verdict.verdict : 'unverifiable'
      log(`stage 2: ${claim.id} → ${v}`)
      return {
        id: claim.id,
        text: claim.text,
        verdict: v,
        evidence: typeof verdict.evidence === 'string' ? verdict.evidence : '',
        source: typeof verdict.source === 'string' ? verdict.source : '',
        audited: false,
      }
    },

    // Stage 3 — adversarial source-quality audit, ONLY for 'supported' claims.
    // A fresh, independent auditor tries to debunk the evidence. This is the
    // adversarial-verification step: the agent that produced the finding never
    // gets to bless its own work.
    async (res) => {
      if (!res || res.verdict !== 'supported') return res

      log(`stage 3: adversarially auditing supported claim ${res.id}`)
      const audit = asObject(
        await agent(
          'You are an adversarial source-quality auditor. Another agent claims to ' +
            'have SUPPORTED a factual claim with the evidence below. Your job is to ' +
            'try hard to debunk it: verify the cited evidence/source actually exists, ' +
            'actually says what is claimed, and genuinely supports the claim (not a ' +
            'misread, hallucinated file/line, stale info, or unrelated source). ' +
            'Independently re-check by reading the file / grepping / searching. ' +
            'Set evidenceHolds=false if the evidence is fabricated, misquoted, ' +
            'irrelevant, or does not actually establish the claim; only set ' +
            'evidenceHolds=true when you confirmed it is real and on-point.\n\n' +
            `Claim id: ${res.id}\nClaim: ${res.text}\n` +
            `Reported evidence: ${res.evidence}\nReported source: ${res.source}`,
          {
            schema: AUDIT_SCHEMA,
            label: `audit:${res.id}`,
            effort: 'high',
            disallowedTools: ['Agent'],
          }
        )
      )

      if (!audit) {
        // Auditor failed — keep supported but flag that it was unaudited.
        log(`stage 3: ${res.id} auditor failed — keeping supported, unaudited`)
        return { ...res, audited: false, auditNote: 'audit agent failed' }
      }

      if (audit.evidenceHolds === false) {
        log(`stage 3: ${res.id} evidence DID NOT hold — downgrading to unverifiable`)
        return {
          ...res,
          verdict: 'unverifiable',
          audited: true,
          auditQuality: audit.quality || 'low',
          auditNote:
            'Original support was downgraded: adversarial audit found the evidence ' +
            'does not hold. ' + (audit.reason || ''),
        }
      }

      log(`stage 3: ${res.id} evidence confirmed (quality=${audit.quality || 'n/a'})`)
      return {
        ...res,
        audited: true,
        auditQuality: audit.quality || 'medium',
        auditNote: audit.reason || 'Evidence independently confirmed.',
      }
    }
  )

  // ---- Aggregate --------------------------------------------------------
  const clean = results.filter(Boolean)
  const dropped = results.length - clean.length
  if (dropped > 0) log(`note: ${dropped} claim chain(s) dropped to null (pipeline failure)`)

  // Lower = more suspect = sorted first within a verdict group. A claim that was
  // downgraded by the audit (audited && now 'unverifiable') is the most suspect of
  // all, so it must float above claims that were unverifiable from the start —
  // matching the documented intent ("downgraded-by-audit claims float above clean ones").
  const suspicion = (c) => {
    if (c.audited && c.verdict === 'unverifiable') return -1 // downgraded by audit
    if (c.auditQuality === 'low') return 0
    if (c.auditQuality === 'medium') return 1
    return c.audited ? 2 : 0 // confirmed high-quality last; unaudited treated as suspect
  }
  clean.sort((a, b) => {
    const r = (VERDICT_RANK[a.verdict] ?? 3) - (VERDICT_RANK[b.verdict] ?? 3)
    if (r !== 0) return r
    const qa = suspicion(a)
    const qb = suspicion(b)
    if (qa !== qb) return qa - qb
    return String(a.id).localeCompare(String(b.id))
  })

  const summary = {
    total: clean.length,
    supported: clean.filter((c) => c.verdict === 'supported').length,
    contradicted: clean.filter((c) => c.verdict === 'contradicted').length,
    unverifiable: clean.filter((c) => c.verdict === 'unverifiable').length,
    claims: clean,
  }
  log(
    `done: ${summary.total} claims — ${summary.supported} supported, ` +
      `${summary.contradicted} contradicted, ${summary.unverifiable} unverifiable`
  )
  return summary
}

import { isMain, cli } from '../src/runner.mjs'
if (isMain(import.meta.url)) cli(meta, run)
