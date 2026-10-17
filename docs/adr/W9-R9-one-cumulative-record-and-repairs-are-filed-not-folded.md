# W9-R9 — The cumulative Wave 9 review is one record, its repairs are filed rather than folded, and its base SHA is corrected

Status: accepted
Date: 2026-09-14
Decided by: W9-R9 (reviewing agent, issue #187)
Scope: the Wave 9 review record; this record; `docs/adr/README.md` (regenerated)

## Context

Issue #187 is step 9 of the Wave 9 resumption: run the final cumulative post-W9.7 review that was
skipped when Wave 9 paused, over the range `main`-before-the-first-W9.5-merge → `main`-after-step-8,
and leave evidence step 10 can consume. The Wave 9 manifest and
the Wave 9 status report both record that review as **not run**.

The following things about the task were not determined by the issue text and had to be decided.
Decision 7 was added after the Owner adjudicated SWT-12 on 2026-09-14.

## Decision

**1. One record (the Wave 9 review record), not three.** The Owner's 2026-09-14 comment names one
review record; the acceptance criterion *"Review commands, exact SHAs, outputs, and limitations are
preserved … no run is reconstructed"* needs a single addressable artefact, and the cross-area gate
*"no undisputed blocking finding remains on `main`"* is unlocatable if it is split across three
files. The three areas are independent **sections**, each with its own `ranClean` statement, inside
one file. No wave review record existed before this one; its shape is borrowed from
`docs/release/security-review-0.1.0.md` (findings table, `CMD-nn`/`OUT-nn` evidence pairs, coverage
partition, limitations), which is the in-tree precedent for exactly this kind of preserved run.

**2. The base SHA is `4f9ec79e7fbbdff7d235f855463cce1ea6709f29`, and the correction that produced it
is recorded rather than silently substituted.** The prefix #187 originally spelled had `c` for the
ninth character where the commit has `e`, and a prefix spelled that way resolves to nothing —
`git cat-file -t` answers `fatal: Not a valid object name` for it and `commit` for the full SHA. The
commit the Owner describes is `main` after the #158 plan amendment and immediately before the first
W9.5 merge, which is that full SHA; the Owner confirmed it on 2026-09-14. Every SHA in the record
inherits it, and both `git cat-file` invocations — the failing one included — are preserved in the
record's evidence section rather than the correction being applied quietly. `headSha` needed no
correction.

**3. Repairs are filed, not folded.** The Owner's direction is explicit ("do not fold fixes into the
review PR"), and
[0018-the-declared-owns-line-is-the-ownership-boundary](0018-the-declared-owns-line-is-the-ownership-boundary.md)
makes it mechanical: a review PR's `Owns globs:` are documentation, so a product fix inside it would
touch files it does not own and fail `scripts/check-file-ownership.mjs`. Each confirmed blocking
finding is a ready-to-file block — title, `file:line`, runnable repro, smallest fix, `Owns globs:` on
one physical line, and a disjointness note — in the record's "Repair issues" section. Two blocks,
R-1 and R-3, are confirmed blocking findings and are the same root-cause property at two modules;
they are filed separately, not merged, because their `Owns globs:` are disjoint and ADR-0018 makes
that line the boundary a repair cannot reach past. A third, R-2, is offered to close a class an ADR
already declares open and is labelled as **not** a new finding.

**4. A declared gap is `refuted-as-declared`, and that is a first-class outcome, not a pass.** #187's
Out of scope forbids turning G-1…G-12 into blockers *unless the code contradicts the declaration*, so
the claim schema has three outcomes rather than two, and the twelve gaps are swept **one row at a
time with `file:line` evidence** rather than waved through in a sentence. The same treatment is given
to ADR-recorded decisions. Where a declaration is an admission of an open defect rather than a claim
of correctness — `W9-TEAM-185` decision 8's "the class is open" — the record says so in those words,
so `refuted-as-declared` is never read as "fine".

**5. "Independent reviewer" means an agent that implemented none of the reviewed changes, and the
adjudicator reviewed no area.** Three area agents plus an adjudicator; this session implemented none
of #159–#198, so independence is satisfiable from a fresh agent per area. Sensitive-class claims
(tenant isolation, identity substitution, credential/token handling, repair regression) carry two
verifications with different verifiers and different evidence. All four agents ran on the same model
family, because this session could not select another; the W9.5 Opus/Sonnet split
([0051](0051-alternate-model-reverification-is-required-after-a-repair.md)) was therefore **not**
reproduced, and the record says so under Limitations instead of implying it was. ADR-0051 binds the
repair PRs, and each repair block repeats the requirement.

**6. A claim no verifier could execute is not settled by the verifier who could not execute it.**
The area agent for projects and agents raised a claim it had neither a database nor file-creation
rights to run, and — correctly, under the record's own "a confirmed finding needs a failing repro"
bar — recorded it as `refuted`. The adjudicator, which could run it, ran it; the claim survived and
is recorded as `confirmed` (PRJ-06). The probe used to run it was a throw-away test file, deleted
immediately, and the PR's diff is documentation only.

**7. A root cause is enumerated across the whole repository, not across the module the finding was
found in; and `ranClean: true` means "the question was put and answered", not "no claim exists".**
R-1 states its root cause as a property — *no caller-supplied path segment reaches a `uuid`
comparison without a shape guard* — and then enumerated it only over the projects module, which is
where PRJ-06 was found. `PATCH`/`DELETE /api/memberships/:id` crosses the same property and appeared
**nowhere** in the record's first two revisions: not as a claim, not in R-1's "Do not broaden", not
in "Not filed". Area 1 therefore read `ranClean: true` on the sentence "no claim in this area is
`confirmed`", which was true, and wrong. The pull request's review found the site by re-deriving the
property from the code; the Owner adjudicated it on 2026-09-14. It is now claim SWT-12 with the full
claim schema, Area 1 is `ranClean: false`, and the repair is R-3 — filed separately from R-1 because
their `Owns globs:` are disjoint. The same failure then recurred one export over: the revision that
added SWT-12 promoted R-1's enumeration to a totality claim while excluding `DELETE
/api/api-keys/:id` by name, and the pull request's re-review found that site crossing the same
property in the same file R-3 repairs. It is claim SWT-13, and its repair is folded into R-3 rather
than filed as a fourth issue, because it needs the same guard in the same two files.

Two rules this settles, and they are the part that outlives #187. **An enumeration scoped to the
module the finding was found in is not an ADR-0048 enumeration**; R-1's is now a table covering
every site of the property, with a disposition against each. And **pre-`baseSha` is a reason a
finding is not *this range's regression*, never a reason it is not a finding** — #187 asks what is
true on `main` at `headSha`. Where a pre-`baseSha` site is adjudicated anyway — as SWT-12 and SWT-13
are, because their files are inside the range's diff and inside the area's partition bucket — the
blame that establishes "pre-`baseSha`" is recorded with the claim so the disposition is reviewable;
where it is not, it goes in "Not filed" with the same blame, not into another finding's prose and
not nowhere.

## Consequences

- The review PR's diff is exactly three files: the Wave 9 review record, this record, and the
  regenerated `docs/adr/README.md`. No product code, no migration, no route; `pnpm build` and the
  product suites cannot regress from it.
- **The Wave 9 manifest, the Wave 9 status report and
  the waves README become stale** the moment this record lands: all three still say the
  cumulative review was not run and that W9 is paused after W9.6. None is inside the Owner-named
  deliverable, and the Wave 9 status report is assigned to no task in any wave. They are left
  and the staleness is stated under the record's Limitations (Open questions 2 and 3, defaults
  taken). Correcting them belongs to the Wave 9 close-out, step 10.
- Files in the range outside the three named product areas — `.claude/skills/indx-*/SKILL.md`,
  `.github/workflows/indx-dev.yml`, `scripts/check-workflows.mjs`, `tests/e2e/results/**` (PRs #179,
  #180, #192) — are listed in the coverage partition as **explicitly not reviewed**, with the reason,
  so the partition stays honest rather than implying coverage it does not have.
- `scripts/check-file-ownership.mjs --pr` cannot be run by the producing session, because this run is
  forbidden to commit and the diff exists only in the working tree. It runs in pull-request CI, which
  is where it is load-bearing; the record states this rather than reporting a gate it did not run.

## Alternatives rejected

- **Three records, one per area.** The Owner named one, and a cross-area gate needs one place to
  fail.
- **Recording the review only in issue comments.** Step 10 needs a durable prerequisite artefact on
  `main`; comments are not `main`.
- **Fixing PRJ-06 inside this PR.** Forbidden by the Owner and by ADR-0018's ownership boundary.
- **A review-record generator or linter.** A speculative layer with no second consumer; the two
  mechanical gates this work needs — `docs/adr/regenerate-index.sh --check` and
  `scripts/check-file-ownership.mjs` — already exist.
- **Reviewing the 268-file range as one undifferentiated pass.** #187 requires the areas reviewed
  independently, and a single pass cannot produce per-area `ranClean` statements.
