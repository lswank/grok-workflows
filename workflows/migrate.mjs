// migrate — mechanical migration / refactor harness for Grok Code.
//
// Shape: discover → fan-out-per-site (worktree-isolated edits) → adversarial
// review → report. The interesting work is the fan-out + isolation + review:
//
//   Stage 1  discovery agent (READ-ONLY): finds every site that needs the change
//            and returns {sites:[{path, why}]}. Schema-enforced so we get an
//            object, not prose.
//   Stage 2  per-site fix agent in an ISOLATED git worktree
//            (isolation:'worktree') so concurrent edits never collide on disk.
//            Returns {path, summary, done}.
//   Stage 3  per-fixed-site adversarial reviewer (READ-ONLY) — a *different*
//            fresh-context agent verifies the change is correct & complete,
//            defeating self-preferential bias. Returns {path, approved, issues}.
//
// We deliberately do NOT auto-merge the worktrees. Mechanical migrations want a
// human (or a follow-up step) to eyeball and apply the diffs. We report where
// the worktrees live and what passed/failed review.
//
// Runs cleanly under GROK_WORKFLOWS_MOCK=1: with a schema, agent() resolves to
// an object; without one, to a string; on failure, to null. Every aggregation
// guards against null and bad shapes.

import {
  agent,
  pipeline,
  log,
} from '../src/engine.mjs'

export const meta = {
  name: 'migrate',
  description:
    'Mechanical migration/refactor: discover sites, fix each in an isolated worktree, adversarially review, report (merges left to the user).',
  args: '<migration description> [-- glob or dir to scope]',
}

// --- schemas -----------------------------------------------------------------

const DISCOVERY_SCHEMA = {
  type: 'object',
  required: ['sites'],
  properties: {
    sites: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'why'],
        properties: {
          path: { type: 'string' },
          why: { type: 'string' },
        },
      },
    },
  },
}

