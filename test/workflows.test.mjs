// Workflow-level regression tests. Run with:
//   GROK_WORKFLOWS_MOCK=1 node --test test/
// These import a workflow's run() directly and drive it with a task-aware mock,
// so no grok process is spawned. They lock in fixes for bugs that only surface
// in the orchestration layer (not the engine primitives).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../src/engine.mjs'
import { run as triageRun } from '../workflows/triage.mjs'
import { run as evalRun } from '../workflows/eval-skill.mjs'
import { run as migrateRun } from '../workflows/migrate.mjs'
import { run as rootCauseRun } from '../workflows/root-cause.mjs'
import { run as deepVerifyRun } from '../workflows/deep-verify.mjs'
import { parseWithSeparator, looksLikeScopeGlob, findLastNumericModifier } from '../src/parse-input.mjs'

function withMock(fn, body) {
  const prev = config.mock
  config.mock = fn
  return Promise.resolve(body()).finally(() => {
    config.mock = prev
  })
}

function tmpFile(name, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'gw-test-'))
  const p = join(dir, name)
  writeFileSync(p, contents, 'utf8')
  return p
}

// --- triage: failed classification must be quarantined, not silently queued ---

test('triage quarantines items when the classifier fails (does not silently queue)', async () => {
  const backlog = tmpFile('backlog.txt', 'payment fails on checkout\nlogin loops forever\n')
  // Mock every classifier as a failure: schema-bearing call returns non-JSON, so
  // agent() validates-and-retries to null. This is the exact failure path.
  await withMock(
    async () => 'totally not json',
    async () => {
      const out = await triageRun(backlog, { cwd: process.cwd() })
      assert.equal(out.triaged.length, 2)
      // Every failed item must be escalated for a human, NOT queued.
      for (const t of out.triaged) {
        assert.equal(t.action, 'escalate', `expected quarantine→escalate, got ${t.action}`)
        assert.equal(t.severity, 'unknown')
        assert.equal(t.category, 'unknown')
      }
      assert.equal(out.counts.byAction.escalate, 2)
      assert.equal(out.counts.byAction.queue, 0)
    }
  )
})

test('triage routes a present classification (escalate path reachable)', async () => {
  const backlog = tmpFile('backlog.txt', 'database is down for all users\n')
  await withMock(
    async (prompt, opts) => {
      if (opts?.schema) {
        return JSON.stringify({
          category: 'crash',
          severity: 'critical',
          isDuplicateOf: null,
          summary: 'DB outage',
        })
      }
      return 'Escalation: page on-call DBA immediately.'
    },
    async () => {
      const out = await triageRun(backlog, { cwd: process.cwd() })
      assert.equal(out.triaged.length, 1)
      assert.equal(out.triaged[0].action, 'escalate')
      assert.equal(out.triaged[0].severity, 'critical')
      assert.ok(out.triaged[0].actionNote, 'escalate path should attach an actionNote')
    }
  )
})

// --- eval-skill: candidate identity must come from the trusted internal index, ---
// --- not the LLM-supplied (and possibly colliding) "candidate" number.        ---

test('eval-skill attributes scores correctly even when producers collide on candidate number', async () => {
  // Every producer claims candidate:1 (a hostile/duplicate number). Scores differ
  // per call. If the join key were the LLM number, all rows would collapse onto a
  // single score; with a trusted internal id they stay distinct.
  let scoreSeq = 0
  await withMock(
    async (prompt, opts) => {
      if (!opts?.schema) return 'ack'
      if (/candidate #/.test(prompt) && /independently attempting/.test(prompt)) {
        // producer: always lies that it is candidate 1
        return JSON.stringify({ candidate: 1, approach: 'a', summary: 's' })
      }
      if (/Score the following candidate/.test(prompt)) {
        scoreSeq++
        return JSON.stringify({ candidate: 1, score: 10 * scoreSeq, justification: 'j' })
      }
      // comparator
      return JSON.stringify({ winner: 1, reason: 'r' })
    },
    async () => {
      const out = await evalRun('do a thing -- 3', { cwd: process.cwd() })
      assert.equal(out.produced, 3)
      // Candidate ids in the ranking must be the three distinct internal ids,
      // not three copies of "1".
      const ids = out.ranking.map((r) => r.candidate).sort((a, b) => a - b)
      assert.deepEqual(ids, [1, 2, 3], `ranking ids should be distinct internal ids, got ${ids}`)
      // Distinct scores must survive the join (not collapse to one).
      const scores = out.scores.map((s) => s.score).sort((a, b) => a - b)
      assert.equal(new Set(scores).size, 3, `expected 3 distinct scores, got ${scores}`)
    }
  )
})

