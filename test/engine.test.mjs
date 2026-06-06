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
