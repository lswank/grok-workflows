// grok-workflows — a dynamic-workflow engine for Grok Code (the `grok` CLI).
//
// This is the analog of Claude Code's built-in Workflow tool, built on top of
// Grok's headless mode. The atomic primitive is agent(): it shells out to
//   grok -p <prompt> --output-format json --yolo [flags]
// and returns the agent's final text (or a validated object, with a schema).
// Everything else — parallel(), pipeline(), tournament(), loopUntilDone(), and
// the higher-order patterns — is plain JS orchestration around that primitive.
//
// Why a separate process per agent? The same reasons the Claude Code team gives
// for dynamic workflows: each subagent gets its own fresh context window, which
// structurally defeats agentic laziness, self-preferential bias, and goal drift
// on long, parallel, adversarial tasks.
//
// Runtime: Node >= 18 (uses node:child_process, structuredClone). No deps.

import { spawn } from 'node:child_process'
import os from 'node:os'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const config = {
  // Path to the grok binary. Override with GROK_BIN.
  bin: process.env.GROK_BIN || 'grok',
  // Default model for agents that don't specify one. null => grok's own default.
  defaultModel: process.env.GROK_WORKFLOWS_MODEL || null,
  // Max agents running concurrently. Mirrors Claude Code's min(16, cores-2) cap,
  // but defaults more conservatively so a laptop doesn't melt. Override with
  // GROK_WORKFLOWS_CONCURRENCY. Sanitized to >=1.
  concurrency: (() => {
    const n = Number(process.env.GROK_WORKFLOWS_CONCURRENCY)
    const def = Math.max(2, Math.min(8, (os.cpus()?.length || 4) - 2))
    return Number.isFinite(n) && n >= 1 ? n : def
  })(),
  // Per-agent retry attempts on transient failure / schema-parse failure. Sanitized >=0.
  retries: (() => {
    const n = Number(process.env.GROK_WORKFLOWS_RETRIES ?? 2)
    return Number.isFinite(n) && n >= 0 ? n : 2
  })(),
  // Per-agent timeout in ms (0 = no timeout). Sanitized >=0.
  timeoutMs: (() => {
    const n = Number(process.env.GROK_WORKFLOWS_TIMEOUT_MS)
    return Number.isFinite(n) && n >= 0 ? n : 0
  })(),
  // Mock mode: don't spawn grok at all. Set GROK_WORKFLOWS_MOCK=1 for free,
  // deterministic tests, or assign config.mock to a function (prompt, opts) => string.
  mock: process.env.GROK_WORKFLOWS_MOCK === '1' ? defaultMock : null,
  // Hard ceiling on total agent() invocations per process — a runaway-loop
  // backstop, set far above any real workflow. Sanitized >=1.
  maxTotalAgents: (() => {
    const n = Number(process.env.GROK_WORKFLOWS_MAX_AGENTS)
    return Number.isFinite(n) && n >= 1 ? n : 1000
  })(),
  // When true, schema'd agents are validated with the deep validator (nested
  // types, enums, array items) instead of the lightweight top-level check. Can
  // also be set per-call via opts.strictSchema. Off by default to preserve the
  // lenient instruct-parse-retry contract. See coerceBoolean() and SPEC.md
  // pitfalls section for why the default is lenient and how to defend.
  strictSchema: process.env.GROK_WORKFLOWS_STRICT_SCHEMA === '1',
}

let _totalAgents = 0

// Per-label last error from agent() giveups (for harnesses to surface actionable
// diagnostics in their result JSON when generators/claims/etc fail permanently).
// Consumed by getLastAgentError(). Cleared on success or retrieval.
const _agentFailureErrors = new Map()

// Track pipeline (and parallel) drop errors so harnesses can include details for
// actual dropped-to-null items (beyond just agent() nulls). Cleared on retrieval.
const _pipelineDropErrors = []
const _parallelTaskErrors = []

function isCapError(err) {
  return !!(err && /cap reached/i.test(String(err.message || err)))
}

// ---------------------------------------------------------------------------
// Concurrency limiter (a tiny semaphore; no external deps)
// ---------------------------------------------------------------------------

function makeLimiter(max) {
  let active = 0
  const queue = []
  const next = () => {
    if (active >= max || queue.length === 0) return
    active++
    const { fn, resolve, reject } = queue.shift()
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--
        next()
      })
  }
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject })
      next()
    })
}

let _limit = makeLimiter(config.concurrency)
/** Reset the global concurrency limit (call after changing config.concurrency). */
export function setConcurrency(n) {
  const safe = Number.isFinite(n) && n >= 1 ? n : 1
  config.concurrency = safe
  _limit = makeLimiter(safe)
}

