// src/parse-input.mjs
//
// Shared robust parser for "--" separator used by several workflows for
// evidence files (root-cause: "problem -- file1 file2") or scope
// (migrate: "migration -- glob-or-dir").
//
// Root cause of prior inconsistency (bug #2): duplicated regex split logic
// with different robustness strategies.
//   - root-cause.mjs: used /^(.*)\s+--\s+(.*)$ / (greedy last via regex),
//     *then* actually tested whether suffix tokens resolve to *existing files*
//     on disk before accepting the split. Detailed comments explained
//     "greedy backtracking" and why this prevents mangling natural-language
//     that contains " -- " + dash-like text.
//   - migrate.mjs (parseInput) and eval-skill (its --N): used similar regex
//     or token match but weaker char-class heuristics (for migrate:
//     /[\/.*[\]]/ or startsWith('.') or includes('**')). Comments said
//     "Robustness improvement (modeled on the root-cause fix)".
//
// This led to same CLI syntax behaving differently across /workflow routes
// or direct calls. Prose containing " -- something-plausible" could be
// truncated in some harnesses but not others.
//
// Solution: extract here. Default behavior is the gold-standard file-existence
// validation (from root-cause). Per-harness customization via `looksLike`
// callback (sync or async) for cases like globs (migrate) that are not
// literal disk paths.
//
// Always uses the *last* " -- " via the regex (greedy). Only accepts split
// when the looksLike decides yes; otherwise the whole input is "left".
//
// No behavior change for previously-valid splits; more cases now robustly
// treated as prose when no real evidence/scope follows -- .
// (Task 4 update: the previously-internal dropped tokens are now returned in `dropped`
// on the result for *all* callers/harnesses, closing the lossy-drop observability gap
// that was only visible via optional log() to stderr. See JSDoc on parseWithSeparator.)

import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Regex for the separator (last " -- " via greedy (.*) before it). */
export const SEP_REGEX = /^(.*)\s+--\s+(.*)$/

/**
 * Heuristic that used to be in migrate: does the suffix "look like" a scope/glob?
 * Exported so migrate (and tests) can reuse without duplication.
 */
export function looksLikeScopeGlob(suffix = '') {
  const s = String(suffix || '').trim()
  if (!s) return false
  return /[\/.*[\]]/.test(s) || s.startsWith('.') || s.includes('**')
}

/**
 * Find the *last* "-- <number>" match in a string (for eval-skill's -- N
 * modifier and similar numeric -- tokens). Using last makes it consistent
 * with the greedy-last behavior of the main evidence/scope separator.
 * Returns the match object or null.
 */
export function findLastNumericModifier(str = '') {
  const re = /(?:^|\s)--\s*(\d+)\b/g
  let last = null
  let m
  // exec in loop to get the last
  while ((m = re.exec(String(str))) !== null) {
    last = m
  }
  return last
}

