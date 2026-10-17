# ADR-0008 — The suppression gate scans the whole repository minus `.claude/` and `.github/`

Status: accepted
Date: 2026-09-03
Decided by: W0-INF-02 (Infra agent), after two verifier FAILs; promoted by the orchestrator
Scope: `.github/workflows/ci.yml`

## Context

Plan §9.1 requires that a PR adding a new `@ts-ignore`, `@ts-expect-error` or `eslint-disable` fails
CI. Plan §2.1 rule 3 requires every wave's workflow script to be **committed verbatim**. These
collided head-on: a wave recording is a `.mjs` file whose *prompt prose* necessarily contains those
three literals, so committing one turned CI red. W0-DOC-01's CI was red for exactly this reason, and
no escalation had been filed although plan §3.5 required one.

The first attempt to resolve it narrowed the scan to a positive directory list,
`apps packages scripts`. That silently dropped the repository **root** — `eslint.config.mjs` and
`vitest.config.ts`, both linted by `eslint .` and type-checked strict + `checkJs` by
`tsconfig.root.json`. A verifier proved it: over a synthetic suppression-adding diff the old pathspec
selected those files and the new one selected nothing. **The fix for one gate had weakened another**,
which plan §9.3 names as the failure this whole process exists to catch.

## Decision

Keep the original whole-repository TS/JS pathspec and subtract exactly two paths:

    ':(exclude).github/**'    workflow YAML that legitimately discusses the literals
    ':(exclude).claude/**'    committed wave recordings, required verbatim by §2.1 rule 3

Nothing else, the repository root included. `docs/**` was also dropped from the exclusion list: it is
Markdown, so excluding it bought nothing and would have hidden a future `.ts` placed there. The
pathspec is the single place scope is decided; the redundant second extension filter is gone.

Narrow scope only where a committed artefact genuinely forces it. **Never** trade coverage for
convenience, and never express the scope as a positive list of directories — that is what drops the
root. A warning comment saying so sits in `ci.yml` at the point where someone would reintroduce it.

## Alternatives considered

- **Positive directory list.** Tried, rejected, and now warned against in place.
- **Parse an AST instead of grepping text.** Rejected under plan §40 for now: well past "~50 lines of
  clear TypeScript", and the text scan has no false negatives that matter yet. Retained as a
  declared gap.
- **Exempt wave recordings by a marker comment.** Rejected: it puts the exemption inside the file
  being checked, so a future author could exempt anything.

## Consequences

- The gate scans text, not syntax: a suppression inside a string literal or a comment in a real
  source file trips it. Declared, and acceptable — it fails safe.
- `.claude/**` is now unscanned entirely. If real code is ever placed there, it escapes the gate.
- Verified by reproduction rather than assertion: over a nine-file synthetic diff the original
  pathspec selected 7 files, the rejected revision 3, and this one 6 — the original set minus only
  the wave recording.
