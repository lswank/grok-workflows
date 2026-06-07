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
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseWithSeparator, looksLikeScopeGlob } from '../src/parse-input.mjs'

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

// --- run ---------------------------------------------------------------------

export async function run(input, ctx = {}) {
  const cwd = ctx.cwd || process.cwd()

  // Split "<migration> -- <scope>" via the shared robust parser.
  // - Uses greedy last " -- " (same regex shape as before).
  // - Custom looksLike:
  //     * if suffix matches the classic glob heuristic ( / . * [ or .start or ** )
  //       then accept (preserves 100% prior behavior for all documented scope
  //       cases, including non-literal globs like "src/**/*.js" that wouldn't
  //       pass a pure file-existence check).
  //     * else fall back to "does this plain path literally exist?" (allows
  //       simple dir names without sigils when they are real on disk).
  // - If the looksLike rejects the suffix (or no -- ), the full input is the
  //   migration description (prose case).
  // This removes the local weaker parseInput while unifying on the root-cause
  // gold standard + necessary customization for globs. See src/parse-input.mjs
  // (and its JSDoc) for the full history of the inconsistency (bug #2) and
  // robustness rationale.
  const parsed = await parseWithSeparator(input, {
    cwd,
    async looksLike(candidateScope, c) {
      if (looksLikeScopeGlob(candidateScope)) {
        return { accept: true, value: candidateScope }
      }
      // Fallback existence for plain (non-glob) names.
      if (!candidateScope) return false
      const resolved = path.isAbsolute(candidateScope) ? candidateScope : path.resolve(c, candidateScope)
      try {
        await fs.access(resolved)
        return { accept: true, value: candidateScope }
      } catch {
        return false
      }
    },
  })
  const migration = parsed.left
  const scope = parsed.accepted && typeof parsed.right === 'string' ? parsed.right : ''
  if (!migration) throw new Error('migrate: empty migration description')

  // Guard: worktree isolation (used for per-site fixes) requires a git repo.
  // Without it the grok --worktree children will fail or create confusing state.
  // Fail fast with an actionable message rather than letting a deep agent error
  // surface later.
  const isGit = await new Promise((resolve) => {
    const c = spawn('git', ['rev-parse', '--is-inside-work-tree'], { cwd, stdio: 'ignore' })
    c.on('close', (code) => resolve(code === 0))
    c.on('error', () => resolve(false))
  })
  if (!isGit) {
    throw new Error(
      'migrate requires the target directory to be a git repository (worktree isolation is used for concurrent edits). ' +
        'Run from within a git repo, or cd into one. (The scout is read-only and could run anywhere, but the fix stage cannot.)'
    )
  }

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
  // stray string (mock without schema awareness) without crashing. _validateShape
  // only checks top-level keys, NOT nested item fields — so a site may arrive
  // missing `why`. Normalize it to a fallback here so neither the fix prompt nor
  // the report ever interpolates the literal string "undefined".
  const sites = Array.isArray(discovery?.sites)
    ? discovery.sites
        .filter((s) => s && typeof s === 'object' && typeof s.path === 'string')
        .map((s) => ({
          path: s.path,
          why: typeof s.why === 'string' && s.why.trim() ? s.why.trim() : '(no reason given)',
        }))
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
      // it directly as needing attention. Use a STRICT boolean check: _validateShape
      // never type-checks `done`, so a model emitting the string "false" would slip
      // past a truthy `!fix.done` test and be wrongly treated as completed.
      if (fix.done !== true) {
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
    'Review each worktree diff (e.g. `git worktree list`); after review run `git worktree prune` to clean up.'
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
      'Edits were made in isolated git worktrees and were NOT merged. ' +
      'Review each worktree diff with `git worktree list` and merge or discard manually. ' +
      'After review, run `git worktree prune` to clean up. ' +
      'Sites in needsAttention failed review or were incomplete.',
  }
}

import { isMain, cli } from '../src/runner.mjs'
if (isMain(import.meta.url)) cli(meta, run)
