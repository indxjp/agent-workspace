# ADR-0029 — A narrowing is a defect only when a tree exists that the gate should reject and accepts; ADR-0027/0028 as written had no stopping condition

Status: accepted
Date: 2026-09-04
Decided by: orchestrator, after round 3 produced findings the rule generated rather than found
Scope: how [ADR-0027](0027-a-partition-that-lists-its-members-has-not-been-partitioned.md) and
[ADR-0028](0028-the-classifier-rule-is-applied-by-enumeration-not-at-the-site-named.md) are applied

## Context

ADR-0028 required each repairer to enumerate **every** place in the files it owns where a listing is
narrowed. Six branches did: between twenty and forty-two entries each. Six fresh verifiers then
built independent enumerations and reported between three and twelve entries each that the repairs
had missed.

The verifiers applied the rule correctly. Some of what it produced:

| Reported narrowing | What it actually is |
| --- | --- |
| `stdout.split('\0').filter((f) => f.length > 0)` | dropping the empty element after a NUL terminator |
| `relativeDir.split('/').filter((s) => s !== '' && s !== '.')` | path normalisation, before a classifier that throws |
| `screens.filter((s) => s.status === 'shipped')` | selecting a subset for one assertion, after every element already has a verdict |
| `declarations.find((f) => f.name === 'claude.d.ts')` | looking up one known file by name |
| `[...escapeSubpaths][0]` | taking one element of a set |

None of these can drop something the gate needed to see. They are `.filter()` calls, which is what
ADR-0028 said to look for — and that is the defect: **the rule was written in terms of a syntactic
shape, and every non-trivial file contains that shape dozens of times.** It therefore has no
stopping condition, and a rule with no stopping condition converts a verifier into a generator.

That is a defect in my own record, not in six tasks. Rounds 2 and 3 both closed real holes and both
also spent real effort on entries like the five above. The programme's own standard applies: a plan
defect is corrected in the plan, not worked around downstream (plan §2.3).

## Decision

1. **A narrowing is a defect if and only if a tree can be constructed that the gate ought to reject
   and, because of that narrowing, accepts.** The test is a counter-example, produced and run — the
   same "cause the rejection" discipline already required of every gate change. Not the presence of
   `.filter()`, `continue`, `find`, or a pathspec.
2. **The burden is symmetric and cheap in both directions.** A repairer converts a narrowing when it
   can build the counter-example, and records "no counter-example: <why>" when it cannot. A verifier
   reports a missed narrowing **only with the counter-example attached and run**. A missed-narrowing
   report without one is not a finding, and filing it is the verifier equivalent of an
   unsubstantiated dispute.
3. **Load-bearing means load-bearing for the assertion**, not for the file. The question is whether
   the narrowed set is the set the gate quantifies over when deciding pass or fail. A narrowing
   downstream of a classifier that already gave every element a verdict is not in scope, because the
   rejection has already happened.
4. **ADR-0027's substance is unchanged.** Deriving a set from a literal list of member paths, and a
   classifier that skips instead of rejecting, remain defects — those are the shapes for which a
   counter-example is nearly always constructible, which is why they were found seven times. What
   changes is that constructibility is now the test, rather than a proxy for it.
5. **Residuals that fail the counter-example test are declared and carried**, not chased. Round 4 is
   the last round of this sub-wave; whatever survives it with a counter-example is fixed, and
   whatever survives without one is a declared gap in the wave manifest.

## Alternatives considered

* **Keep enumerating.** Rejected: rounds 2 and 3 each closed genuine holes *and* each produced a
  larger set of non-defects than the round before. The trend is the argument.
* **Drop ADR-0027 as over-fitted.** Rejected outright. Within these three rounds the shape produced a
  live §42 alias bypass, a cross-tenant write on a public barrel, a route-surface scan that drops an
  HTTP method it cannot spell, and a mutator scan that misses `unlinkSync`. The rule is right; its
  termination condition was missing.
* **Have the orchestrator triage each enumeration by hand.** That is this round, and it does not
  scale past one wave. The test belongs in the brief, where both sides of the exchange can apply it.

## Consequences

* Enumerations get shorter and each entry gets more expensive, which is the intended trade.
* A verifier can now be wrong in a way it could not be before — asserting a counter-example that does
  not reproduce. That is the same failure as an unsubstantiated dispute and is treated the same way.
* Three ADRs now govern one rule (0027 substance, 0028 scope, 0029 termination). If a fourth is
  needed, the rule is wrong rather than under-specified, and the right move is to delete all three
  and keep only the gate `W2-INT-02` builds.
