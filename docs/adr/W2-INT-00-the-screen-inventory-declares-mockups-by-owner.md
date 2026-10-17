# ADR-W2-INT-00 — The screen inventory declares every mockup by owner, in four states, and derives "which wave" from the plan

Status: accepted
Date: 2026-09-04
Decided by: W2-INT-00 (implementer)
Scope: `tests/screen-inventory.test.ts`, `tests/screen-declarations/**`

## Context

Plan §1 requires *"a screen-inventory test asserting every `ui/*.html` page has a route"* and §9.1
lists it as a blocking per-PR gate. It did not exist. Plan §10's risk 10 is that *"the UI drifts from
the mockups, and the calm/sparse property of §43 is lost one convenience at a time"*, and names the
screen inventory as one of its three countermeasures; Wave 2 ships four parallel UI tasks.

[ADR-0025](0025-the-route-inventory-is-partitioned-by-owner.md)'s final consequence says the screen
inventory *"has the same shape and gets the same treatment: `tests/screen-declarations/<TASK-ID>.ts`,
built by the same task"*. It says nothing about what an entry contains, and the interesting part is
what to do about the mockups that are not built yet. `git ls-files -- ui` tracks far more `ui/*.html`
than `apps/web/app` tracks pages. Most of the difference belongs to Wave 3, 4, 5 or 7; two of the
files are not product screens at all (`ui/index.html` is the mockup index — plan §1.2 calls it the
screen inventory — and `ui/landing.html` is the marketing site plan §1.4 puts out of scope); and
three are named by no task card anywhere.

The task brief is explicit that the gate *"must distinguish 'declared as belonging to a later wave'
from 'missing', and NOT silently pass an undeclared one"*. The trap is that "belongs to a later wave"
is a claim, and a wave number written by hand is exactly the measured-number-in-prose that
[ADR-0016](0016-measured-numbers-do-not-live-in-prose.md) forbids.

## Decision

1. **Four states, no default, and a classifier that ends in a throw.**
   * `shipped` — names the `route` and the `page` file. Both are checked: the page must be in the
     tracked `page.<ext>` set, and the declared route must equal the URL Next.js serves that file
     from, derived with the same segment mapper the route inventory uses.
   * `planned` — names a `wave` and a `because`.
   * `unplanned` — names a `because` only.
   * `not-a-screen` — names a `because` only.

   Each state also *forbids* the fields the others require, so an entry cannot say both `page` and
   `wave`; that is two claims, one of which is wrong.

2. **Every state is decided against the plan, by a classifier that ends in a throw.** The gate
   reads the development plan and every tracked Wave N plan, and attributes each
   `ui/<name>.html` mention to a wave: in the main plan, to the enclosing `### … Wave N …` section,
   so the document's introduction — which links `ui/index.html` — schedules nothing; in a dispatched
   wave's own plan, to the wave in the filename. Then:
   * a `planned` entry whose wave is not among the waves that name its mockup **fails**;
   * an `unplanned` entry that some wave section *does* name **fails**;
   * a `not-a-screen` entry that some wave section *does* name **fails**: a task card that builds a
     screen from the mockup is the plan calling that file a screen;
   * a `shipped` entry is decided here as *nothing to check*, because what backs it is the tracked
     tree rather than the plan — decision 1 requires its `page` to be in the tracked page set and
     its `route` to equal the URL Next.js serves that file from.

   So the number is a citation the gate can check, not an estimate. The first two clauses stood
   alone for three rounds, as two `if`s with no `else`, and a verifier walked out between them:
   `not-a-screen` was a status no branch examined, so a mockup the Wave 2 plan schedules
   could be declared not a screen at all — and it dropped out of the `ui/index.html` cross-check
   too, which excludes `not-a-screen` by name — while every assertion in the gate passed. The four
   clauses are a classifier now, and its fall-through throws, so a fifth state added to
   `ScreenDeclaration` without a branch fails to compile rather than opting out of the check.