// ---------------------------------------------------------------------------
// Logging — a single narrator line, prefixed so it's grep-able and never
// collides with an agent's own stdout (which we capture, not print).
// ---------------------------------------------------------------------------

let _verbose = process.env.GROK_WORKFLOWS_QUIET !== '1'
export function setVerbose(v) {
  _verbose = v
}
export function log(message) {
  if (_verbose) process.stderr.write(`\x1b[2m▸ ${message}\x1b[0m\n`)
}

// ---------------------------------------------------------------------------
// The agent() primitive
// ---------------------------------------------------------------------------

/**
 * Spawn one Grok headless agent and return its result.
 *
 * @param {string} prompt  The task for the agent.
 * @param {object} [opts]
 * @param {string} [opts.model]            Model id (e.g. "grok-build").
 * @param {string} [opts.effort]           low | medium | high | xhigh | max.
 * @param {string} [opts.reasoningEffort]  Reasoning effort for reasoning models.
 * @param {object} [opts.schema]           JSON Schema. When set, the agent is
 *                                         instructed to emit ONLY matching JSON,
 *                                         and the parsed+validated object is
 *                                         returned instead of the raw text.
 * @param {boolean} [opts.strictSchema]    Validate with the deep validator
 *                                         (nested types, enums, array items)
 *                                         rather than the lightweight top-level
 *                                         check. Defaults to config.strictSchema.
 * @param {string} [opts.label]            Display label for logs.
 * @param {'worktree'} [opts.isolation]    Run in a fresh git worktree.
 * @param {string[]} [opts.tools]          Allowlist of built-in tools.
 * @param {string[]} [opts.disallowedTools] Denylist (supports "Agent", "Agent(explore)").
 * @param {number} [opts.maxTurns]         Max agentic turns.
 * @param {string} [opts.rules]            Extra system-prompt rules (guardrails).
 * @param {string} [opts.systemPromptOverride] Replace the agent's system prompt.
 * @param {string} [opts.cwd]              Working directory.
 * @param {boolean} [opts.noProjectRoot]   Don't walk up to a git root; use cwd only.
 * @param {string} [opts.sessionId]        Named session (-s) for multi-turn reuse.
 * @param {string[]} [opts.allow]          Permission allow rules.
 * @param {string[]} [opts.deny]           Permission deny rules.
 * @param {boolean} [opts.disableWebSearch] Turn off web search/fetch.
 * @param {number} [opts.retries]          Override config.retries for this call.
 * @returns {Promise<string|object|null>}  Text, or validated object with schema,
 *                                         or null if the agent failed after retries.
 */
export async function agent(prompt, opts = {}) {
  if (_totalAgents >= config.maxTotalAgents) {
    throw new Error(
      `agent() cap reached (${config.maxTotalAgents}). Raise GROK_WORKFLOWS_MAX_AGENTS if intentional.`
    )
  }
  _totalAgents++
  const label = opts.label || truncate(prompt, 48)
  return _limit(() => _runAgentWithRetries(prompt, opts, label))
}

async function _runAgentWithRetries(prompt, opts, label) {
  const retries = opts.retries ?? config.retries
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    const tag = attempt ? `${label} (retry ${attempt})` : label
    try {
      log(`spawn  ${tag}`)
      const text = await _runOneAgent(prompt, opts)
      if (opts.schema) {
        const parsed = _extractJson(text)
        if (parsed === undefined) throw new Error('no JSON object found in output')
        // Default validation is intentionally lightweight (top-level keys only).
        // Opt into full nested/type/enum enforcement per-call (opts.strictSchema)
        // or globally (config.strictSchema). A violation throws → retries → null.
        if (opts.strictSchema ?? config.strictSchema) _validateDeep(parsed, opts.schema)
        else _validateShape(parsed, opts.schema)
        _agentFailureErrors.delete(label)
        log(`done   ${tag}`)
        return parsed
      }
      _agentFailureErrors.delete(label)
      log(`done   ${tag}`)
      return text
    } catch (err) {
      lastErr = err
      log(`fail   ${tag}: ${err.message}`)
    }
  }
  const errMsg = lastErr?.message || 'unknown error'
  _agentFailureErrors.set(label, errMsg)
  log(`giveup ${label}: ${errMsg}`)
  return null
}

