# ADR-0015 — A gate decides on a positive assertion, never on the absence of a negative

Status: accepted
Date: 2026-09-03
Decided by: orchestrator, from a diagnosis by the peer session reviewing the stacked PRs
Scope: every gate, check and guard in the programme

## Context

Wave 0 built three gates and every one of them shipped a variant of the same bug. They were found by
three different people, from three directions, and were only recognised as one bug after the peer
session reviewing the PRs named the shape:

| Gate | The malformed input | Why it passed |
| --- | --- | --- |
| Licence — exception expiry | `expires` missing or unparseable | `NaN < Date.now()` is **false**, so "is it expired?" answered no, and the exception cleared its package forever |
| Licence — denied identifiers | `GPL-2.0-with-classpath-exception` | the string **parses**, so the salvage scan that catches unparseable denied licences never ran, and it landed on REVIEW where an exception could clear it |
| Ownership — PR body | no `## Ownership` section | early revisions **skipped** the check and exited 0 |

In each case the guard asked a negative question — *is this expired? did this fail to parse? is this
declaration missing?* — and a malformed input made the negative false, so control fell through to the
pass path. The peer's formulation:

> both are "the input is malformed or unhandled, so the guard's condition is falsy, so control falls
> through to the pass path" … a gate must decide on a positive assertion, never on the absence of a
> negative.

This matters beyond CI. Spec §12, §14.5 and §41 are the same rule applied to capability reporting: a
provider or driver is marked `✓` only when a scenario **passed**, never because nothing failed. Plan
§9.3 gate 1 says it outright. The gates were violating in code the principle the product exists to
sell.

## Decision

Every gate, guard and capability check states what it requires and fails unless that is affirmatively
established.

- Not `if (expiry < now) reject` but `if (!Number.isFinite(Date.parse(expires))) reject` first, then
  the comparison. An unparseable date is a policy error, not an absent expiry.
- Not "did not trip the deny branch → allow" but an explicit allow verdict reached on its own
  evidence, with an `else` that rejects everything unclassified.
- Not "no PR body → skip" but "no PR body on a `pull_request` event → fail".
- Not "the driver did not report a failure → capability supported" but "the conformance scenario
  passed → supported", and `unverified` otherwise (spec §14.5, A.12).

Three consequences of the rule, to be applied without exception:

1. **Every classifier has a total, explicit `else` that rejects.** A value falling off the end of a
   chain of conditions is refused and named, never passed.
2. **Parse before you compare.** Any comparison against a parsed value is preceded by an assertion
   that the parse succeeded. `NaN`, `undefined` and `null` must not be able to reach a comparison.
3. **A gate that cannot run fails.** Absence of input is not absence of risk. If the check cannot be
   performed, that is a failure of the check, not a pass of the subject.

Verifiers test this directly: for every gate, feed it a malformed, empty and absent input and confirm
each is **refused**, not merely "not crashed".

## Alternatives considered

- **Fix the three bugs individually and move on.** Rejected: they were fixed individually twice
  already, and the third instance appeared in a gate written *after* the first two were known. The
  shape has to be named or it keeps arriving.
- **Add a lint rule.** Rejected for now under §40 — the pattern is semantic, not syntactic, and a rule
  that catches `x < Date.now()` would drown in false positives. The verifier obligation above is the
  enforcement.

## Consequences

- Gates get stricter and will refuse inputs that previously slipped through, including some honest
  ones. That is the intended direction: a gate that fails closed is debuggable, a gate that fails
  open is invisible.
- Existing gates were audited against this rule as part of the Wave 0 close-out. Any not yet audited
  is named in the W0 manifest rather than assumed clean.
- The rule costs a little code at every decision point — the explicit `else`, the parse assertion.
  Under §39 that is code volume worth paying for, because each line is the difference between a gate
  and the appearance of one.
