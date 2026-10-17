# ADR-0010 — The ownership gate's glob dialect, whole-repo guard and declaration grammar

Status: accepted
Date: 2026-09-03
Decided by: W0-INF-02 (Infra agent), reasoning recorded in PR #6; lifted and promoted by the W0 integrator
Scope: `scripts/check-file-ownership.mjs`, and every wave script and PR body it reads

## Context

Plan §2.3 buys this programme's concurrency with disjoint file ownership and fixes two things
about how that is checked: the command (`node scripts/check-file-ownership.mjs <wave-script>`)
and the rule — parallel tasks' `Owns` globs must not intersect, and a PR's diff must be a subset
of its declared `Owns`. It fixes nothing else.

Four things it does not fix had to be decided before a line could be written: which glob dialect
the declarations are in, what syntax a wave script declares ownership in, what grammar a PR body
declares it in, and what it means for a declaration to "own the whole repository" — the last of
these being the hole through which the gate is disabled by declaring `**` and calling it a day.

W0-INF-02 took all four and recorded the reasoning in PR #6 rather than in this directory,
because `docs/**` was outside that task's `Owns` line and writing here would itself have tripped
the gate it was building. This record is that reasoning, lifted at integration.

## Decision

**1 — A hand-written glob matcher, no dependency.** Exactly four constructs: `**`, `*`, `?`,
`{a,b}`. spec §40 makes ~50 lines of clear code the rule and reserves libraries for cryptography,
JWT, OAuth, database clients and container protocols; a matcher is none of those.

**2 — "Owns everything" is decided semantically, never by spelling.** The guard asks `matchGlob`
what a declaration *matches*, against a fixed probe spread, and refuses it if (a) it reaches every
area of the tree, (b) it swallows the shared root wholesale — what a bare `*` does, or (c) it takes
every area below the root including a directory nobody has declared, missing only the root — what
`*/**` does. Each question is asked of every glob alone *and* of the declared set together, so
splitting one `**` across several innocent-looking globs does not help.

**3 — The unclaimed-directory probe is what makes question (c) safe.** Without it, (c) would refuse
an honest task that enumerates the five directories that exist today. With it, enumerating today's
directories is a scoped claim and `*/**` is not. This is the line between "several areas" and "the
tree", and it is the one judgement call in the guard.

**4 — Two declaration shapes for wave scripts, invented here.**
`export const ownership = { <level>: { <task-id>: [<globs>] } }`, and `// Owns <task-id>: <globs>`
comments whose level is the nearest preceding `phase()`. Both are read by **static parsing**, not by
importing the script: a wave script calls injected globals (`phase`, `agent`) at module scope and
would throw on import.

**5 — `--plan` warns, rather than fails, when a script carries no declarations.** The only committed
wave script today (`.claude/workflows/wave-0-bootstrap.mjs`) and the plan §7.2 example both have that
shape, so failing on absence would break W0-DOC-01's acceptance.

**6 — The PR-body parser fails closed, on four rules.** Code blocks are stripped before parsing;
there must be exactly one `## Ownership` section; exactly one `Owns globs:` line; and a whole-repo
declaration is refused. Every unmodelled markdown case — fences inside list items or block quotes,
HTML comments — reads as absent or ambiguous and exits 1.

The gate's *scope over source files* is a separate decision and is recorded in
[ADR-0008](0008-suppression-gate-scope.md).

## Alternatives considered

- **A published glob library (`minimatch`, `picomatch`).** Rejected under spec §40: it is not on the
  reserved list, and the four constructs actually used are well inside the ~50-line rule.
- **A blacklist of forbidden glob spellings for the whole-repo guard.** Rejected because it is walked
  around by respelling — `**/**`, `**/?*`, `**/*.*` all mean "everything" and none of them is `**`.
  Decision 2 exists because enumerating spellings cannot work.
- **Dropping question (c) and checking only "reaches everything".** Rejected: `*/**` passes that and
  is a whole-repo claim in all but name.
- **Importing the wave script to read a runtime ownership manifest.** Rejected: it throws at module
  scope (Decision 4), and executing an agent-authored script inside the gate that polices it inverts
  the trust relationship.
- **Failing `--plan` on a script with no declarations** (instead of Decision 5). Rejected as a
  unilateral change to another task's acceptance criteria — but see Consequences, it must be decided
  before Wave 1 is planned.
- **Being permissive in the PR-body parser** — accepting the first `## Ownership` section, ignoring
  duplicates. Rejected: a body that quotes the Appendix B template would then pass the gate on the
  quotation.

## Consequences

- **Unsupported glob syntax owns nothing.** `!` negation, extglob and POSIX classes are matched
  literally rather than being silently ignored, so a declaration using them fails closed on the
  author, not on the reviewer. That is the intended direction, but the error will read as a
  mysterious "diff escapes Owns" rather than "you used syntax I do not support".
- **The whole-repo guard is a deterrent, not a proof.** The probe set is finite; a glob crafted to
  match every probe and nothing else would pass. §2.3 still rests on a human reading the wave plan.
  Anyone who assumes the guard is a proof has misread it.
- **A runtime-built ownership manifest is invisible** to the static parser. The checker reports
  "no ownership declarations found" rather than passing a real clash silently — but under Decision 5
  that report is a warning, so the two together mean a wave script *can* be planned with its
  ownership entirely unchecked. **This must be resolved before Wave 1 is planned**; the fix is either
  declarations added to the bootstrap script or a one-line change in the checker, and it belongs to
  whoever owns that file.
- **A legitimate PR body can be rejected** and need reformatting. Accepted as the cost of the
  quotation hole staying shut.
- **PR #6's reasoning lived only in a PR body for the length of Wave 0**, because the agent that took
  these decisions could not write to `docs/adr/`. Task ownership and decision ownership are not the
  same thing, and the integrator has to close that gap by hand at every wave close. If a wave
  integrator ever skips it, the reasoning is lost when the PR is closed.
- **Reversing Decision 1 is cheap** — swap the matcher for a library and the 102 self-test assertions
  tell you whether the dialect changed. Reversing Decision 2 is not: every wave plan already merged
  was accepted under this definition of "everything", and a stricter guard would retroactively
  condemn declarations that were legitimate when written.
