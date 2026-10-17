# ADR-0027 — A gate whose partition is enumerated by a literal has not been partitioned; membership is derived from the tracked tree by shape

Status: accepted
Date: 2026-09-04
Decided by: orchestrator, after verification found the same defect in three gates in one round
Scope: every repository-wide gate that reads a set of contributing files

## Context

[ADR-0025](0025-the-route-inventory-is-partitioned-by-owner.md) split the route inventory into
per-task declaration files so that six parallel tracks could each ship routes. W2-INT-00 implemented
it, and its verifier found this, at `tests/route-inventory.test.ts`:

> The gate hard-codes the exact list of tracked route-declaration files, so any Wave-2b track that
> adds `tests/route-declarations/<TASK-ID>.ts` turns `tests/route-inventory.test.ts` red. That file
> is outside every 2b track's `Owns` globs, so **no track can turn it green.**

That is precisely the alternative ADR-0025 rejected in writing, reintroduced by the task built to
avoid it, and it falsifies that ADR's stated consequence. The same verifier found the same shape a
second time on the screen half. The task did not fail for want of care — it wrote the ADR's rule
into its own header comment and then enumerated the partition three lines below it.

A third instance arrived from an unrelated direction the same round. `tests/no-sdk-import.test.ts`
(spec §42) permits SDK imports from the boundary file plus `RESEARCH_PROBES`, **a literal list
naming R-01's three probe scripts**. R-06's probes import the SDK, so R-06's PR went red on a gate
whose data file R-06 is forbidden to touch. R-06 escalated rather than editing it, which was
correct: `git log -S RESEARCH_PROBES` shows every previous entry was added by the gate's owner after
the research landed, never by the research PR.

Three gates, three authors, one shape. The common error is not the list — it is that **membership
was decided by naming members rather than by a rule that recognises them.** A named list is a shared
mutable resource, and every mechanism in this programme exists to not have one.

## Decision

1. **A gate derives its contributing set from the tracked tree by shape, never from a literal.**
   `git ls-files -- <dir>` plus a filename rule, the same tracked-tree discipline these gates already
   use for the thing they are checking. A file's *presence at the right path* is what makes it a
   contributor.
2. **The shape rule is a classifier that ends in rejection** ([ADR-0015](0015-gates-decide-on-positive-assertions.md)).
   A file in the directory that does not match the shape, or that exports nothing readable, is a
   **hard failure naming the file** — never a skip, never silently dropped. `route-inventory`'s
   `classifyAppFile` already does this for `route.<unknown-ext>`; it is the model.
3. **A filter is not a classifier.** `MOCKUP_PATH = /^ui\/[a-z0-9-]+\.html$/` used to *filter*
   `git ls-files -- ui` drops a mockup named with an underscore and passes the gate. Used to
   *classify*, with an `else` that throws, it cannot. Every regex applied to a tracked-tree listing
   in a gate is a classifier, and the difference is one `else`.
4. **`RESEARCH_PROBES` is replaced by the same rule**, as a task of this wave: a tracked file under
   `docs/research/fixtures/**` is a research probe. A note's probes then arrive with the note, and no
   research PR needs to touch a gate it does not own. Assigned to `W2-INT-01`, based on
   `aw/w2-00-plan`, owning `tests/no-sdk-import.test.ts` alone.
5. **The escalation was right and is the standard.** R-06 stopped and reported rather than editing a
   file outside its declaration. A red gate that belongs to somebody else is escalated, not fixed —
   the opposite is how ownership stops meaning anything.

## Alternatives considered

* **Have the integration task add each new declaration file to the list as the wave proceeds.**
  Rejected: it is the enumeration with an extra human step, and it means no track is green on its
  own — the property the stack exists to provide.
* **Let a track edit the gate to register itself.** Rejected: the gate becomes writable by every task
  it constrains. `git log -S RESEARCH_PROBES` shows the repository has never done this, and the one
  round it was tempting is the round it produced three failures.
* **Glob the directory at run time without a shape rule.** Rejected: that is derivation without
  classification, and an unreadable or misnamed file then contributes nothing while the gate stays
  green — the fail-open ADR-0015 exists for.

## Consequences

* A gate's failure output must now print the derived set, because a reader can no longer find it by
  reading a literal. Each of these gates already prints its sets on failure.
* Adding a task to a wave requires no edit to any gate. That is the property being bought.
* A directory of declaration files becomes load-bearing: deleting one silently removes routes from
  the expected set. The equality assertion against the shipped tree catches exactly that, which is
  why the derivation is safe here and would not be for a gate that only checks a subset.
* This ADR was written **mid-repair-round**, so the branches being repaired do not contain it. Its
  rule is pasted into each repair brief verbatim rather than cited by path.
