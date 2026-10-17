# W0-INF-02 · The whole-repo ownership probe set is derived from the tracked tree

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** W0-INF-02
- **Context task:** W0-INF-02

## Context

`scripts/check-file-ownership.mjs` refuses a PR whose `Owns globs:` line amounts to a claim on the
whole repository, and it decides that semantically: it asks `matchGlob` what a declaration MATCHES,
against probe paths spread across the tree, rather than blacklisting spellings like `**` and `*`.
That part is right and is not in question here — a blacklist of spellings is not a guard, because
`**/**`, `**/?*`, `**/*.*` and `{**,docs}` are all the same claim wearing different clothes.

The probe paths themselves were a hand-written literal:

```js
const NAMED_AREAS = [
  ['apps/web/app/page.tsx'],
  ['packages/core/src/db/migrations/0001_init.ts'],
  ['.github/workflows/ci.yml'],
  ['<development plan path>'],
  ['scripts/check-licenses.mjs'],
];
```

commented "The top-level directories that exist today". There are six tracked top-level directories,
not five. `ui/` has been tracked since the repository's initial commit — the same commit that added
the plan the comment cites — and the plan names it as a first-class input (§1.2's inputs table:
"`ui/*.html` + `ui/assets/app.css`, `ui/assets/app.js`"; §9.1's spec-inventory gate: "screens =
`ui/*.html`").

The hole was not confined to a comment. Two of the three user-facing reason strings were written out
of the same five-name list, so the gate would tell an author

> it matches a file in every area of the repository (root, apps, packages, .github, docs, scripts)

about a declaration matching nothing at all under `ui/` — `ownsEverything(['apps/**', 'packages/**',
'.github/**', 'docs/**', 'scripts/**', '*.*'])` returned that string while
`matchAny(thatSet, 'ui/index.html')` was `false`. Four rounds of review have now found a claim in
this file that the tree contradicts, which says the defect is the hand-maintenance, not any
particular literal.

## Decision

Derive the probe set from the tracked tree, and build the reason strings from that same data.

- `areasFromTree(files)` groups `git ls-files` output into the repository root plus one area per
  tracked top-level directory. Each directory area carries its shallowest and its deepest tracked
  path, so "does this declaration reach into that directory" is asked at two depths rather than at
  one path someone once picked.
- Question (a) probes the root and every derived directory, and refuses a declaration that reaches
  the root and leaves **at most one** directory unreached — it counts the misses rather than
  demanding every area (see "The quantifier, not the list" below). Question (b) probes every tracked
  root file. Question (c) probes every derived directory plus `a-directory-no-task-declared/…`,
  which by construction exists in no tree.
- Every reason string interpolates the derived names: `(root, ${dirs})`, the root file list and its
  count, the tracked directory list. A directory added tomorrow enters the probe set and the
  messages in the same breath.
- The tree is read once and memoised. If it cannot be read at all — no `git`, or an unpacked tarball
  — a four-path `FALLBACK_TREE` stands in.

## The quantifier, not the list

Deriving the set alone made the gate **weaker than the literal it replaced**, and the first version
of this record did not see it. Question (a) read `NAMED_AREAS.every(area => area.some(hits))`, and
`every` is anti-monotone in the size of the set it quantifies over: each area added is one more
place a declaration can fall short and be waved through, so a complete list refuses strictly less
than an incomplete one. Completing the list weakened the guard by the same stroke that made it
honest.

Measured on this branch by running both versions of `ownsEverything` side by side over `*.*` plus
every tracked directory but one, for each of the six directories in turn:

| declaration | hand-written five-name list | derived set, `every` |
| --- | --- | --- |
| every area except `ui` | REFUSED | accepted |
| every area except `.github` / `apps` / `docs` / `packages` / `scripts` | accepted | accepted |
| every area, root included | REFUSED | REFUSED |

The literal was not strong, it was short: `ui` was the one name missing from it, so `ui` was the one
omission it happened to catch, and it waved the other five through exactly as the derived version
does. Restoring the literal would restore one row of that table and nothing else.

So question (a) counts what a declaration MISSES instead of demanding it miss nothing. One unreached
area out of many is a rounding error, not a scope, and under `every` an author who wanted the gate
gone need only leave the smallest tracked directory off the line — or add a one-file directory in an
earlier PR and leave that off. A second clause requires at least two areas reached, so the rule does
not degenerate on a tree with a single top-level directory, which is what `FALLBACK_TREE` is.

## Alternatives considered

- **Add `['ui/index.html']` to the literal and reword three strings.** Rejected. It is the fix for
  this instance and not for the class; the next top-level directory puts the strings back into the
  state four review rounds have already objected to.
- **Read the directories from the filesystem (`readdirSync`) instead of from git.** Rejected. It
  would probe untracked and ignored directories — `node_modules/`, `.next/`, a scratch folder — so
  the answer would depend on the state of a working copy rather than on the repository.
- **Drop question (a) and rely on (b) and (c).** Rejected: it is (a) that catches `**/*.*` and
  `**/?*`, the spellings that answer (b) NO because they miss extensionless `LICENSE`.
- **Keep `every` over the derived set and put `ui/` back in a literal.** Rejected, and it is the
  fix this record's first version effectively shipped. It restores one row of the table above and
  leaves the escape hatch open for every other directory, including the next one anybody adds.
- **Judge by the count of tracked files a declaration matches** rather than by areas, which would be
  immune to a one-file decoy directory. Rejected on measurement, not on taste. Counted over the 128
  tracked files on this branch, the weakest whole-repo shape — every area except `docs`, plus the
  root — matches 78 of them; the scoped `docs/**`, `ui/**` matches 78 as well, and `*.*`, `docs/**`,
  `ui/**` matches 90. The two populations overlap, so no threshold separates them. Areas are the
  unit §2.3 hands out; files are not.

## Consequences

- Adding a top-level directory no longer weakens the gate. Under `every` it did: a declaration that
  enumerated every previous directory stopped answering question (a) yes the moment a new directory
  existed, so one new directory — a one-file directory an author could add in an earlier PR —
  disabled the guard for every declaration. With the misses counted, one unenumerated directory
  still answers (a) yes; it takes two before a declaration is treated as scoped.
- The cost of that is a real over-refusal: on a tree with three top-level directories, an honest
  task owning two of them plus the shared root is refused and has to escalate. That is the direction
  to err in, and it narrows as the tree grows — this repository has six.
- The self-test pins both sides, derived so the fixtures cannot go stale: the "every area except
  exactly one" shape is asserted REFUSED for each tracked directory in turn, and "every area except
  two" (each directory paired with its neighbour), plus each single directory with and without the
  root files, are asserted to parse. The second set is what stops the spread widening from "all but
  one" to "all but two" the next time somebody tightens this.
- The reason strings are longer. Question (b) now names all thirteen tracked root files instead of
  four representative ones. Accuracy is worth the width here: this is a message an author reads once,
  when they are being told their PR is refused.
- `ownsEverything()` runs a `git ls-files` subprocess on first call. It is memoised for the process,
  and both other modes already shell out to git.
- `FALLBACK_TREE` yields two areas — the root and `scripts`. No count of the real tree is written
  down beside it, in the code or here: any such number is wrong the day someone adds a top-level
  directory, and this record's first version said "seven", which was true on this branch and false
  one branch up. With a single named area, question (a) cannot fire, so under the fallback it is (b)
  and (c) that refuse the whole-repo spellings; a refusal reason naming only `scripts` is a signal
  that git could not be read, not a real whole-repo claim.
- `docs/adr/README.md`'s index is owned by the wave integrator, so this record is not listed there
  yet. Declared as a gap on the PR.
