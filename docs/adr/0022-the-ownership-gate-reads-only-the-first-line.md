# ADR-0022 — The ownership gate reads one physical line; a wrapped declaration silently under-declares

Status: accepted
Date: 2026-09-04
Decided by: orchestrator
Scope: `scripts/check-file-ownership.mjs`, PR-body authoring

## Context

Two PRs (#28, #31) failed the ownership gate while being entirely inside their granted globs. In both
cases the PR body's `Owns globs:` declaration wrapped across several physical lines for readability,
and the parser reads only the **first** line. #31 declared six globs across four lines; the gate saw
two, and reported eleven files as "changed outside the declared Owns globs" — every one of which the
task card had explicitly granted.

The gate **fails closed**, which is correct and is why this was caught rather than silently allowed.
But its message says only *"Either the PR is editing another task's files, or its Ownership section is
wrong."* Neither is true. The declaration was right; it was truncated at a line break, and nothing in
the output says so — so a reader is sent looking for a violation that does not exist.

## Decision

1. **Author `Owns globs:` on exactly one physical line**, however long. Prose explaining the scope of
   each glob goes on the lines *below*, where the parser will not read it. This goes into the PR
   template and the wave task-brief boilerplate.
2. **Teach the parser continuation**, and until then, make its failure message name the possibility it
   currently omits: that the declaration continued onto a line it did not read. A gate whose
   diagnosis excludes the actual cause is worse than a silent one, because it directs the fix wrongly.
3. Recorded as a follow-up against `scripts/check-file-ownership.mjs` rather than fixed here: that
   file belongs to W0-INF-02, frozen several branches below, and the workaround (one line) is free.

## Alternatives considered

- **Make the parser greedy across a blank-line-delimited paragraph.** The right fix, deferred only
  because the owning branch is frozen and landing is in progress.
- **Treat it as author error and move on.** Rejected: it has now cost two PRs a CI cycle each, and the
  second occurrence happened *after* the first was known — which makes it a process defect, not a
  mistake.

## Consequences

- Declarations become long single lines, which read poorly in a diff. The scope notes beneath them
  carry the readability, and the gate stays honest.
- Until the parser is fixed, a reviewer cannot distinguish a truncated declaration from a real
  violation without re-reading the PR body. The failure message is the thing to fix first.
