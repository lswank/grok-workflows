// Engine tests. Run with: GROK_WORKFLOWS_MOCK=1 node --test test/
// All tests use mock mode — no grok process is spawned, so they're free and
// deterministic.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  agent,
  parallel,
  pipeline,
  tournament,
  adversarialVerify,
  fanOutSynthesize,
  classifyAndRoute,
  generateAndFilter,
  loopUntilDone,
  _extractJson,
  _validateDeep,
  config,
  setVerbose,
} from '../src/engine.mjs'

// Helper: install a task-aware mock for the duration of a test.
function withMock(fn, body) {
  const prev = config.mock
  config.mock = fn
  return Promise.resolve(body()).finally(() => {
    config.mock = prev
  })
}

test('agent() returns text when no schema', async () => {
  await withMock(
    async (p) => `seen:${p.slice(0, 5)}`,
    async () => {
      const out = await agent('hello world')
      assert.equal(typeof out, 'string')
      assert.match(out, /^seen:/)
    }
  )
})

test('agent() returns parsed object when given a schema', async () => {
  await withMock(
    async () => JSON.stringify({ color: 'red', extra: 1 }),
    async () => {
      const out = await agent('pick a color', {
        schema: { type: 'object', required: ['color'], properties: { color: { type: 'string' } } },
      })
      assert.deepEqual(out, { color: 'red', extra: 1 })
    }
  )
})

test('agent() retries then returns null when schema never satisfied', async () => {
  await withMock(
    async () => 'not json at all',
    async () => {
      const out = await agent('x', {
        schema: { type: 'object', required: ['a'] },
        retries: 1,
      })
      assert.equal(out, null)
    }
  )
})

test('agent() tolerates ```json fenced output', async () => {
  await withMock(
    async () => '```json\n{"a":1}\n```',
    async () => {
      const out = await agent('x', { schema: { type: 'object', required: ['a'] } })
      assert.deepEqual(out, { a: 1 })
    }
  )
})

test('parallel() preserves order and turns failures into null', async () => {
  await withMock(
    async (p) => p,
    async () => {
      const out = await parallel([
        () => agent('a'),
        () => Promise.reject(new Error('boom')),
        () => agent('c'),
      ])
      assert.equal(out.length, 3)
      assert.equal(out[1], null)
      assert.ok(out[0].includes('a'))
      assert.ok(out[2].includes('c'))
    }
  )
})

test('pipeline() threads stages and exposes originalItem + index', async () => {
  const out = await pipeline(
    [10, 20],
    async (n) => n + 1,
    async (prev, item, index) => ({ prev, item, index })
  )
  assert.deepEqual(out, [
    { prev: 11, item: 10, index: 0 },
    { prev: 21, item: 20, index: 1 },
  ])
})

test('pipeline() drops a throwing item to null without killing others', async () => {
  const out = await pipeline(
    [1, 2, 3],
    async (n) => {
      if (n === 2) throw new Error('nope')
      return n
    },
    async (n) => n * 10
  )
  assert.deepEqual(out, [10, null, 30])
})

test('tournament() returns a single winner from comparator', async () => {
  // Comparator: bigger number wins.
  const { winner } = await tournament([3, 1, 4, 1, 5, 9, 2, 6], async (a, b) => (a > b ? a : b))
  assert.equal(winner, 9)
})

test('tournament() handles odd counts (byes)', async () => {
  const { winner } = await tournament([1, 2, 3], async (a, b) => (a > b ? a : b))
  assert.equal(winner, 3)
})

test('adversarialVerify() survives when majority do not refute', async () => {
  let i = 0
  await withMock(
    // 2 keep, 1 refute => survives
    async () => JSON.stringify({ refuted: i++ === 0, reason: 'r' }),
    async () => {
      const v = await adversarialVerify('claim', { voters: 3 })
      assert.equal(v.survives, true)
      assert.equal(v.kept, 2)
      assert.equal(v.refuted, 1)
    }
  )
})

test('fanOutSynthesize() runs worker per item then synthesizes', async () => {
  const result = await fanOutSynthesize(
    [1, 2, 3],
    async (n) => n * 2,
    async (results) => results.reduce((a, b) => a + b, 0)
  )
  assert.equal(result, 12)
})

test('classifyAndRoute() routes to the classified handler', async () => {
  await withMock(
    async () => JSON.stringify({ label: 'big' }),
    async () => {
      const out = await classifyAndRoute('input', {
        big: async () => 'went big',
        small: async () => 'went small',
        default: async () => 'default',
      })
      assert.equal(out.label, 'big')
      assert.equal(out.result, 'went big')
    }
  )
})

