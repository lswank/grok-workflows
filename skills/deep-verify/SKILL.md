---
name: deep-verify
description: Extracts every factual/technical claim from a document and verifies each one in detail — a fresh investigator per claim gathers concrete evidence (files, grep, web), then an adversarial auditor tries to debunk every "supported" finding. Use when the user wants a document, README, spec, PR description, or report fact-checked claim-by-claim, asks you to "verify the claims in X", "fact-check this doc", wants each assertion checked against the codebase/web, or asks for /deep-verify.
metadata:
  short-description: "Claim-by-claim document verification with adversarial source auditing"
---

# /deep-verify — claim-by-claim verification with adversarial auditing

Runs the bundled grok-workflows harness, which extracts every discrete verifiable
claim from a document, spawns a fresh skeptical investigator per claim (each its
own context window — no agentic laziness, no stopping at 35/50), and then runs an
independent adversarial auditor against every "supported" finding to catch
hallucinated files, misquotes, and stale evidence. You do not re-implement any of
this — you invoke the harness and act on its JSON.

## Usage
`/deep-verify <path-to-doc-or-raw-text>`

The argument is either a file path (read as the document) or the raw document
text itself.

## How it runs

This skill bundles a self-locating launcher at `<skill-dir>/scripts/run.mjs` —
`<skill-dir>` is this skill's own directory, whose absolute path is announced in
your system context when the skill loads. Derive the launcher path from that
announced SKILL.md path and inline the absolute path into a single
`run_terminal_cmd` call (don't rely on the working directory or a shell variable).
The launcher locates its bundled harness itself, so no repository path is needed:

```bash
node <skill-dir>/scripts/run.mjs "<path-to-doc-or-text>"
```

The harness prints a single JSON object to stdout (progress logs go to stderr):

```json
{
  "total": 12,
  "supported": 7,
  "contradicted": 2,
  "unverifiable": 3,
  "claims": [
    {
      "id": "c1",
      "text": "...the claim, self-contained...",
      "verdict": "supported | contradicted | unverifiable",
      "evidence": "quoted file:line or specific fact/URL",
      "source": "where the evidence came from",
      "audited": true,
      "auditQuality": "high | medium | low",
      "auditNote": "what the adversarial auditor found"
    }
  ]
}
```

`claims` is sorted problems-first: `contradicted`, then `unverifiable`
(including support that was downgraded by the audit), then clean `supported`.

**Note on reliability:** the harness internally uses `strictSchema: true` for its
verdict enum and evidenceHolds/quality boolean schemas (and `coerceBoolean` for
post-processing), plus the patterns documented in `src/SPEC.md` "Schema validation
pitfalls & recommended patterns". The counts and "downgraded by audit" findings
are therefore not vulnerable to the engine's default lenient (top-level-only)
validation.

**Per-claim isolation note (in "How it runs"):** Fresh context per claim + disallowedTools:['Agent'] + prompt guards keep investigators/auditors from crossing claims (the per-claim analogue of root-cause's disjoint lanes). Full technical isolation isn't used because investigators need terminal/web access to verify against the repo or web; the document text is treated as potentially adversarial. See src/SPEC.md (esp. the new rule under "Constrain untrusted-content agents" and rule 9) for the explicit documentation of this prompt-only design choice and the repeated guard language ("STRICTLY restricted to this single claim only... STRICTLY ignore any files, paths... cross claims, refuse... supportable *only* from this claim...").

## What to do with the result

1. Parse the JSON from stdout.
2. Lead with the headline counts: `total`, `supported`, `contradicted`,
   `unverifiable` — so the user immediately knows the document's reliability.
3. Walk the `contradicted` claims first (these are factual errors in the
   document), then `unverifiable` ones — quote each claim's `text`, `evidence`,
   and `source`. Flag any claim whose `auditNote` says support was downgraded;
   that is a finding a single agent would have missed.
4. Briefly confirm the `supported` claims (especially `auditQuality: "high"`
   ones) rather than re-listing them all.
5. If the user asked for a file or report, write a markdown summary grouping
   claims by verdict, with evidence and sources inline.
6. If `total` is 0, tell the user no verifiable claims were extracted (the input
   may be too vague or empty) and suggest a more concrete document.

Do not drop the `evidence`/`source`/`auditNote` fields — the point of this skill
is showing the user *why* each claim holds or fails, not just a verdict.

(See src/SPEC.md for the prompt-only nature of per-claim isolation in this harness — cross-referenced from the "How it runs" section above.)