async function _runOneAgent(prompt, opts) {
  const finalPrompt = opts.schema ? _withSchemaInstruction(prompt, opts.schema) : prompt

  // Mock path — no subprocess. Used by the test suite and for dry runs.
  const mock = opts.mock ?? config.mock
  if (mock) {
    const out = await mock(finalPrompt, opts)
    return typeof out === 'string' ? out : JSON.stringify(out)
  }

  const args = _buildArgs(finalPrompt, opts)
  const { stdout, stderr, code, signal } = await _spawn(config.bin, args, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? config.timeoutMs,
  })
  if (code !== 0) {
    // grok reports real errors on stderr; fall back to stdout only if stderr is
    // empty. Surfacing stderr makes a failed spawn actually debuggable.
    const detail = (stderr && stderr.trim()) || (stdout && stdout.trim()) || '(no output)'
    throw new Error(
      `grok exited ${code}${signal ? ` (signal ${signal})` : ''}: ${truncate(detail, 300)}`
    )
  }
  // --output-format json => a single JSON object: {text, stopReason, sessionId, requestId}
  let obj
  try {
    obj = JSON.parse(stdout)
  } catch {
    // If grok ever prints stray lines, salvage the last JSON object on stdout.
    obj = _extractJson(stdout)
    if (obj === undefined) throw new Error(`unparseable grok output: ${truncate(stdout, 200)}`)
  }
  if (obj.stopReason && obj.stopReason !== 'EndTurn' && obj.stopReason !== 'end_turn') {
    log(`note   stopReason=${obj.stopReason}`)
  }
  return obj.text ?? ''
}

/** Translate opts into grok CLI arguments. */
function _buildArgs(prompt, opts) {
  const args = ['-p', prompt, '--output-format', 'json', '--yolo']
  const model = opts.model ?? config.defaultModel
  if (model) args.push('-m', model)
  if (opts.effort) args.push('--effort', opts.effort)
  if (opts.reasoningEffort) args.push('--reasoning-effort', opts.reasoningEffort)
  if (opts.maxTurns) args.push('--max-turns', String(opts.maxTurns))
  if (opts.isolation === 'worktree') args.push('--worktree')
  if (opts.tools?.length) args.push('--tools', opts.tools.join(','))
  if (opts.disallowedTools?.length) args.push('--disallowed-tools', opts.disallowedTools.join(','))
  if (opts.rules) args.push('--rules', opts.rules)
  if (opts.systemPromptOverride) args.push('--system-prompt-override', opts.systemPromptOverride)
  if (opts.sessionId) args.push('-s', opts.sessionId)
  if (opts.noProjectRoot) args.push('--no-project-root')
  if (opts.disableWebSearch) args.push('--disable-web-search')
  for (const rule of opts.allow || []) args.push('--allow', rule)
  for (const rule of opts.deny || []) args.push('--deny', rule)
  return args
}

function _spawn(bin, args, { cwd, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(bin, args, {
        cwd: cwd || process.cwd(),
        env: { ...process.env, GROK_DISABLE_UPDATE_CHECK: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      reject(new Error(`failed to spawn ${bin}: ${err.message}`))
      return
    }
    let stdout = ''
    let stderr = ''
    let timer
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    }
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`${bin} spawn error: ${err.message}. Is grok installed and on PATH?`))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code, signal })
    })
  })
}

// ---------------------------------------------------------------------------
// Schema handling — grok headless returns free text, so we ask the agent to
// emit JSON and parse it ourselves. This is the same trade Claude Code's
// StructuredOutput makes, minus a dedicated tool: instruct, parse, retry.
// ---------------------------------------------------------------------------

function _withSchemaInstruction(prompt, schema) {
  return (
    prompt +
    '\n\n---\n' +
    'Respond with ONLY a single JSON value that conforms to this JSON Schema. ' +
    'No prose, no explanation, no markdown code fences around it.\n\n' +
    'JSON Schema:\n' +
    JSON.stringify(schema, null, 2)
  )
}

/** Pull the first/last balanced JSON value out of arbitrary text. */
export function _extractJson(text) {
  if (text == null) return undefined
  const trimmed = String(text).trim()
  // Strip a ```json … ``` fence if the model added one despite instructions.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fence ? fence[1].trim() : trimmed
  try {
    return JSON.parse(body)
  } catch {
    // Fall back to scanning for balanced { } / [ ] spans, in order of where they
    // appear in the text, and return the first one that actually parses. Ordering
    // by position (not a fixed brace-before-bracket preference) means a valid
    // value that appears earlier isn't shadowed by a later one, and a malformed
    // leading span doesn't hide a valid one further along.
    for (const span of _balancedSpans(body)) {
      try {
        return JSON.parse(span)
      } catch {
        /* try the next candidate span */
      }
    }
    return undefined
  }
}