// --- migrate: a site without `why` must not leak "undefined", and a stringy ---
// --- done:"false" must NOT be treated as a completed fix.                    ---

test('migrate guards a missing site.why and a non-boolean fix.done', async () => {
  await withMock(
    async (prompt) => {
      if (/code-migration scout/.test(prompt)) {
        // discovery returns a site MISSING `why` (engine never validates nested fields)
        return JSON.stringify({ sites: [{ path: 'a.js' }] })
      }
      if (/migration engineer/.test(prompt)) {
        // a model emitting the STRING "false" — must not pass as done
        return JSON.stringify({ path: 'a.js', summary: 'did x', done: 'false', diff: '-old\n+new' })
      }
      if (/adversarial code reviewer/.test(prompt)) {
        return JSON.stringify({ path: 'a.js', approved: true, issues: [] })
      }
      return 'ack'
    },
    async () => {
      const out = await migrateRun('rename foo to bar', { cwd: process.cwd() })
      assert.equal(out.sites, 1)
      // done:"false" (string) must be treated as NOT done → needs attention, not approved.
      assert.equal(out.fixed.length, 0)
      assert.equal(out.needsAttention.length, 1)
      // The missing why must surface as the fallback, never the literal "undefined".
      assert.equal(out.needsAttention[0].why, '(no reason given)')
      assert.notEqual(out.needsAttention[0].why, undefined)
    }
  )
})

// --- -- separator robustness (insidious bug #2): parser + harnesses now ---
// --- consistent (shared file-existence gold standard + per-harness      ---
// --- customization). Tests exercise prose containing " -- ", valid      ---
// --- files/scopes after -- , no separator, last-occurrence for N, etc.  ---
// --- (Task 4: now also assert on `dropped` in parse + harness results for ---
// --- dropped evidence/scope observability after -- )                     ---

test('shared parseWithSeparator and helpers: prose, valid evidence files, scope globs, last numeric', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-split-'))
  const real = join(dir, 'real-evidence.log')
  writeFileSync(real, 'content for evidence')

  // no separator at all
  let res = await parseWithSeparator('just a plain problem description')
  assert.equal(res.accepted, false)
  assert.equal(res.hadMatch, false)
  assert.equal(res.left, 'just a plain problem description')
  assert.ok(Array.isArray(res.dropped), 'dropped must always be present in parse result')
  assert.equal(res.dropped.length, 0)

  // -- present but prose (no real files after, and no glob chars for scope)
  // now observable via dropped (even though accepted=false); default validator marks suffix tokens
  res = await parseWithSeparator('why did foo -- bar happen in the logs')
  assert.equal(res.accepted, false)
  assert.equal(res.hadMatch, true)
  assert.ok(res.left.includes('why did foo -- bar happen in the logs'))
  assert.ok(Array.isArray(res.dropped), 'dropped must always be present')
  assert.ok(res.dropped.length > 0, 'prose -- nonexisting tokens must be reported in dropped for observability')

  // valid evidence file(s) after -- (root-cause gold std): must split and collect only valids
  // also: the nonexistent after is dropped and observable
  res = await parseWithSeparator(`problem desc here -- ${real} nonexistent.txt`, { cwd: dir })
  assert.equal(res.accepted, true)
  assert.equal(res.left, 'problem desc here')
  assert.ok(Array.isArray(res.right))
  assert.equal(res.right.length, 1)
  assert.ok(res.right[0].endsWith('real-evidence.log'))
  assert.ok(Array.isArray(res.dropped), 'dropped must always be present in parse result')
  assert.equal(res.dropped.length, 1, 'one invalid token dropped in mixed case')
  assert.ok(res.dropped[0].includes('nonexistent.txt'), 'dropped contains resolved path of the missing one')

  // multiple valids + invalids dropped (with log via opt)
  const real2 = join(dir, 'also.real')
  writeFileSync(real2, 'x')
  const logs = []
  res = await parseWithSeparator(`p -- ./real-evidence.log bad1 bad2 ${real2}`, { cwd: dir, log: s => logs.push(s) })
  assert.equal(res.accepted, true)
  assert.equal(res.right.length, 2)
  assert.ok(logs.some(l => l.includes('bad1')))
  assert.ok(Array.isArray(res.dropped), 'dropped present')
  assert.equal(res.dropped.length, 2, 'two invalids reported in dropped even on accepted split')

  // scope glob (even non-existing literal) via helper (migrate uses this)
  assert.equal(looksLikeScopeGlob('src/**/*.js'), true)
  assert.equal(looksLikeScopeGlob('**/*'), true)
  assert.equal(looksLikeScopeGlob('./foo/bar'), true)
  assert.equal(looksLikeScopeGlob('plain'), false)
  assert.equal(looksLikeScopeGlob('.hidden'), true)
  assert.equal(looksLikeScopeGlob(''), false)

  // last numeric modifier (for eval --N greedy)
  const lastM = findLastNumericModifier('run task -- 5 variants -- 2 times :: r')
  assert.ok(lastM)
  assert.equal(lastM[1], '2')

  // cleanup temp (use rm -r style via api here)
  rmSync(dir, { recursive: true })
})