test('classifyAndRoute() falls back to default on unknown label', async () => {
  await withMock(
    async () => JSON.stringify({ label: 'unknown-thing' }),
    async () => {
      const out = await classifyAndRoute('input', {
        a: async () => 'a',
        default: async () => 'fellback',
      })
      assert.equal(out.label, 'default')
      assert.equal(out.result, 'fellback')
    }
  )
})

test('generateAndFilter() dedupes and keeps only passing candidates', async () => {
  const kept = await generateAndFilter(
    async () => [{ id: 1 }, { id: 1 }, { id: 2 }, { id: 3 }],
    async (c) => c.id !== 2,
    { key: (c) => String(c.id) }
  )
  assert.deepEqual(
    kept.map((c) => c.id),
    [1, 3]
  )
})

test('loopUntilDone() stops on dry streak', async () => {
  let round = 0
  const acc = await loopUntilDone(
    async () => {
      round++
      // round 1 yields items, then nothing
      return round === 1 ? { items: ['a', 'b'] } : { items: [] }
    },
    { dryStreak: 2, maxRounds: 10 }
  )
  assert.deepEqual(acc, ['a', 'b'])
  assert.equal(round, 3) // round1 (items) + 2 dry rounds
})

test('loopUntilDone() stops on done:true', async () => {
  const acc = await loopUntilDone(
    async (r) => (r === 0 ? { items: ['x'] } : { done: true }),
    { maxRounds: 10 }
  )
  assert.deepEqual(acc, ['x'])
})

test('loopUntilDone() accumulates items returned alongside done:true', async () => {
  // A round may signal completion AND hand back its final items in one return.
  // Those items must not be dropped.
  const acc = await loopUntilDone(
    async (r) => (r === 0 ? { items: ['a'] } : { items: ['b'], done: true }),
    { maxRounds: 10 }
  )
  assert.deepEqual(acc, ['a', 'b'])
})

test('loopUntilDone() treats a bare truthy return as new work (resets dry streak)', async () => {
  // The JSDoc promises "truthy 'new work' resets the dry streak". A roundFn that
  // signals progress by returning a bare truthy value (not the {items}/array form)
  // must NOT be mistaken for a dry round.
  let round = 0
  const acc = await loopUntilDone(
    async () => {
      round++
      return 'found something'
    },
    { dryStreak: 2, maxRounds: 4 }
  )
  assert.equal(round, 4) // never dry => runs to maxRounds, not stopped at dryStreak
  assert.deepEqual(acc, []) // a bare value contributes no items, only resets the streak
})

test('loopUntilDone() treats {found:n} (extra-keyed object) as new work', async () => {
  let round = 0
  await loopUntilDone(
    async () => {
      round++
      return { found: 3 }
    },
    { dryStreak: 2, maxRounds: 4 }
  )
  assert.equal(round, 4)
})

test('loopUntilDone() still treats an empty array / {items:[]} as a dry round', async () => {
  let arrRounds = 0
  await loopUntilDone(
    async () => {
      arrRounds++
      return []
    },
    { dryStreak: 2, maxRounds: 10 }
  )
  assert.equal(arrRounds, 2) // empty array is "no new items" => dry streak still fires

  let objRounds = 0
  await loopUntilDone(
    async () => {
      objRounds++
      return { items: [] }
    },
    { dryStreak: 2, maxRounds: 10 }
  )
  assert.equal(objRounds, 2)
})

// --- deep schema validation (_validateDeep, opt-in strict mode) -------------

test('_validateDeep accepts a well-typed nested object', () => {
  const schema = {
    type: 'object',
    required: ['name', 'tags'],
    properties: {
      name: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      meta: {
        type: 'object',
        required: ['count'],
        properties: { count: { type: 'integer' } },
      },
    },
  }
  // Should not throw.
  _validateDeep({ name: 'x', tags: ['a', 'b'], meta: { count: 3 }, extra: 1 }, schema)
})

test('_validateDeep rejects a wrong primitive type with a JSON path', () => {
  const schema = { type: 'object', required: ['n'], properties: { n: { type: 'number' } } }
  assert.throws(() => _validateDeep({ n: 'not a number' }, schema), /\$\.n/)
})