/**
 * parseWithSeparator(input, opts)
 *
 * Splits on the last " -- " (if present) but *only* accepts the split when
 * the suffix is validated as "real" evidence/scope by the `looksLike` fn
 * (or the default file-existence check).
 *
 * @param {string} input
 * @param {object} [opts]
 * @param {string} [opts.cwd=process.cwd()] - base for resolving relative paths
 * @param {function} [opts.log] - optional logger fn(str) used by default
 *   file-existence validator to emit the per-file "evidence file not found,
 *   dropping: ..." diagnostics (exactly as root-cause used to, for identical
 *   observable behavior).
 * @param {function} [opts.looksLike] - async (suffix: string, cwd: string) =>
 *   boolean | { accept: boolean, value?: any }
 *   If omitted, uses the gold-standard file-existence validator (root-cause):
 *     - splits suffix on whitespace into tokens
 *     - resolves each relative to cwd
 *     - accepts split IFF at least one token is an existing file/dir on disk
 *     - when accepted, `right` in result is the array of *valid resolved* paths
 *       (invalids are dropped, same as original root-cause)
 *     - emits drop logs via opts.log if provided
 *   This is stricter than char heuristics and prevents splitting on prose
 *   that merely *looks* path-ish (e.g. "sales dropped -- see Q3 trend" or
 *   "foo -- bar/baz in logs" when those exact paths don't exist).
 * @returns {Promise<{left: string, right: string|any, accepted: boolean, hadMatch: boolean, original: string, dropped: string[]}>}
 *   - `dropped` is always present (as string[]); empty when none rejected or no -- suffix.
 *     For default (file-existence) validator: contains the *resolved* paths (via path.resolve + cwd)
 *     that failed fs.access (actionable for the caller). Per-file drop logs still emitted via `log` if provided.
 *     For custom `looksLike` (e.g. migrate scope globs): on reject (hadMatch && !accepted), contains the
 *     raw suffix tokens that the callback rejected (whole-suffix decision; no per-token acceptance for globs).
 *   - accepted=true: left is the part before -- , right is the validated value
 *     (string for scope, array for evidence files); dropped holds any invalids that were filtered (mixed case)
 *   - accepted=false && hadMatch=true: a -- was seen but looksLike rejected it
 *     (caller may log "treating as prose"); left===original (full input); dropped holds the rejected suffix tokens/paths
 *   - accepted=false && hadMatch=false: no -- at all; left===original; dropped=[]
 *
 * This addition (Task 4) closes the prior lossy-drop observability gap (dropped list was only in stderr logs,
 * not in public parse result or harness outputs). See callers in root-cause/migrate for propagation.
 * The core last- --  greedy split + acceptance logic is 100% unchanged from the bug #2 unification.
 */
export async function parseWithSeparator(input, opts = {}) {
  const raw = String(input || '').trim()
  const { cwd = process.cwd(), looksLike, log } = opts

  const m = raw.match(SEP_REGEX)
  if (!m) {
    return { left: raw, right: '', accepted: false, hadMatch: false, original: raw, dropped: [] }
  }

  const candidateLeft = m[1].trim()
  const candidateRightRaw = m[2].trim()
  const suffixTokens = candidateRightRaw
    .split(/\s+/)
    .map((p) => p.trim())
    .filter(Boolean)

  let accept = false
  let rightValue = candidateRightRaw
  let dropped = []

  if (typeof looksLike === 'function') {
    let decision
    try {
      decision = await looksLike(candidateRightRaw, cwd)
    } catch {
      decision = false
    }
    if (decision && typeof decision === 'object' && decision !== null) {
      accept = !!decision.accept
      if ('value' in decision) rightValue = decision.value
    } else {
      accept = !!decision
    }
    if (!accept) {
      // For looksLike cases (migrate etc.): report the raw suffix tokens that were rejected.
      // (Custom validator decides on the whole suffix string; globs etc. are accepted/rejected as unit.)
      dropped = suffixTokens
    }
  } else {
    // === DEFAULT: gold-standard file-existence validation (root-cause) ===
    // Only accept if >=1 suffix token names a real on-disk file.
    // This is the robust check that was unique to root-cause before unification.
    // invalids are collected into `dropped` (resolved paths) regardless of final accept (for mixed cases).
    const resolvedCandidates = suffixTokens.map((p) =>
      path.isAbsolute(p) ? p : path.resolve(cwd, p)
    )
    const checked = await Promise.all(
      resolvedCandidates.map(async (f) => {
        try {
          await fs.access(f)
          return f
        } catch {
          if (typeof log === 'function') {
            log(`evidence file not found, dropping: ${f}`)
          }
          return null
        }
      })
    )
    const valid = checked.filter(Boolean)
    dropped = resolvedCandidates.filter((_, i) => checked[i] === null)
    accept = valid.length > 0
    if (accept) {
      rightValue = valid
    }
  }

  if (accept) {
    return {
      left: candidateLeft,
      right: rightValue,
      accepted: true,
      hadMatch: true,
      original: raw,
      dropped,
    }
  }

  // " -- " was present but not accepted as separator (prose).
  return {
    left: raw,
    right: '',
    accepted: false,
    hadMatch: true,
    original: raw,
    dropped,
  }
}

export default {
  parseWithSeparator,
  SEP_REGEX,
  looksLikeScopeGlob,
  findLastNumericModifier,
}