/** Yield balanced { } and [ ] spans, ordered by their opening position. */
function* _balancedSpans(s) {
  const openers = []
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    let from = 0
    let idx
    while ((idx = s.indexOf(open, from)) !== -1) {
      openers.push({ open, close, start: idx })
      from = idx + 1
    }
  }
  openers.sort((a, b) => a.start - b.start)
  for (const { open, close, start } of openers) {
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < s.length; i++) {
      const c = s[i]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
      } else if (c === '"') inStr = true
      else if (c === open) depth++
      else if (c === close) {
        depth--
        if (depth === 0) {
          yield s.slice(start, i + 1)
          break
        }
      }
    }
  }
}

/** Minimal structural validation: required top-level keys exist. Throws on miss.
 * This is the DEFAULT, intentionally-lenient check (instruct, parse, retry). For
 * full nested/type/enum enforcement, opt into _validateDeep via opts.strictSchema
 * or config.strictSchema.
 *
 * WARNING: does NOT check "type", "enum", array "items", or nested required.
 * LLMs commonly emit string "false"/"true", numbers as strings, wrong enum
 * members, or omit nested objects. Workflows MUST use strict checks like
 * v.foo === true or coerceBoolean(v.foo), or pass strictSchema:true when
 * the contract requires exact shape. See src/SPEC.md "Schema validation
 * pitfalls & recommended patterns" and the exported coerceBoolean helper. */
function _validateShape(value, schema) {
  if (!schema || typeof schema !== 'object') return
  if (schema.type === 'object' && Array.isArray(schema.required)) {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`expected object, got ${Array.isArray(value) ? 'array' : typeof value}`)
    }
    const missing = schema.required.filter((k) => !(k in value))
    if (missing.length) throw new Error(`missing required keys: ${missing.join(', ')}`)
  }
  if (schema.type === 'array' && !Array.isArray(value)) {
    throw new Error(`expected array, got ${typeof value}`)
  }

}

/**
 * Coerce common LLM/string/number/1/0 representations of booleans into a real
 * boolean. Useful for post-processing results from agent({schema}) when you
 * deliberately use the default lenient (top-level only) validation, or as an
 * extra guard even with strictSchema.
 *
 * LLMs frequently emit the JSON string "false" (or "0", 0, "true") for a
 * declared "type":"boolean" field because the prompt says "boolean" but the
 * instruct+parse layer is loose by default. Use this instead of raw `v.done`
 * or `if (v.approved)` for critical control fields.
 *
 * Example:
 *   const fix = await agent(..., { schema: { type: 'object', required: ['done'], properties: { done: { type: 'boolean' } } } });
 *   if (coerceBoolean(fix?.done) !== true) { ... flag incomplete ... }
 *
 * For exact enforcement + retries on bad values, prefer strictSchema:true
 * (per-call or global) instead of or in addition to coercion.
 */
export function coerceBoolean(v) {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  // Fall back conservatively: only explicit truthy representations above count
  // as true; everything else (including "yes", null, undefined, objects, stray
  // strings) is false for safety in control flow.
  return false;
}

/** The JSON-ish type name of a value, distinguishing array and null from object. */
function _jsonType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** True if `value` matches a single JSON Schema primitive `type`. Unknown type
 * strings are treated permissively (return true) so an exotic schema can't make
 * validation reject everything. */
function _matchesType(value, t) {
  switch (t) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'object':
      return value != null && typeof value === 'object' && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'null':
      return value === null
    default:
      return true
  }
}

/**
 * Deep, opt-in JSON Schema validation. Unlike _validateShape (top-level keys
 * only), this recursively enforces declared `type` (including unions like
 * `["string","null"]` and `integer`), `enum` membership, nested object `required`
 * keys, and `array` `items` schemas. Throws with a JSON-path-style location on the
 * first violation. It is deliberately a SUBSET of full JSON Schema — no
 * additionalProperties, no formats, no min/max — so it stays cheap and never
 * rejects the kind of harmless extra fields LLMs add. Absent optional properties
 * are fine; only `required` keys must be present.
 *
 * @param {*} value
 * @param {object} schema
 * @param {string} [path='$']  JSON path of `value`, used in error messages.
 */