3. **`unplanned` is a real state, and its members are derived on every run rather than listed.** The
   mockups that carried it when this was written are `ui/agent.html` (the agent detail screen of
   spec §18), `ui/run.html` (the run detail reached from the Runs list — `ui/agent-run.html` is a
   different screen and W1-UI-03 shipped it) and `ui/runs.html` (W6-CP-06 schedules "the minimal Runs
   list" but names no mockup). Writing `wave: 'W6'` on any of them would have been a claim with
   nothing behind it, and so would writing that list into the gate: the assertion compares the
   declared `unplanned` set against the set of declarations no wave section of the plan names, both
   derived at run time and in both directions, and its failure message prints the derivation. When a
   wave's task card claims one, the declaration moves to `planned` and the set shrinks with no edit
   to `tests/screen-inventory.test.ts` — see
   [W2-INT-00-a-gate-derives-its-partition-from-the-tracked-tree.md](W2-INT-00-a-gate-derives-its-partition-from-the-tracked-tree.md),
   which repaired the three-element literal that used to make that sentence false.

4. **Both directions are asserted, plus a third set.** Every tracked mockup must be declared; every
   tracked page must be named by a `shipped` declaration — a page nobody declared is a screen the
   mockups never described. And because plan §1.2 calls `ui/index.html` the screen inventory, the
   gate asserts that the mockups it links are exactly the mockups declared as screens: two
   independently maintained lists of one thing, compared.

5. **Wave 2's four UI tasks get their deferrals seeded into their own declaration files;
   later waves' go in `tests/screen-declarations/W2-INT-00.ts`.** `W2-UI-08`…`W2-UI-11` are
   dispatched task ids in the Wave 2 plan, so `tests/screen-declarations/W2-UI-08.ts` exists
   already, with a `planned` entry and a note saying how to flip it. Shipping the screen is then an
   edit inside that task's own `Owns` glob — which is the whole point of the partition, and four
   parallel tasks editing one deferral list would be
   [ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md)'s union failure in a new
   costume. Waves 3, 4, 5 and 7 are not dispatched and their task ids are the plan's guess, so their
   rows stay with the inventory until the wave that owns them repartitions — exactly as W2-INT-00
   repartitioned Wave 1's route entries out of `tests/route-inventory.test.ts`.

6. **`ui/agent-run.html` and `ui/home.html` both declare `apps/web/app/(shell)/page.tsx`.** That is
   spec §19.5 rule 5, not a mistake: `home-chat.tsx` returns `RunView` once a run has started, so one
   page serves two mockups. The uniqueness rule is therefore on the *mockup*, not on the page.

## Alternatives considered

* **Derive the mockup→route map from the tree.** That deletes the gate, for the reason ADR-0025
  gives about the route half: the value is that the two lists are produced independently.
* **Put every deferral in one file owned by the inventory.** Simpler today, and it makes each of
  Wave 2's four UI PRs edit that one file to flip its entry. Rejected on ADR-0019.
* **Seed a declaration file for W3-UI-08, W4-UI-09 and the rest as well.** Rejected: those waves are
  not dispatched, and a file named for a task id that no dispatch has issued asserts something that
  is not so.
* **Give the three unscheduled mockups a plausible wave.** Rejected under ADR-0016 — and the gate
  would now catch it, because no wave section names them.
* **Let `unplanned` fail the gate.** Rejected: it would make this PR red for a gap in the plan that
  this task cannot close, and the honest instrument is a declared, enumerated finding rather than a
  red build nobody can turn green.

## Consequences

* The gate is green today with three `unplanned` mockups listed by name in its output and in this
  PR's declared gaps. When a wave schedules one, the `planned` conversion is checked against the plan
  text, so the gap closes visibly rather than quietly.
* Every UI task from here on ships a declaration file, and `pnpm test` tells it so the first time it
  adds a page: the "declares every page that ships" assertion fails with the page named.
* Renaming a mockup breaks the gate twice — once as an undeclared mockup, once as a declaration
  naming a file git does not track. That is intended; a mockup rename is a design change.
* The plan parser is coupled to the plan's heading shape (`### <n.n> Wave <N> — …`) and to task cards
  naming mockups as `ui/<name>.html`. If a future plan stops doing either, `planned` entries start
  failing rather than passing, which is the right direction to break in.