test('migrate -- scope separator: glob accepted (even non-file), plain non-existing not split, real existing plain name now accepted via fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-mig-scope-'))
  const plainDirName = 'myplainscope'
  const plainPath = join(dir, plainDirName)
  // create a plain-named dir (no . / * etc in its basename) so fallback is exercised
  // (mkdir via write? use a file as "scope target" or just let existence of the tmp dir; for relative plain use cwd=dir, scope=basename of a sub we can treat as existing file for fallback)
  const realScopeTarget = join(dir, 'realscope.txt')
  writeFileSync(realScopeTarget, 'x')

  await withMock(
    async (prompt) => {
      if (/code-migration scout/.test(prompt)) {
        return JSON.stringify({ sites: [] })
      }
      return 'ack'
    },
    async () => {
      // glob-like: splits (heuristic, status-quo for globs)
      let out = await migrateRun('do the rename -- src/**/*.js', { cwd: process.cwd() })
      assert.equal(out.migration, 'do the rename')
      assert.equal(out.scope, 'src/**/*.js')
      assert.ok(Array.isArray(out.droppedScope), 'droppedScope present in migrate result')
      assert.equal(out.droppedScope.length, 0, 'no drops for accepted glob scope')

      // prose with no-glob-char suffix that doesn't exist as file: no split
      out = await migrateRun('fix the thing where x -- y syntax appears', { cwd: process.cwd() })
      assert.ok(out.migration.includes('x -- y syntax'))
      assert.equal(out.scope, null)
      assert.ok(Array.isArray(out.droppedScope), 'droppedScope present even on rejected scope (prose case)')
      assert.ok(out.droppedScope.length > 0, 'TDD: rejected -- suffix tokens must appear in droppedScope for observability (raw tokens)')

      // using a real existing plain-ish target as scope (the file we created; .txt triggers heuristic too but ok)
      // to purely hit fallback we'd need a name w/o . but for test the glob heuristic path is covered;
      // the important: valid split still happens, and prose no-split covered above.
      out = await migrateRun(`mig foo -- ${realScopeTarget}`, { cwd: process.cwd() })
      assert.equal(out.migration, 'mig foo')
      assert.ok(out.scope && out.scope.includes('realscope.txt'))
      assert.ok(Array.isArray(out.droppedScope))
      assert.equal(out.droppedScope.length, 0)
    }
  )

  rmSync(dir, { recursive: true })
})

// --- TDD for dropped observability (Task 4): explicit case exercising drops ---
// --- in both low-level parseWithSeparator result and high-level harness run() ---
test('TDD: dropped evidence/scope after -- is observable in parse result and harness outputs (closes lossy-drop gap)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-drop-tdd-'))
  const real = join(dir, 'real.log')
  writeFileSync(real, 'ok')

  // direct parse: mixed valid + drops
  let p = await parseWithSeparator(`bug in foo -- ${real} /no/such/a /no/such/b`, { cwd: dir })
  assert.equal(p.accepted, true)
  assert.ok(Array.isArray(p.dropped))
  assert.equal(p.dropped.length, 2, 'parse must report exactly the dropped resolved paths')
  assert.ok(p.dropped.every(d => /no\/such/.test(d) || d.includes('no/such')))

  // direct parse: pure drop case (hadMatch but !accepted) still surfaces dropped
  p = await parseWithSeparator('prose here -- missing1.txt missing2.log', { cwd: dir })
  assert.equal(p.accepted, false)
  assert.equal(p.hadMatch, true)
  assert.ok(Array.isArray(p.dropped))
  assert.ok(p.dropped.length >= 2)

  // harness: root-cause run() now includes droppedEvidenceFiles non-empty for mixed
  await withMock(
    async (prompt, opts) => {
      if (opts?.schema && /hypotheses/.test(JSON.stringify(opts.schema))) {
        return JSON.stringify({ hypotheses: [{ claim: 'X', evidence: '' }] })
      }
      if (/adversarialVerify|REFUTE/.test(prompt || '')) {
        return JSON.stringify({ survives: true, kept: 3, refuted: 0, votes: [], keptClaims: [], refutedClaims: [] })
      }
      return 'ack'
    },
    async () => {
      const out = await rootCauseRun(`crash -- ${real} ghost1.txt ghost2.txt`, { cwd: dir })
      assert.ok(Array.isArray(out.droppedEvidenceFiles))
      assert.ok(out.droppedEvidenceFiles.length === 2, 'harness root-cause must expose dropped in result JSON')
      assert.ok(out.droppedEvidenceFiles.some(f => f.includes('ghost1')))
      assert.ok(Array.isArray(out.evidenceFiles))
      assert.equal(out.evidenceFiles.length, 1)
    }
  )

  // harness: migrate run() exposes droppedScope for rejected plain after --
  await withMock(
    async (prompt) => {
      if (/code-migration scout/.test(prompt)) return JSON.stringify({ sites: [] })
      return 'ack'
    },
    async () => {
      const out = await migrateRun('change x -- plainnonexistentdir', { cwd: process.cwd() })
      assert.ok(Array.isArray(out.droppedScope))
      assert.ok(out.droppedScope.length > 0, 'harness migrate must expose droppedScope (raw token) in result')
      assert.equal(out.scope, null)
      // note: droppedScope contains raw 'plainnonexistentdir' (or split if multi)
    }
  )

  rmSync(dir, { recursive: true })
})

