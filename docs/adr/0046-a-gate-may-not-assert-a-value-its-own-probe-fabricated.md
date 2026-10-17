# ADR-0046 — A gate may not assert a value its own probe fabricated

**Status:** accepted
**Date:** 2026-09-06
**Scope:** programme
**Context:** Wave 3 level 3a-2 — four tracks, four independent verifiers, the same shape three times

## Context

Every track in level 3a-2 shipped green CI and every one was failed by its verifier, and three of the
findings are one class:

**A.12 scenario 10 — *"no host `.claude` configuration is visible inside the sandbox"* — was found
false independently on two branches by two verifiers who could not see each other's work.**

* W3-QA-02's scenario reads `outcome.config`, which the fixture echoes back from
  `request.claudeConfigDir` — a value `buildFixtureRequest` invented one call earlier as
  `path.join(tmpdir(), 'a12-fixture-claude-config', randomUUID())`. The driver never sees, sets or
  influences it. Its verifier reported `pass  no-host-claude-config-visible` from the harness and, in
  the same process with the same driver and probe, read `<home>\.claude\CLAUDE.md` from
  inside the "sandbox": `succeeded = true, bytes = 8`.
* W3-CP-09's gate asserts that a directory **the test itself just created** is empty, while its
  verifier showed the same process reading the whole host `~/.claude`.

Two more of the same shape in the same level:

* W3-QA-02 scenario 7, *"enforce cpu / memory / timeout limits"*: the harness calls
  `connection.interrupt()` itself after 2000 ms and then asserts the turn stopped. **The only force
  that ever stops it is the harness's own call.** `capabilities.maxSessionSeconds` — the one field
  that *is* a ceiling — is never read. A fixture declaring `maxSessionSeconds: null` and enforcing
  nothing reports `pass`, with the detail string *"a long-running turn was stopped by an enforced
  limit"*, which is a false sentence about what happened.
* W3-QA-02 scenario 9's cross-read: `if (crossReadOutcome.readPath?.succeeded)`. When a probe does
  not report `readPath`, `undefined?.succeeded` is `undefined`, no problem is recorded, and the report
  says *"A's sandbox could not read B's file by path"* — about a check that never ran. That is
  [ADR-0015](0015-gates-decide-on-positive-assertions.md), found for the eighth time, failing open
  again.

The common structure is not carelessness. In each case the assertion is **well-formed, specific and
green**, and the value it examines was produced by the test rather than by the system under test. A
tautology is the easiest thing in the world to write when the real question is hard to reach, and it
is invisible to every gate this repository has: it type-checks, it lints, it passes, and it passes for
every possible implementation.

That last clause is the diagnostic. **A.12 states the rule these scenarios exist to enforce — *"A
driver that cannot pass a scenario declares it unsupported in `RuntimeCapabilities`; it must never
pass by weakening the test"* — and the suite written to enforce it was itself weakened in three
places.**

## Decision

**A gate may not decide on a value that its own probe, fixture or harness produced. The value it
asserts on must have crossed the boundary the gate exists to police.**

Three operational rules follow, and each maps to one of the failures above:

1. **Name the boundary in the test, and read the value from the far side of it.** Scenario 10's
   question is whether the *host's* `~/.claude` is reachable **from inside the sandbox** — so the
   action is a read of `path.join(homedir(), '.claude')` driven through the driver, and the verdict is
   `fail` when it succeeds. Checking that a config directory is distinct is a fine *additional*
   assertion and is not a substitute for the one A.12 asks for.
2. **The gate must not supply the force it is testing for.** If a scenario asks whether a limit is
   enforced, nothing in the scenario may stop the turn. Let it run past a ceiling the driver
   *declared* and fail when it is still alive, and gate the scenario on the field that declares the
   ceiling rather than on a loosely-related one.
3. **An absent answer is `fail`, never a skipped branch.** `readPath === undefined` means the probe
   could not answer the question, which is exactly the case ADR-0015 requires to reject. Optional
   chaining in a predicate is where this hides: `x?.y` in an `if` is a silent third outcome.

**How to check your own gate before shipping it, in one question:** *does an implementation that does
none of what this scenario is about still pass?* Build that implementation and run it. Three of the
four counter-examples above are ten lines of fixture, and each one was found in minutes by someone who
asked the question.

## Why this is worth its own record

[ADR-0029](0029-a-narrowing-is-a-defect-only-when-a-counter-example-exists.md) says a finding about a
gate needs a tree the gate ought to reject and accepts. This record says the same discipline binds the
**author** of a gate, not only its critic: **a gate you have not watched fail is not evidence, and the
tree it must be watched failing on is one that does none of what the gate is about.**

It also explains a fact that would otherwise mislead the programme: **CI was green on all four 3a-2
branches, and the green was real.** Every gate ran, every gate passed, and every gate was asserting
something other than the property its name claimed. Greenness proves a suite ran; it never proves the
suite asks the right question.

## Consequences

* A.12's ten scenarios become the contract W3-RT-03, W3-RT-04 and W3-CP-07 are measured against, so a
  weakened scenario would have handed every future driver a free pass. Two of them would have.
* Two independent verifiers finding scenario 10 false on two branches is the strongest evidence in
  this programme so far that **separating implementer from verifier is what makes the method work** —
  neither implementer saw it, both verifiers did, and they agreed without communicating.
* The rule is cheap to apply and expensive to skip: the question in bold above is one sentence, and
  every failure it would have caught here cost a full repair round.
