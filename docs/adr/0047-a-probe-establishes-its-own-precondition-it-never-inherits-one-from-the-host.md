# ADR-0047 — A probe establishes its own precondition; it never inherits one from the host

**Status:** accepted
**Date:** 2026-09-07
**Scope:** programme
**Context:** A.12 scenario 10, third finding, second round, two branches

## Context

A.12 scenario 10 — *"no host `.claude` configuration is visible inside the sandbox"* — has now been
found false three times by three different verifiers on two branches that could not see each other.

Round 1 found it **tautological**: both W3-QA-02's and W3-CP-09's versions asserted on a value the
test itself had produced. That is [ADR-0046](0046-a-gate-may-not-assert-a-value-its-own-probe-fabricated.md),
and both were repaired the way it prescribes — drive a real `read-path` at
`path.join(homedir(), '.claude')` through the driver and fail when it succeeds.

Round 2 found the repair **environment-dependent**, on both branches again:

* W3-QA-02's confirmer: the scenario is *"structurally unable to fail on any host without a real
  `~/.claude` — i.e. on every CI runner"*, and **CI's own log for the head commit prints the false
  pass four times.**
* W3-CP-09's confirmer, asking ADR-0046's question directly: *"the gate still reports `pass` for a
  driver with `isolation: 'none'` — on a host with no `~/.claude`, which is exactly the CI runner
  this PR is gated on."*

The repair is correct on the machine running the wave, which has a real `~/.claude`, and vacuous
everywhere the programme is actually gated. **The gate's verdict depends on the host's incidental
state.** That is exactly the shape [ADR-0039](0039-a-gate-whose-verdict-depends-on-directories-only-one-clone-has-is-not-a-gate.md)
recorded for repository-wide checks — *a gate whose verdict depends on directories only one clone has
is not a gate* — reappearing in a runtime probe, where ADR-0039's wording did not reach it.

Note which way this one fails. ADR-0039's instance was **noisy**: `pnpm lint` died locally and passed
in CI. This one is **silent**: it passes in CI and would have shipped a green scenario 10 to every
driver in Wave 3.

## Decision

**A probe establishes the precondition its assertion depends on, inside the probe, and fails if it
cannot. It never reads a precondition the host happens to provide.**

For scenario 10 concretely: the harness **seeds a marker file at a host location it designates as the
host configuration root** for the run, points the driver's `CLAUDE_CONFIG_DIR` somewhere else, and
then asks the sandbox to read the marker.

* The marker exists because the harness wrote it, so the read is always meaningful.
* If the sandbox reads it, the driver does not isolate the host's configuration — `fail`.
* If the read is refused, that refusal is evidence rather than an accident of the filesystem.
* `local`, which declares `isolation: 'none'` and whose own warnings say sessions share the host
  filesystem, must **fail** this scenario on every host — including a CI runner with no `~/.claude`.
  That is the acceptance test for the repair.

Seeding into the real `$HOME/.claude` is not the answer: a probe must not write into the operator's
own configuration, and a scenario that only works on a machine that has one is the defect being
repaired.

The general form, which is what a later wave should apply without re-deriving it:

> If a probe's verdict would differ on a clean machine, the probe is measuring the machine. Create the
> condition, assert against it, and remove it.

## Consequences

* Scenario 10 becomes runnable and meaningful on any host, which matters because W3-RT-03, W3-RT-04
  and W3-CP-07 all run this suite against their own drivers, and a scenario that cannot fail hands
  each of them a free pass.
* It closes the gap between the two places this programme is evaluated. **A green CI run and a green
  local run were both true and neither was evidence**, which is the second time in two ADRs that
  greenness has proved only that a suite ran.
* Three verifiers reaching the same conclusion about the same A.12 sentence, independently, on two
  branches, across two rounds, is the clearest measurement this programme has produced of what the
  implementer/verifier split is buying. No implementer found it; every verifier did.
