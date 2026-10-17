# ADR-0048 — A repair is applied at every site the root cause reaches, and the sites are enumerated from the code

**Status:** accepted
**Date:** 2026-09-07
**Scope:** programme
**Context:** four tasks, two sub-waves, the same round lost the same way

## Context

Four repair rounds in two sub-waves have now failed for one reason: **the repair was applied where
the counter-example pointed, and not at the other places the same root cause reaches.**

| Task | Repaired | Left defective |
| --- | --- | --- |
| W2-CP-04 | the admission grammar and the case-fold collision check, on `POST /api/skills` and on `PATCH`'s `removeFiles` | `PATCH`'s `files` array — the third place a caller-supplied path becomes a `store.put` key |
| W3-QA-02 | A.12 scenarios 3 and 9, on the volume-mount branch | the `putFiles`/`getFiles` branch — the one W3-CP-07 and every managed cloud driver take |
| W3-CP-06 | a gate pinning the §14.2 driver catalogue, over two of its four hand-typed copies | the copy that actually rejects, which stayed unpinned |
| W2-CP-05 | the `process-died` message path | `server-refused`, `unknown-failure` and `sse-stream-failed`, which interpolate the same child-controlled text |

W2-CP-04's is the sharpest, because the machinery was *already correct*. Its confirmer wrote: *"The
check exists and works; it simply is not run on the route B1 lives on."* Two entries in, one file out,
the survivor carrying the other entry's bytes, `200` — the frozen list's own sentence, reproduced on a
route nobody had probed. And the repairer's own adversarial strings — zero-width space, RTL override,
`SKILL..md`, `CON` — were all aimed at the two sites it had fixed.

That is the mechanism. **A counter-example is a witness to a class, and the repairer treats it as the
class.** Every one of these rounds ended with the named input refused and the class still open, and
the next round's confirmer found the sibling in minutes.

## Decision

**A repair enumerates the sites its root cause reaches, from the code, and is applied at every one.
The enumeration is written down and asserted, not remembered.**

Three steps, in order:

1. **State the root cause as a property, not as an input.** Not *"`SKILL.md::$DATA` must be refused"*
   but *"no caller-supplied string becomes a store key without passing the admission grammar."* The
   property names a boundary; the input was only how it was discovered.
2. **Enumerate the crossings from the code.** Find every place the property must hold — every call
   site, every branch of a branching gate, every copy of a duplicated list. `grep` for the sink, not
   for the symptom: every `store.put`/`store.delete` whose key came from a request; every branch of
   the scenario; every declaration of the catalogue.
3. **Make the enumeration a gate.** A test that derives the sites and asserts the guard runs at each
   one — so a site added later fails rather than joining silently. This is the same rule as *derive
   the list from the source*, applied to call sites instead of to data.

Where step 3 is genuinely not mechanisable, the enumeration is written into the code beside the guard
as an **exact list with the reason each entry is on it**, and the honest statement of the limit is
that the list is hand-maintained (ADR-0031). That is weaker, and it must be declared as weaker.

## What this changes for a verifier

A verifier that has reproduced the named counter-example has done the easy half. **The productive
question is: where else does this reach?** Every finding in the table above was found by asking it,
and none was found by re-running the input the previous round was given.

So a repair round's confirmation must include the enumeration: *these are the sites, here is how I
found them, here is each one driven.* A confirmation that only re-runs the frozen counter-example is
not a confirmation — it is the previous round repeating itself.

## Consequences

* A repair costs more up front and stops costing an entire round afterwards. Four rounds across two
  sub-waves is the measured price of not doing this.
* It composes with [ADR-0046](0046-a-gate-may-not-assert-a-value-its-own-probe-fabricated.md) and
  [ADR-0047](0047-a-probe-establishes-its-own-precondition-it-never-inherits-one-from-the-host.md):
  those two say what makes a single gate real, and this one says how many places need one.
* **It names the specific way a partial repair lies.** Three of the four tasks above shipped prose
  asserting the class was closed — *"a driver that never really runs an agent can no longer pass"*,
  *"every alias this task and its two prior verification rounds have found is already refused before
  this line ever runs"* — while the sibling site was open. A partial repair plus a total claim is
  worse than no repair, because it retires the question.
* The rule applies to the orchestrator too. A frozen list that names one site is a frozen list that
  will be satisfied at one site.