test('_validateDeep enforces enum membership', () => {
  const schema = {
    type: 'object',
    required: ['winner'],
    properties: { winner: { enum: ['A', 'B'] } },
  }
  _validateDeep({ winner: 'A' }, schema) // ok
  assert.throws(() => _validateDeep({ winner: 'C' }, schema), /enum/)
})

test('_validateDeep validates each array item against items schema', () => {
  const schema = {
    type: 'object',
    required: ['rows'],
    properties: {
      rows: {
        type: 'array',
        items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      },
    },
  }
  _validateDeep({ rows: [{ id: 'a' }, { id: 'b' }] }, schema) // ok
  // second item has a numeric id → should point at rows[1].id
  assert.throws(() => _validateDeep({ rows: [{ id: 'a' }, { id: 7 }] }, schema), /rows\[1\]\.id/)
})

test('_validateDeep enforces nested required keys', () => {
  const schema = {
    type: 'object',
    required: ['meta'],
    properties: {
      meta: { type: 'object', required: ['count'], properties: { count: { type: 'number' } } },
    },
  }
  assert.throws(() => _validateDeep({ meta: {} }, schema), /missing required keys: count/)
})

test('_validateDeep supports union types like ["string","null"]', () => {
  const schema = {
    type: 'object',
    required: ['ref'],
    properties: { ref: { type: ['string', 'null'] } },
  }
  _validateDeep({ ref: null }, schema) // ok
  _validateDeep({ ref: 'x' }, schema) // ok
  assert.throws(() => _validateDeep({ ref: 5 }, schema), /ref/)
})

test('agent({strictSchema}) retries to null when a nested type is wrong', async () => {
  await withMock(
    async () => JSON.stringify({ winner: 'C', reason: 'r' }), // 'C' violates enum
    async () => {
      const schema = {
        type: 'object',
        required: ['winner', 'reason'],
        properties: { winner: { enum: ['A', 'B'] }, reason: { type: 'string' } },
      }
      // Lenient (default): passes through despite the bad enum value.
      const lenient = await agent('x', { schema, retries: 0 })
      assert.deepEqual(lenient, { winner: 'C', reason: 'r' })
      // Strict: the bad enum is rejected, retried, and ultimately null.
      const strict = await agent('x', { schema, strictSchema: true, retries: 1 })
      assert.equal(strict, null)
    }
  )
})

test('agent({strictSchema}) returns the object when it conforms', async () => {
  await withMock(
    async () => JSON.stringify({ winner: 'A', reason: 'r' }),
    async () => {
      const schema = {
        type: 'object',
        required: ['winner', 'reason'],
        properties: { winner: { enum: ['A', 'B'] }, reason: { type: 'string' } },
      }
      const out = await agent('x', { schema, strictSchema: true })
      assert.deepEqual(out, { winner: 'A', reason: 'r' })
    }
  )
})

