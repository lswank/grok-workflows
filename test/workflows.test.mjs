// Workflow-level regression tests. Run with:
//   GROK_WORKFLOWS_MOCK=1 node --test test/
// These import a workflow's run() directly and drive it with a task-aware mock,
// so no grok process is spawned. They lock in fixes for bugs that only surface
// in the orchestration layer (not the engine primitives).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../src/engine.mjs'
import { run as triageRun } from '../workflows/triage.mjs'
import { run as evalRun } from '../workflows/eval-skill.mjs'
import { run as migrateRun } from '../workflows/migrate.mjs'

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