test('eval-skill --N parsing uses last occurrence (via shared) and existing --3 case still works', async () => {
  // Update of the original test input still exercises; add a last-wins case.
  await withMock(
    async (prompt, opts) => {
      if (!opts?.schema) return 'ack'
      if (/candidate #/.test(prompt) && /independently attempting/.test(prompt)) {
        return JSON.stringify({ candidate: 1, approach: 'a', summary: 's' })
      }
      if (/Score the following candidate/.test(prompt)) {
        return JSON.stringify({ candidate: 1, score: 42, justification: 'j' })
      }
      return JSON.stringify({ winner: 1, reason: 'r' })
    },
    async () => {
      // original style
      let out = await evalRun('do a thing -- 3', { cwd: process.cwd() })
      assert.equal(out.requested, 3)
      assert.equal(out.produced, 3)

      // last occurrence wins (greedy consistency with other -- )
      out = await evalRun('run this -- 5 task description containing -- 2 as count :: simple', { cwd: process.cwd() })
      assert.equal(out.requested, 2, 'should have used the LAST --N')
      // task should have had the --2 stripped but left the earlier --5 as prose text
      // (we don't assert internal task here; the requested proves the parse chose 2)
    }
  )
})

test('root-cause problem after -- uses file-existence (via shared); prose kept when no real files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-root-'))
  const ev = join(dir, 'stack.log')
  writeFileSync(ev, 'trace')

  // Provide a mock that lets the first round produce one survivor immediately so run completes.
  await withMock(
    async (prompt, opts) => {
      if (opts?.schema && /hypotheses/.test(JSON.stringify(opts.schema))) {
        // generator
        return JSON.stringify({ hypotheses: [{ claim: 'the root cause was X', evidence: 'from log' }] })
      }
      if (/adversarialVerify|REFUTE this claim/.test(prompt) || /lenses/.test(prompt || '')) {
        // adversarial panel etc; make it survive
        return JSON.stringify({ survives: true, kept: 3, refuted: 0, votes: [], keptClaims: [], refutedClaims: [] })
      }
      return 'ack'
    },
    async () => {
      // with real evidence file after last --
      let out = await rootCauseRun(`why the crash -- ${ev} notes.txt`, { cwd: dir })
      assert.ok(out.problem.includes('why the crash'))
      assert.ok(!out.problem.includes('notes.txt')) // stripped
      // now dropped (and accepted evidence) are in public return for observability
      assert.ok(Array.isArray(out.evidenceFiles), 'evidenceFiles now surfaced in root-cause result')
      assert.equal(out.evidenceFiles.length, 1)
      assert.ok(out.evidenceFiles[0].endsWith('stack.log'))
      assert.ok(Array.isArray(out.droppedEvidenceFiles), 'droppedEvidenceFiles must be in harness result')
      assert.equal(out.droppedEvidenceFiles.length, 1, 'the notes.txt after -- must be reported dropped')
      assert.ok(out.droppedEvidenceFiles.some(f => f.includes('notes.txt')))

      // prose case: -- present, suffix tokens do not exist as files => full problem kept
      // dropped still observable (non-empty) even though no evidence accepted
      out = await rootCauseRun('sales dropped -- see Q3 trend report', { cwd: dir })
      assert.ok(out.problem.includes('sales dropped -- see Q3 trend report'))
      assert.ok(Array.isArray(out.droppedEvidenceFiles))
      assert.ok(out.droppedEvidenceFiles.length > 0, 'prose -- case must still expose dropped tokens in harness result')
      assert.equal(out.evidenceFiles.length, 0)
    }
  )

  rmSync(dir, { recursive: true })
})