export function _validateDeep(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object') return

  // enum membership (checked before type — an enum implies the allowed set).
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((e) => e === value)) {
      throw new Error(
        `${path}: ${JSON.stringify(value)} not in enum [${schema.enum.map((e) => JSON.stringify(e)).join(', ')}]`
      )
    }
  }

  // type (a string, or an array of acceptable types).
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((t) => _matchesType(value, t))) {
      throw new Error(`${path}: expected type ${types.join('|')}, got ${_jsonType(value)}`)
    }
  }

  const isObj = value != null && typeof value === 'object' && !Array.isArray(value)

  // object: required keys + recurse into declared properties that are present.
  if (isObj) {
    if (Array.isArray(schema.required)) {
      const missing = schema.required.filter((k) => !(k in value))
      if (missing.length) throw new Error(`${path}: missing required keys: ${missing.join(', ')}`)
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in value && value[k] !== undefined) {
          _validateDeep(value[k], sub, `${path}.${k}`)
        }
      }
    }
  }

  // array: recurse each element against the items schema.
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    for (let i = 0; i < value.length; i++) {
      _validateDeep(value[i], schema.items, `${path}[${i}]`)
    }
  }
}

// ---------------------------------------------------------------------------
// parallel() — barrier. Run all thunks concurrently (respecting the global
// limiter), await everything, return results in order. A thunk that throws or
// whose agent fails resolves to null — the call itself never rejects.
// ---------------------------------------------------------------------------

/**
 * @template T
 * @param {Array<() => Promise<T>>} thunks
 * @returns {Promise<Array<T|null>>}
 */
export async function parallel(thunks) {
  return Promise.all(
    thunks.map((fn) =>
      Promise.resolve()
        .then(fn)
        .catch((err) => {
          if (isCapError(err)) throw err
          log(`parallel task failed: ${err.message}`)
          _parallelTaskErrors.push(err.message)
          return null
        })
    )
  )
}

// ---------------------------------------------------------------------------
// pipeline() — NO barrier. Each item flows through all stages independently;
// item A can be in stage 3 while item B is still in stage 1. Wall-clock is the
// slowest single-item chain, not the sum of slowest-per-stage.
//
// Every stage receives (prevResult, originalItem, index). A stage that throws
// drops that item to null and skips its remaining stages.
// ---------------------------------------------------------------------------

/**
 * @param {Array<any>} items
 * @param {...(prev:any, item:any, index:number) => Promise<any>} stages
 * @returns {Promise<Array<any|null>>}
 */
export async function pipeline(items, ...stages) {
  return Promise.all(
    items.map(async (item, index) => {
      let acc = item
      for (const stage of stages) {
        try {
          acc = await stage(acc, item, index)
        } catch (err) {
          if (isCapError(err)) throw err
          log(`pipeline item ${index} failed at a stage: ${err.message}`)
          _pipelineDropErrors.push({ index, message: err.message })
          return null
        }
      }
      return acc
    })
  )
}

// ---------------------------------------------------------------------------
// Higher-order patterns (the blog's named harness shapes)
// ---------------------------------------------------------------------------

/**
 * Adversarial verification. Spawn N independent skeptics, each prompted to
 * REFUTE a claim, and decide by majority. Defeats self-preferential bias: the
 * agent that produced a finding never gets to bless it.
 *
 * @param {string} claim
 * @param {object} [opts]
 * @param {number} [opts.voters=3]
 * @param {(claim:string, lensOrIndex:any) => string} [opts.prompt] Custom prompt builder.
 * @param {string[]} [opts.lenses] Distinct lenses (e.g. ['correctness','security']);
 *        length overrides `voters` when provided.
 * @param {object} [opts.agentOpts] Extra opts forwarded to each agent().
 * @returns {Promise<{survives:boolean, refuted:number, kept:number, votes:Array}>}
 */
export async function adversarialVerify(claim, opts = {}) {
  const lenses = opts.lenses || Array.from({ length: opts.voters || 3 }, (_, i) => i + 1)
  const buildPrompt =
    opts.prompt ||
    ((c, lens) =>
      `You are a skeptical verifier${typeof lens === 'string' ? ` using the "${lens}" lens` : ''}. ` +
      `Try hard to REFUTE this claim. If you cannot find a concrete, specific reason it is false, ` +
      `treat it as holding. Default to refuted=true only when you have real evidence.\n\nClaim: ${claim}`)
  const schema = {
    type: 'object',
    required: ['refuted', 'reason'],
    properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
  }
  const votes = await parallel(
    lenses.map((lens) => () =>
      agent(buildPrompt(claim, lens), {
        ...opts.agentOpts,
        schema,
        strictSchema: true, // guarantee boolean `refuted` (lenient would let "false"/"0" etc. through and corrupt majority)
        label: `verify:${typeof lens === 'string' ? lens : `#${lens}`}`,
      })
    )
  )
  const valid = votes.filter(Boolean)
  const refuted = valid.filter((v) => v.refuted === true).length
  const kept = valid.length - refuted
  return { survives: kept > refuted, refuted, kept, votes: valid }
}