test('_extractJson handles bare, fenced, and embedded JSON', () => {
  assert.deepEqual(_extractJson('{"a":1}'), { a: 1 })
  assert.deepEqual(_extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(_extractJson('here you go: {"a":[1,2]} done'), { a: [1, 2] })
  assert.equal(_extractJson('no json here'), undefined)
})

test('_extractJson returns the value that appears first in the text', () => {
  // An array preceding an object must not be shadowed by a brace-first preference.
  assert.deepEqual(_extractJson('[1,2,3] {"x":1}'), [1, 2, 3])
  assert.deepEqual(_extractJson('{"x":1} [1,2,3]'), { x: 1 })
})

test('_extractJson skips a malformed leading span for a later valid one', () => {
  // A balanced-but-invalid object first, a valid array second.
  assert.deepEqual(_extractJson('prefix {not json} suffix [1,2]'), [1, 2])
})

// --- additional _extractJson coverage for LLM-like output (template lits,
//     comments, inner braces in strings, mixed quotes, leading prose, deep nests)
test('_extractJson handles JSON inside template literals (backticks) as first span', () => {
  // Opener inside `...` appears first in text; its balanced span parses, so extracted.
  assert.deepEqual(_extractJson('prose ` { "nested": 1 } ` and later'), { nested: 1 })
})

test('_extractJson skips JSON-like in // comments when the span does not parse as valid JSON', () => {
  // { unquotedkey: inside comment produces invalid JSON span (unquoted key); skipped for later valid.
  // (Avoid [ ] in the bad span, as a bare [1,2] would be a valid array extracted first.)
  assert.deepEqual(_extractJson('// comment with { unquoted: "foo bar" }\n{"real": true}'), { real: true })
})

test('_extractJson correctly handles { [ inside JSON string values (inStr/esc protection)', () => {
  // In-string { [ must not affect depth; the outer object must balance and parse.
  assert.deepEqual(
    _extractJson('{"msg": "contains { and [ literally", "ok":1}'),
    { msg: 'contains { and [ literally', ok: 1 }
  )
})

test('_extractJson handles mix of backticks and double-quotes', () => {
  // Backtick prose before a real object; inner " with ` inside string is protected.
  assert.deepEqual(_extractJson('`code` {"a": "has ` backtick inside string"}'), { a: 'has ` backtick inside string' })
})

test('_extractJson prefers later valid JSON when backtick prose has opener that does not close to a prior valid value', () => {
  // The { inside the unclosed-looking backtick template does not produce a yielding complete span before the real JSON.
  assert.deepEqual(_extractJson('see `template with { "incomplete" ` then real: {"b":2}'), { b: 2 })
})

test('_extractJson extracts deeply nested array/object structures that balance correctly', () => {
  const deep = '{"a":{"b":[{"c": [1, {"d": {"e":3}}]}]}}'
  assert.deepEqual(_extractJson('wrapped: ' + deep + ' end'), JSON.parse(deep))
})

test('_extractJson ignores single-quote chars (they are not string delimiters for balancing)', () => {
  // ' chars do not flip inStr; a later valid double-quoted JSON wins.
  assert.deepEqual(_extractJson("it's {'not': 'json'} but {\"yes\":1}"), { yes: 1 })
})

// --- spawn failure truncation behavior (exercises real child process error path) ---

test('agent() preserves full long child stderr on spawn failure (code != 0) without aggressive ~300-char truncate', async () => {
  // This test forces the *non-mock* spawn path (bypassing GROK_WORKFLOWS_MOCK)
  // by clearing config.mock and pointing config.bin at /bin/sh.
  // /bin/sh -p <long-prompt> ... will exit non-zero and put a long "file name"
  // (our marker simulating real tool/permission errors like "Agent building failed...
  // auto_backg...") into stderr. (sh treats the -p argument as the script "filename"
  // for $0/error reporting and emits the full attempted name verbatim in the
  // "File name too long" / "No such file" stderr diagnostic, even for long args.)
  // We assert the full detail reaches the logged "fail ..." / "giveup ..." messages
  // (which is where harnesses and users see it).
  const prevMock = config.mock
  const prevBin = config.bin
  setVerbose(true)

  // Build a long distinctive "error" that exceeds what truncate(..., 300) would keep.
  // The tail after ~300 chars must survive in the final Error/log for the test to pass.
  const longMarker =
    'Agent building failed, please check your config ... tool error: Requirements unsatisfied: [RequirementError { tool: "GrokBuild:run_terminal_cmd", message: "' +
    'auto_backg'.repeat(35) +
    'more error context that would be lost at the old 300 limit' +
    'Z'.repeat(90) +
    '_TAIL_OF_LONG_ERROR' +
    '"}]'

  config.mock = null
  config.bin = '/bin/sh'

  let captured = ''
  const origWrite = process.stderr.write
  process.stderr.write = (chunk) => {
    captured += typeof chunk === 'string' ? chunk : String(chunk)
    return true
  }

  let result = null
  let syncThrown = null
  try {
    result = await agent(longMarker, { retries: 0, label: 'trunc-test' })
  } catch (e) {
    syncThrown = e
  } finally {
    process.stderr.write = origWrite
    config.mock = prevMock
    config.bin = prevBin
    setVerbose(false)
  }

  // Public contract: permanent failure after retries (here 0) yields null; diagnostics via logs.
  assert.equal(result, null)
  assert.equal(syncThrown, null)

  // The "▸ fail ..." and "▸ giveup ..." (with ANSI) must be present and carry the *full* detail.
  assert.ok(
    /fail   trunc-test[: ]/.test(captured),
    'expected "fail   trunc-test:" log line from _runAgentWithRetries'
  )
  assert.ok(
    /giveup trunc-test:/.test(captured),
    'expected "giveup trunc-test:" log line from _runAgentWithRetries'
  )

  // Critical: the unique tail that lives past byte ~300 in the child detail must be present.
  // This fails on current code (truncation hides it) and passes after the fix.
  assert.ok(
    captured.includes('_TAIL_OF_LONG_ERROR'),
    'long child error detail tail must appear verbatim in logged fail/giveup message (no artificial truncation)'
  )

  // Also assert the fail message line itself is substantially longer than a truncated one would be.
  const failLineMatch = captured.match(/fail   trunc-test:[^\n]*/)
  if (failLineMatch) {
    // Threshold >380 accounts for log prefix ("fail   trunc-test: grok exited N: /bin/sh: " ~35 chars)
    // + child detail from sh error (~450+ for our marker). Old truncate(300) on detail would
    // produce an err.message ~<330 chars total, so fail log line <<380; >380 proves full preservation.
    assert.ok(
      failLineMatch[0].length > 380,
      `fail log line should contain untruncated long detail (len=${failLineMatch[0].length})`
    )
  }

  // (Removed unreachable `if (syncThrown) { ... }` defensive block here: per agent() contract,
  // _runAgentWithRetries always catches and returns null on permanent failure; the local catch
  // only exists for capture safety around the await. syncThrown is asserted null above.)
})

// --- unparseable output path coverage (exit 0 + long bad stdout, the second error path) ---

test('agent() preserves full long stdout on unparseable output (exit 0, bad JSON) without aggressive ~200-char truncate', async () => {
  // This exercises the *second* failure path updated in the original fix:
  // child exits 0 (success for spawn), but stdout is not valid JSON and _extractJson
  // finds no object (no balanced { or [ spans that parse), so we throw
  // `unparseable grok output: ${full stdout}` (no longer truncated at 200).
  // The error reaches the same fail/giveup logs.
  //
  // Producer (non-mock, self-contained): /bin/echo always exits 0 and prints its
  // entire argv to stdout. We pass a long plain-text (no JSON chars) prompt as
  // the -p value; echo's stdout will contain the full long marker + tail.
  // _extractJson will fail (no { [ in output), hitting the unparseable path with
  // the raw long stdout in the Error (and thus the logs).
  const prevMock = config.mock
  const prevBin = config.bin
  setVerbose(true)

  // Long non-JSON payload (plain alphanum + underscores) so extract fails for sure.
  // Length >> 200 so old truncate(stdout, 200) would drop the tail; full now keeps it.
  const longMarker = 'notjson' + 'X'.repeat(450) + '_UNPARSE_TAIL_OF_LONG_ERROR'

  config.mock = null
  config.bin = '/bin/echo'

  let captured = ''
  const origWrite = process.stderr.write
  process.stderr.write = (chunk) => {
    captured += typeof chunk === 'string' ? chunk : String(chunk)
    return true
  }

  let result = null
  let syncThrown = null
  try {
    result = await agent(longMarker, { retries: 0, label: 'unparse-test' })
  } catch (e) {
    syncThrown = e
  } finally {
    process.stderr.write = origWrite
    config.mock = prevMock
    config.bin = prevBin
    setVerbose(false)
  }

  // Public contract: permanent failure yields null; diagnostics via logs only.
  assert.equal(result, null)
  assert.equal(syncThrown, null)

  // fail/giveup logs must be emitted (with the unparseable error containing full stdout).
  assert.ok(
    /fail   unparse-test[: ]/.test(captured),
    'expected "fail   unparse-test:" log line from _runAgentWithRetries for unparseable path'
  )
  assert.ok(
    /giveup unparse-test:/.test(captured),
    'expected "giveup unparse-test:" log line from _runAgentWithRetries for unparseable path'
  )

  // Critical assertion for the unparseable path: the tail past the old 200-char limit
  // on stdout must be present verbatim (would have been cut pre-fix).
  assert.ok(
    captured.includes('_UNPARSE_TAIL_OF_LONG_ERROR'),
    'long unparseable stdout tail must appear verbatim in logged fail/giveup (full stdout preserved, no 200 truncate)'
  )

  // Length check proves it is not the truncated version.
  const failLineMatch = captured.match(/fail   unparse-test:[^\n]*/)
  if (failLineMatch) {
    // Threshold >500: prefix + "unparseable grok output: -p notjsonXXX..." (~20) + 484-char marker
    // + " --output-format json --yolo\n" (~30) + ANSI. Old truncate(200) on stdout would keep
    // err.message < ~230 chars total → fail log line much shorter than 500.
    assert.ok(
      failLineMatch[0].length > 500,
      `fail log line should contain untruncated long stdout detail (len=${failLineMatch[0].length})`
    )
  }
})