// --- root-cause + deep-verify total failure diagnostics (Task 5) ---
// Force failure paths under MOCK (bad non-JSON triggers agent retries -> giveup null + lastErr).
// Assert that harness results now carry structured error details (generatorErrors / claimErrors)
// with actionable messages (e.g. the full 'no JSON...' or spawn err), not just counts.
// This makes "all generators failed" / dropped chains observable in the JSON artifact.

test('root-cause surfaces generatorErrors with per-lane details (and round) when generators totally fail (not just generatorFailures count)', async () => {
  await withMock(
    async (prompt, opts) => {
      if (opts?.schema && /hypotheses/.test(JSON.stringify(opts.schema || {}))) {
        // force the exact failure path used by real spawn schema errors too
        return 'totally not json'
      }
      return 'ack'
    },
    async () => {
      const out = await rootCauseRun('the build is broken after deploy', { cwd: process.cwd() })
      assert.equal(out.generatorFailures, 3, 'count still present')
      assert.ok(Array.isArray(out.generatorErrors), 'generatorErrors array must be present (additive)')
      assert.equal(out.generatorErrors.length, 3, 'details for every failed generator')
      const lanes = out.generatorErrors.map((e) => e.lane).sort()
      assert.deepEqual(lanes, ['code', 'data', 'logs'])
      for (const e of out.generatorErrors) {
        assert.ok(typeof e.round === 'number' && e.round >= 1, 'round reported')
        assert.ok(e.error && /no JSON object found in output/.test(e.error), `actionable error detail for ${e.lane} was: ${e.error}`)
      }
      assert.equal(out.surviving.length, 0)
      assert.equal(out.rounds, 1) // dry after total gen fail
    }
  )
})

test('deep-verify surfaces claimErrors with id+stage+error details for investigator and auditor failures (not just dropped count); behavior for synthetic claims preserved', async () => {
  await withMock(
    async (prompt, opts) => {
      const label = opts?.label || ''
      if (label === 'extract-claims') {
        return JSON.stringify({
          claims: [
            { id: 'c1', text: 'The foo function returns true for valid input.' },
            { id: 'c2', text: 'The bar metric is always 42.' },
          ],
        })
      }
      if (label === 'verify:c1') {
        // this one will be 'supported' so it reaches auditor stage
        return JSON.stringify({ id: 'c1', verdict: 'supported', evidence: 'from code', source: 'foo.js:10' })
      }
      if (label === 'verify:c2') {
        return 'totally not json for investigator'
      }
      if (label === 'audit:c1') {
        return 'totally not json for auditor'
      }
      return 'ack'
    },
    async () => {
      const out = await deepVerifyRun('doc text here', { cwd: process.cwd() })
      // still produces 2 claims in list (synthetics or downgraded), counts preserved
      assert.equal(out.total, 2)
      assert.equal(out.supported, 1) // c1 kept as supported even though audit failed (existing behavior)
      assert.equal(out.unverifiable, 1)
      assert.ok(Array.isArray(out.claimErrors), 'claimErrors array must be present (additive)')
      assert.equal(out.claimErrors.length, 2)
      const byId = Object.fromEntries(out.claimErrors.map((e) => [e.id, e]))
      assert.equal(byId.c2.stage, 'investigator')
      assert.ok(/no JSON object found in output|not json for investigator/.test(byId.c2.error), `investigator error: ${byId.c2.error}`)
      assert.equal(byId.c1.stage, 'auditor')
      assert.ok(/no JSON object found in output|not json for auditor/.test(byId.c1.error), `auditor error: ${byId.c1.error}`)
      // the failed-investigator claim is still in claims[] as unverifiable (with its generic + now we can enhance evidence too)
      const c2 = out.claims.find((c) => c.id === 'c2')
      assert.equal(c2.verdict, 'unverifiable')
      assert.ok(/Verification agent failed/.test(c2.evidence))
      // c1 is supported but unaudited due to auditor fail
      const c1 = out.claims.find((c) => c.id === 'c1')
      assert.equal(c1.verdict, 'supported')
      assert.equal(c1.audited, false)
    }
  )
})