/**
 * Fan-out-and-synthesize. Run a worker over each item (fresh context each), then
 * merge all structured outputs with a single synthesis agent. The synthesis is a
 * barrier — it waits for every worker.
 *
 * @param {Array<any>} items
 * @param {(item:any, index:number) => Promise<any>} worker
 * @param {(results:Array<any>) => Promise<any>} synthesize
 * @returns {Promise<any>}
 */
export async function fanOutSynthesize(items, worker, synthesize) {
  const results = (await parallel(items.map((item, i) => () => worker(item, i)))).filter(
    (r) => r != null
  )
  return synthesize(results)
}

/**
 * Classify-and-act. A classifier agent labels the input, then a router picks the
 * handler for that label. Use to route by model/intelligence or by task type.
 *
 * @param {string} input
 * @param {object} routes  Map of label => async (input, classification) => any.
 *                         Provide a `default` key as a fallback.
 * @param {object} [opts]
 * @param {string[]} [opts.labels]  Allowed labels (constrains the classifier).
 * @param {object} [opts.agentOpts] Extra opts for the classifier agent().
 * @returns {Promise<{label:string, result:any, classification:object}>}
 */
export async function classifyAndRoute(input, routes, opts = {}) {
  const labels = opts.labels || Object.keys(routes).filter((k) => k !== 'default')
  const classification = await agent(
    `Classify the following into exactly one of these labels: ${labels.join(', ')}.\n\n${input}`,
    {
      ...opts.agentOpts,
      label: 'classify',
      schema: {
        type: 'object',
        required: ['label'],
        properties: { label: { enum: labels }, reason: { type: 'string' } },
      },
    }
  )
  const label = classification?.label && routes[classification.label] ? classification.label : 'default'
  const handler = routes[label]
  if (!handler) throw new Error(`no route for label "${label}" and no default provided`)
  const result = await handler(input, classification)
  return { label, result, classification }
}

/**
 * Generate-and-filter. Generate candidate ideas, dedupe, then keep only those a
 * verifier passes.
 *
 * @param {() => Promise<Array<any>>} generate  Returns a batch of candidates.
 * @param {(candidate:any) => Promise<boolean>} keep  Verifier predicate.
 * @param {object} [opts]
 * @param {(candidate:any) => string} [opts.key]  Dedupe key (default JSON).
 * @param {number} [opts.rounds=1]  How many generate rounds to run.
 * @returns {Promise<Array<any>>}
 */
export async function generateAndFilter(generate, keep, opts = {}) {
  const key = opts.key || ((c) => JSON.stringify(c))
  const seen = new Set()
  const unique = []
  for (let r = 0; r < (opts.rounds || 1); r++) {
    const batch = (await generate()) || []
    for (const c of batch) {
      const k = key(c)
      if (!seen.has(k)) {
        seen.add(k)
        unique.push(c)
      }
    }
  }
  const verdicts = await parallel(unique.map((c) => () => keep(c)))
  return unique.filter((_, i) => verdicts[i] === true)
}

/**
 * loopUntilDone — for unknown-size work. Call roundFn() repeatedly until it
 * signals completion or we hit a dry streak / max rounds. roundFn receives the
 * round index and the accumulator; return { done?:boolean, items?:Array } or any
 * value (truthy "new work" resets the dry streak).
 *
 * @param {(round:number, acc:Array) => Promise<{done?:boolean, items?:Array}|any>} roundFn
 * @param {object} [opts]
 * @param {number} [opts.maxRounds=10]
 * @param {number} [opts.dryStreak=2]  Stop after this many rounds with no new items.
 * @returns {Promise<Array>}  Accumulated items across all rounds.
 */
export async function loopUntilDone(roundFn, opts = {}) {
  const maxRounds = opts.maxRounds ?? 10
  const dryLimit = opts.dryStreak ?? 2
  const acc = []
  let dry = 0
  for (let round = 0; round < maxRounds; round++) {
    const out = await roundFn(round, acc)
    // Accumulate this round's items FIRST — a round may hand back its final items
    // alongside done:true, and those must not be dropped.
    const isArr = Array.isArray(out)
    const items = isArr ? out : out?.items || []
    if (items.length > 0) acc.push(...items)
    // "New work" resets the dry streak. Per the documented contract this is broader
    // than "items were returned": a bare truthy value (string/number/true) or an
    // object carrying its own signal (e.g. {found:5}) also counts as progress, even
    // though it contributes no items to the accumulator. An empty array, {items:[]},
    // a falsy value, or a {done}/{items}-shaped object with nothing new does NOT.
    const isObjectForm = out != null && typeof out === 'object' && !isArr
    const bareTruthy = Boolean(out) && !isArr && !isObjectForm
    const objSignalsWork =
      isObjectForm &&
      out.items === undefined &&
      out.done === undefined &&
      Object.keys(out).length > 0
    const signalsWork = items.length > 0 || bareTruthy || objSignalsWork
    if (signalsWork) dry = 0
    if (out && out.done) {
      log(`loopUntilDone: round ${round} signalled done`)
      break
    }
    if (!signalsWork && ++dry >= dryLimit) {
      log(`loopUntilDone: ${dry} dry rounds, stopping`)
      break
    }
  }
  return acc
}

