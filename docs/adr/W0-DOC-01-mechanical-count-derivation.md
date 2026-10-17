# W0-DOC-01 — Counts in governance prose are derived mechanically, not by eye

Status: accepted · Date: 2026-09-03 · Task: W0-DOC-01 · Run: `wf_cd3224ab-821`

## Context

Neither `docs/spec.md` nor the development plan says anything about how a number written in
prose is obtained, so this was undetermined and had to be settled.

It needed settling because the same defect shipped three times in a row on this branch. Every time
a workflow recording was added under `.claude/workflows/`, the author updated the inventory table
and left a count elsewhere at its old value:

* round 1 — `.claude/workflows/README.md`'s "Committed recordings" table listed five files while
  six were committed in the same commit;
* round 2 — the waves README said "the other four committed recordings lint clean" when there
  were five others;
* round 3 — PR #8's body carried a five-row table under a sentence reading "Six recorded workflow
  scripts", and an Acceptance line saying "there are five" directly above pasted output reading
  "over 6 script(s)".

Each was individually trivial and each survived a verifier pass. The common cause is not
carelessness about any one number: it is that the numbers were read off the page the author was
looking at rather than off the filesystem, so a count could only ever be as fresh as the last
person who happened to re-read that particular sentence. Adding an eighth recording would have
produced a fourth instance.

## Decision

**A count that describes files in this repository is written by running the command that produces
it, and the command is written down next to the number.** For the governance files W0-DOC-01 owns,
the two commands are:

```
ls .claude/workflows/*.mjs | wc -l                                     # committed recordings
grep -lE '^\s*(/\*|//) *eslint-disable' .claude/workflows/*.mjs | wc -l  # real suppressions
```

The invariant is stated in `.claude/workflows/README.md` immediately under the inventory table,
where the next author to add a recording will be standing, and the derivations are pasted inline in
the waves README and the Wave 0 manifest.

The second command matters on its own: a plain `grep -l eslint-disable` over these files returns
three, because two recordings *name* the string in prompt text telling agents not to use it. A
count of suppressions must anchor the directive to the start of a line or it silently triples.

## Alternatives considered

* **A CI gate that fails when the README table's row count differs from `ls | wc -l`.** Stronger,
  and the right end state. Rejected for this pass: the gate belongs in `.github/workflows/ci.yml`,
  which is W0-INF-02's Owns, not W0-DOC-01's, and Wave 0 has already paid for one task reaching
  into another's files. Carried as a proposal rather than done unilaterally.
* **Delete the counts and let the tables speak.** Would remove the failure mode entirely, but the
  prose sentences that carry the counts ("the other six lint clean and carry no disable") are the
  places a reader actually forms a belief; a table alone does not say that.

## Downside, stated plainly

This is a convention with no enforcement. It rests on the next author reading a paragraph in a
README, which is exactly the mechanism that failed three times. It reduces the cost of getting it
right and makes a stale number obvious in review — the command is right there to re-run — but it
does not make one impossible. Only the CI gate above would, and that gate does not exist.

## Note on where this file lives

`docs/adr/**` is not in W0-DOC-01's Owns string; the run-7 integration agent is the writer of
`docs/adr/README.md` and of the numbered `NNNN-` records. This file is a task-level record named
for its task, written here because the closeout brief requires each task to record its own
undetermined decisions and `docs/adr/<task-id>-<slug>.md` is the path it names. It is declared in
PR #8's Ownership section as `docs/adr/W0-DOC-01-*.md`, which is what makes
`node scripts/check-file-ownership.mjs --pr` pass on this PR. Note that the `owns:` string for
W0-DOC-01 inside the committed `wave-0-bootstrap.mjs` recording does *not* list `docs/adr/`, and
cannot be edited after the run (§2.1 rule 3), so the recording and the PR body disagree by
construction; the PR body is the one the gate reads.

`docs/adr/README.md` **does** exist on this branch — it arrives with the base branch
`aw/w0-02-ci`, alongside records `0000`–`0005` and
`W0-INF-02-probe-set-derived-from-the-tracked-tree.md`, and this record follows the shape of that
sibling task-level record. It is deliberately **not** added to that README's index table: the table
is the run-7 integration agent's file, and editing it would be exactly the reach into another
task's Owns that "Alternatives considered" above declines. The index row is a proposal for run 7,
not a change made here.