const FIX_SCHEMA = {
  type: 'object',
  required: ['path', 'summary', 'done'],
  properties: {
    path: { type: 'string' },
    summary: { type: 'string' },
    done: { type: 'boolean' },
    // The literal `git diff` of the change. Carried out of the isolated worktree
    // so the read-only reviewer (which runs OUTSIDE that worktree) can inspect
    // the actual change instead of trusting the prose summary.
    diff: { type: 'string' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['path', 'approved', 'issues'],
  properties: {
    path: { type: 'string' },
    approved: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
  },
}

// --- helpers -----------------------------------------------------------------

/** Split "<migration> -- <scope>" into { migration, scope }. */
function parseInput(input) {
  const raw = String(input || '').trim()
  const idx = raw.indexOf(' -- ')
  if (idx === -1) return { migration: raw, scope: '' }
  return {
    migration: raw.slice(0, idx).trim(),
    scope: raw.slice(idx + 4).trim(),
  }
}

// --- run ---------------------------------------------------------------------

export async function run(input, ctx = {}) {
  const { migration, scope } = parseInput(input)
  if (!migration) throw new Error('migrate: empty migration description')

  const cwd = ctx.cwd
  const scopeNote = scope
    ? `Scope the work to: ${scope}`
    : 'No explicit scope was given; search the whole project.'

  log(`migrate: "${migration}"`)
  log(scopeNote)

  // -- Stage 1: discovery (read-only) -----------------------------------------
  const discovery = await agent(
    [
      'You are a code-migration scout. Your ONLY job is to FIND, not to change.',
      '',
      `Migration to perform: ${migration}`,
      scopeNote,
      '',
      'Search the codebase and list EVERY distinct file/site that needs editing',
      'to complete this migration. Be exhaustive — do not stop early or sample.',
      'For each site give its path and a one-line reason it needs the change.',
      'Do NOT modify any files.',
    ].join('\n'),
    {
      label: 'discover',
      schema: DISCOVERY_SCHEMA,
      cwd,
      // Read-only scout: no shell, no sub-spawning, no web.
      disallowedTools: ['run_terminal_cmd', 'Agent'],
      disableWebSearch: true,
      effort: 'high',
    }
  )

  // With a schema we expect an object; tolerate a null (failed agent) or a
  // stray string (mock without schema awareness) without crashing.
  const sites = Array.isArray(discovery?.sites)
    ? discovery.sites.filter(
        (s) => s && typeof s === 'object' && typeof s.path === 'string'
      )
    : []

  if (sites.length === 0) {
    log('migrate: discovery returned no sites — nothing to migrate')
    return {
      migration,
      scope: scope || null,
      sites: 0,
      fixed: [],
      needsAttention: [],
      dropped: 0,
      merged: false,
      note: 'No sites found needing this migration (or discovery failed).',
    }
  }

  log(`migrate: ${sites.length} site(s) to migrate`)

  // -- Stages 2 & 3: per-site fix (worktree) → adversarial review -------------
  // pipeline(): each site flows through fix → review independently. No barrier,
  // so site A can be under review while site B is still being fixed. We only
  // need a barrier at the very end to assemble the report, which we get for free
  // by awaiting the pipeline.
  const outcomes = await pipeline(
    sites,

    // Stage 2 — fix the site in an isolated worktree.
    async (site) => {
      const result = await agent(
        [
          'You are a precise migration engineer working in an ISOLATED git worktree.',
          'Your edits here will NOT touch any other agent\'s files — work freely.',
          '',
          `Migration to perform: ${migration}`,
          `Apply it to this site: ${site.path}`,
          `Why this site needs it: ${site.why}`,
          '',
          'Make ONLY the change this migration requires, at this site (and any',
          'edits strictly necessary for this site to remain consistent). Keep the',
          'diff minimal and mechanical.',
          '',
          // IMPORTANT: keep per-agent cost low so we can fan out widely. A full
          // test suite or build in every worktree would exhaust the machine.
          'IMPORTANT: Do NOT run resource-intensive commands. Do NOT run the full',
          'test suite, a full build, installs, or anything long-running — those',
          'would exhaust the machine across many parallel worktrees. A quick',
          'targeted check (e.g. grep, a syntax/parse check, or a single fast unit',
          'test for just this file) is fine; nothing heavy.',
          '',
          'Report what you changed. Set done=true only if the migration is fully',
          'applied at this site; false if you were blocked or it is partial.',
          'Then run `git diff` in your worktree and put its COMPLETE output in the',
          '"diff" field — a separate reviewer who cannot see your worktree will rely',
          'on that diff (not your summary) to verify the change. If the diff is',
          'empty, you made no change: set done=false.',
        ].join('\n'),
        {
          label: `fix:${site.path}`,
          schema: FIX_SCHEMA,
          isolation: 'worktree', // disk isolation → safe parallel edits
          cwd,
          effort: 'high',
        }
      )

      // agent() => object (schema) | null (failed). Normalize either way; carry
      // the original site so review and reporting have full context.
      const fix =
        result && typeof result === 'object'
          ? result
          : { path: site.path, summary: 'fix agent failed or returned no object', done: false, diff: '' }
      return { site, fix }
    },

    // Stage 3 — adversarial review of the fix (read-only, fresh context).
    async ({ site, fix }) => {
      // Don't bother reviewing a fix the engineer reported as not done — surface
      // it directly as needing attention.
      if (!fix.done) {
        log(`migrate: ${site.path} not completed by fix agent — flagging`)
        return {
          site,
          fix,
          review: {
            path: site.path,
            approved: false,
            issues: ['fix agent did not complete the migration at this site'],
          },
        }
      }

      const diffText =
        typeof fix.diff === 'string' && fix.diff.trim()
          ? fix.diff.trim()
          : '(the fix agent did not report a diff)'
      const review = await agent(
        [
          'You are an adversarial code reviewer. Be skeptical. Your job is to find',
          'reasons this migration is WRONG, INCOMPLETE, or sloppy at this site —',
          'not to rubber-stamp it.',
          '',
          `Intended migration: ${migration}`,
          `Site: ${site.path}`,
          `Engineer's summary of the change: ${fix.summary}`,
          '',
          'The change was made in a separate worktree you cannot access, so review',
          'it from the diff below — judge the ACTUAL diff, not the summary. If the',
          'diff is empty or absent, the migration was not applied: do not approve.',
          '',
          'Diff of the change:',
          '```diff',
          diffText,
          '```',
          '',
          'Verify the diff actually accomplishes the migration, is complete (no',
          'missed references at this site), and introduces no breakage or leftover',
          'old patterns.',
          '',
          'Approve ONLY if the change is correct and complete. List every concrete',
          'issue you find; an empty issues list with approved=true means it is clean.',
          'Do NOT modify any files.',
        ].join('\n'),
        {
          label: `review:${site.path}`,
          schema: REVIEW_SCHEMA,
          cwd,
          // Read-only adversary: no edits, no shell, no sub-spawning, no web.
          disallowedTools: ['run_terminal_cmd', 'Agent'],
          disableWebSearch: true,
          effort: 'high',
        }
      )

      const normalized =
        review && typeof review === 'object'
          ? review
          : {
              path: site.path,
              approved: false,
              issues: ['reviewer failed or returned no object'],
            }
      return { site, fix, review: normalized }
    }
  )

  // pipeline drops a wholly-failed item to null — filter before aggregating.
  const valid = outcomes.filter(Boolean)
  const dropped = outcomes.length - valid.length
  if (dropped > 0) {
    log(`migrate: ${dropped} site(s) dropped to null (pipeline stage threw) — see logs above`)
  }

  const fixed = []
  const needsAttention = []
  for (const o of valid) {
    const issues = Array.isArray(o.review?.issues) ? o.review.issues : []
    const entry = {
      path: o.site.path,
      why: o.site.why,
      summary: o.fix?.summary ?? null,
      approved: o.review?.approved === true,
      issues,
    }
    if (entry.approved) fixed.push(entry)
    else needsAttention.push(entry)
  }

  // We never merge the worktrees — that's the user's call. Make that loud.
  log(
    `migrate: ${fixed.length} approved, ${needsAttention.length} need attention. ` +
      'Worktrees are LEFT IN PLACE for review — nothing was merged.'
  )
  log(
    'Review each worktree diff (e.g. `git worktree list`, then inspect/merge or ' +
      'discard) before applying.'
  )

  return {
    migration,
    scope: scope || null,
    sites: sites.length,
    fixed,
    needsAttention,
    dropped,
    merged: false,
    note:
      'Edits were made in isolated git worktrees and were NOT merged. Review ' +
      'each worktree diff (`git worktree list`) and merge or discard manually. ' +
      'Sites in needsAttention failed review or were incomplete.',
  }
}

import { isMain, cli } from '../src/runner.mjs'
if (isMain(import.meta.url)) cli(meta, run)