/**
 * tournament — rank items by pairwise comparison (more reliable than absolute
 * scoring for taste/quality work). Runs a single-elimination bracket; each match
 * is its own agent via the comparator. Returns the winner plus the bracket log.
 *
 * For a full ranking of many items, prefer bucket-rank + merge; this returns the
 * top item, which is what naming/design/"pick the best" tasks want.
 *
 * @template T
 * @param {Array<T>} items
 * @param {(a:T, b:T) => Promise<T>} comparator  Resolves to the winner of a vs b.
 * @returns {Promise<{winner:T, rounds:Array}>}
 */
export async function tournament(items, comparator) {
  if (!items.length) return { winner: undefined, rounds: [] }
  let round = items.slice()
  const rounds = []
  while (round.length > 1) {
    const pairs = []
    for (let i = 0; i < round.length; i += 2) {
      if (i + 1 < round.length) pairs.push([round[i], round[i + 1]])
      else pairs.push([round[i], null]) // bye
    }
    const winners = await parallel(
      pairs.map(([a, b]) => async () => (b == null ? a : (await comparator(a, b)) ?? a))
    )
    const next = winners.map((w, i) => (w == null ? pairs[i][0] : w))
    rounds.push(next)
    round = next
  }
  return { winner: round[0], rounds }
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function truncate(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function defaultMock(prompt) {
  // Deterministic stand-in for grok. When a JSON schema instruction (appended by
  // _withSchemaInstruction for agent({schema})) is present, return a minimal
  // *plausible* object satisfying top-level required keys and common harness
  // structures (hypotheses, claims, verdict, etc.) so that plain
  // GROK_WORKFLOWS_MOCK=1 runs of root-cause, deep-verify, migrate, etc.
  // produce non-empty useful flows for demo/debug/ultracode instead of
  // immediate dry/zero results. Non-schema path is unchanged (short ack).
  // Heuristic inspects prompt text (which embeds the schema JSON) for known
  // field names from bundled harnesses; falls back to required keys or {mock:true}.
  // Harness regression tests still use their own withMock overrides.
  if (/JSON Schema:/.test(prompt)) return _mockSchemaObject(prompt)
  return `[mock grok] ${truncate(prompt, 120)}`
}

/** Cheap heuristic to synthesize a minimal valid-ish response for common
 * harness schemas when under default mock. Inspects the schema text embedded
 * in the prompt rather than requiring a full registry or duplicating schemas.
 */
function _mockSchemaObject(prompt) {
  const p = String(prompt || '')
  // Common harness shapes (from root-cause, deep-verify, migrate, sort-tournament,
  // eval-skill, adversarialVerify, classifyAndRoute, etc.). Order matters for
  // overlapping keywords; specific first.
  if (/"hypotheses"|\bhypotheses\b/i.test(p)) {
    return JSON.stringify({
      hypotheses: [
        { claim: 'mock hypothesis: the issue is caused by X under condition Y', evidence: 'observed in logs slice; matches code path Z' },
      ],
    })
  }
  if (/"claims"|\bclaims\b/i.test(p)) {
    return JSON.stringify({
      claims: [
        { id: 'c1', text: 'mock extracted claim: component Foo returns bar when baz is set' },
      ],
    })
  }
  if (/"verdict"|\bverdict\b/i.test(p)) {
    return JSON.stringify({
      id: 'c1',
      verdict: 'supported',
      evidence: 'mock evidence from source grep and file read',
      source: 'src/example.js:42 and https://example.com/doc',
    })
  }
  if (/evidenceHolds|\bevidencHolds\b/i.test(p)) {
    return JSON.stringify({
      evidenceHolds: true,
      reason: 'mock audit: evidence holds under default mock for demo flow',
      quality: 'medium',
    })
  }
  if (/"done"|\bdone\b/i.test(p) && (/"path"|\bpath\b/i.test(p) || /FIX|migration|diff/i.test(p))) {
    return JSON.stringify({
      path: 'mock/file.js',
      summary: 'mock applied the described change',
      done: true,
      diff: 'diff --git a/mock/file.js b/mock/file.js\nindex 000..111 100644\n--- a/...\n+++ b/...\n@@ -1 +1 @@\n-mock old\n+mock new',
    })
  }
  if (/"refuted"|\brefuted\b/i.test(p)) {
    return JSON.stringify({
      refuted: false,
      reason: 'mock: could not find concrete refuting evidence under default',
    })
  }
  if (/"label"|\blabel\b/i.test(p) && /classify|route/i.test(p)) {
    return JSON.stringify({ label: 'default' })
  }
  if (/"winner"|\bwinner\b/i.test(p)) {
    return JSON.stringify({ winner: 'A', reason: 'mock tournament: A wins per comparator heuristic' })
  }
  if (/"sites"|\bsites\b/i.test(p)) {
    return JSON.stringify({
      sites: [{ path: 'mock/src/target.js', why: 'matches the migration description pattern' }],
    })
  }
  if (/"score"|\bscore\b/i.test(p)) {
    return JSON.stringify({ candidate: 1, score: 7, justification: 'mock score: satisfies rubric criteria in demo' })
  }
  if (/"candidate"|\bcandidate\b/i.test(p) && /approach|summary/i.test(p)) {
    return JSON.stringify({
      candidate: 1,
      approach: 'mock approach',
      summary: 'mock summary of the changes made in the isolated worktree',
    })
  }

  // Graceful fallback for unknown schemas: satisfy top-level required keys
  // with simple placeholder values (string/num/bool/array as appropriate).
  // Try to parse a "required": [...] from the embedded schema JSON text.
  const reqMatch = p.match(/"required"\s*:\s*\[\s*([^\]]+?)\s*\]/)
  if (reqMatch) {
    const keys = reqMatch[1]
      .split(/,\s*/)
      .map((s) => s.replace(/["']/g, '').trim())
      .filter(Boolean)
    const obj = {}
    for (const k of keys) {
      if (k === 'hypotheses' || k === 'claims' || k === 'sites' || k === 'votes') {
        obj[k] = []
      } else if (k === 'done' || k === 'refuted' || k === 'evidenceHolds' || k === 'approved' || k === 'survives') {
        obj[k] = true // choose useful true for demo flows
      } else if (k === 'verdict') {
        obj[k] = 'unverifiable'
      } else if (k === 'winner') {
        obj[k] = 'A'
      } else if (k === 'label') {
        obj[k] = 'default'
      } else if (k === 'score' || k === 'candidate' || k === 'count') {
        obj[k] = 1
      } else {
        obj[k] = `mock ${k}`
      }
    }
    // Ensure common collection keys are non-empty for useful harness runs.
    if (obj.hypotheses && obj.hypotheses.length === 0) obj.hypotheses = [{ claim: 'mock claim' }]
    if (obj.claims && obj.claims.length === 0) obj.claims = [{ id: 'c1', text: 'mock text' }]
    if (obj.sites && obj.sites.length === 0) obj.sites = [{ path: 'f', why: 'm' }]
    return JSON.stringify(obj)
  }

  // Last resort (preserves prior tiny mock behavior for unrecognized schemas).
  return JSON.stringify({ mock: true })
}

/** Total agent() calls made so far this process (for budgeting/inspection). */
export function totalAgents() {
  return _totalAgents
}

/**
 * Retrieve and consume the last error message recorded for a failed agent() by its `label`
 * (from opts.label or the truncated prompt). Returns undefined if no recorded failure for that label.
 * Harnesses use this (post-parallel/pipeline of labeled agents) to attach actionable
 * per-item error strings (e.g. "grok exited 1: ...", "no JSON...", schema errors) into
 * the result JSON instead of only counts + transient stderr.
 */
export function getLastAgentError(label) {
  if (!label) return undefined
  const msg = _agentFailureErrors.get(label)
  if (msg !== undefined) {
    _agentFailureErrors.delete(label)
    return msg
  }
  return undefined
}

/**
 * Consume and return any pipeline drop errors recorded since last call (array of {index, message}).
 * Used by harnesses like deep-verify to surface details for items that hit the pipeline catch
 * (actual throws in a stage, leading to null in results array).
 */
export function getAndClearPipelineDropErrors() {
  return _pipelineDropErrors.splice(0)
}

/**
 * Consume and return any parallel task error messages recorded since last call.
 * (Complements agent label errors, for cases where a thunk itself threw.)
 */
export function getAndClearParallelTaskErrors() {
  return _parallelTaskErrors.splice(0)
}
