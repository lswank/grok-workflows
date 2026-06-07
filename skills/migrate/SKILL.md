---
name: migrate
description: Mechanical migration/refactor harness that discovers every site needing a change, fixes each one in an isolated git worktree, adversarially reviews each fix in a fresh-context agent, and reports what passed (worktrees are left for the user to merge). Use when the user wants to perform a codebase-wide mechanical change — rename a symbol/model/API everywhere, swap a library, update a deprecated call, apply a refactor across many files — or asks for /migrate.
metadata:
  short-description: "Codebase-wide migration: discover sites, fix in isolated worktrees, adversarially review, report"
---

# /migrate — discover, fix-in-worktrees, adversarially review

Runs the bundled grok-workflows harness, which finds every file/site that needs
the migration (read-only scout), fixes each site in its own isolated git
worktree so concurrent edits never collide, then has a different fresh-context
agent adversarially review each fix for correctness and completeness. It does
NOT merge anything — the worktrees are left in place for a human to apply. You do
not re-implement any of this; you invoke the harness and act on its JSON.

## Usage
`/migrate <migration description> [-- glob or dir to scope]`

Examples:
- `/migrate rename the User model to Account everywhere -- src/`
- `/migrate replace moment.js with date-fns`

## How it runs

This skill bundles a self-locating launcher at `<skill-dir>/scripts/run.mjs` —
`<skill-dir>` is this skill's own directory, whose absolute path is announced in
your system context when the skill loads. Derive the launcher path from that
announced SKILL.md path and inline the absolute path into a single
`run_terminal_cmd` call (don't rely on the working directory or a shell variable).
The launcher locates its bundled harness itself, so no repository path is needed.
The optional ` -- <scope>` suffix scopes the search to a dir or glob:

```bash
node <skill-dir>/scripts/run.mjs "<migration description> -- <scope>"
```

The harness prints a single JSON object to stdout (progress logs go to stderr):

```json
{
  "migration": "rename the User model to Account everywhere",
  "scope": "src/",
  "sites": 3,
  "fixed": [
    { "path": "...", "why": "...", "summary": "...", "approved": true, "issues": [] }
  ],
  "needsAttention": [
    { "path": "...", "why": "...", "summary": "...", "approved": false, "issues": ["..."] }
  ],
  "dropped": 0,
  "merged": false,
  "note": "Edits were made in isolated git worktrees and were NOT merged..."
}
```

## What to do with the result

1. Parse the JSON from stdout.
2. Lead with the headline: `fixed.length` of `sites` sites passed adversarial
   review; `needsAttention.length` still need work; `dropped` items failed
   outright.
3. List the `needsAttention` entries with their `issues` so the user knows
   exactly what is incomplete or wrong — do not bury these.
4. Make the no-merge fact loud: `merged` is always `false`. The fixes live in
   isolated git worktrees. Tell the user to run `git worktree list`, inspect each
   diff, and merge or discard manually. The harness never touches their working
   tree.
5. If `sites` is 0, tell the user nothing was found needing this migration (or
   discovery failed) and suggest tightening the description or scope.

Do not re-run the migration inline or hand-edit files yourself — the harness owns
the discover → fix → review orchestration. Your job is to relay and act on its
report.
