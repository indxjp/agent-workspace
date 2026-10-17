# W3-QA-02 — the A.12 conformance harness: one function, a caller-supplied probe seam, and how capability-gating decides `unsupported-by-capability`

Status: accepted
Date: 2026-09-06
Decided by: W3-QA-02 (the suite, the image, the profiles and the environment)
Scope: `tests/conformance/**`; a suite the Wave 3 plan's 3b-1/3b-2/3c-1/3c-3 rows name as
something later driver tasks (W3-RT-03, W3-RT-04, W3-CP-07) and the integrator (W3-RT-10b) run
against their own drivers, so its exported shape binds them without amendment

## Context

A.12 (`docs/spec.md` §A.12) names ten scenarios and one rule: _"A driver that cannot pass a
scenario declares it unsupported in `RuntimeCapabilities`; it must never pass by weakening the
test."_ The wave plan's cell for this task asks for one exported harness, driver-agnostic, taking
a driver and its declared `RuntimeCapabilities`, reporting `pass` / `fail` /
`unsupported-by-capability` per scenario when run against `local` — plus a test that proves the
honesty rule by flipping a capability claim on a fixture driver that cannot honour it.

Two things make this harder than "call ten functions":

1. `RuntimeDriver<TRequest, TEvent>` (`packages/runtime/src/driver.ts`, §14.2) is generic over the
   request and event shape precisely because this package may not depend on
   `@agent-workspace/core`, where the real shapes live (`docs/adr/W1-RN-02-runtime-driver-is-generic.md`).
   A "driver-agnostic" conformance suite that hard-codes a concrete request/event shape would only
   be agnostic across drivers that happen to share it — a smaller thing than the plan asks for.
2. `RuntimeCapabilities` (§14.5) has ten fields. Three of them each name exactly one scenario:
   `networkPolicies` is what two of the ten scenarios (5, 6) are literally about, and
   `maxSessionSeconds` — the field that IS a timeout ceiling — is what scenario 7 is about (round 1
   of this ADR said "the other eight scenarios have no capability field to hang a legitimate
   'unsupported' declaration on" and then gated scenario 7 on `isolation` two sections later; that
   was wrong on both counts — see "Round 2" below, and ADR-0031: a limit stated and withdrawn in
   the same document is not a limit). The remaining seven scenarios have no capability field to
   hang a legitimate "unsupported" declaration on, and A.12's honesty rule is explicit that
   `unsupported-by-capability` is available **only** when a real field says so — inventing one
   would be the dishonesty this task exists to prevent, aimed at itself.

## Decision

### 1. One exported function, capabilities passed separately from `driver.capabilities`

```ts
export async function runA12ConformanceSuite<TRequest, TEvent>(
  driver: RuntimeDriver<TRequest, TEvent>,
  capabilities: RuntimeCapabilities,
  probe: A12Probe<TRequest, TEvent>,
): Promise<A12Report>;
```

`capabilities` is not read from `driver.capabilities` internally. Every ordinary caller passes
`driver.capabilities` itself (see `tests/conformance/a12-local.test.ts`), but the honesty test
needs to pass a capability record the driver does not actually have, and the two-argument shape is
what makes that possible without inventing a second driver: `tests/conformance/a12-honesty.test.ts`
runs the real, unmodified `local` driver against a **copy** of its own capabilities with
`networkPolicies` widened to include `"none"`. `local` is not touched; the lie lives entirely in
the second argument, exactly where the wave plan's cell puts it ("flip a capability field ... in a
fixture driver").

### 2. The request/event seam is a caller-supplied `A12Probe`, not a guessed concrete type

```ts
type A12Probe<TRequest, TEvent> = {
  agent: A12AgentProbe<TRequest, TEvent>; // buildRequest(action) / interpretEvents(events)
  fileTransfer?: A12FileTransferProbe; // only needed when the driver has putFiles/getFiles
};
```

`A12AgentAction` is a small, closed union (`trivial`, `resume`, `long-running`, `network-probe`,
`read-path`) that names _what a scenario needs from a turn_, never _what the request looks like_.
The probe is the one place that knows the concrete `TRequest`/`TEvent`. `tests/conformance/fixtures/common.ts`
supplies one for this task's own fixture drivers; a later task wiring the harness against `docker`
or `sandbox-runtime` supplies its own, built from `apps/runner`'s real `RunRequest`/
`ClassifiedSdkEvent`, without this file changing at all. This is the same seam
`packages/runtime/src/local.ts`'s injected `AgentStarter` already establishes, carried one level
up.

### 3. Capability-gating is explicit in each scenario's requirement

The ten scenarios' `requirement` functions:

| Scenario                           | Gate                                    | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create-and-destroy                 | none — always required                  | the literal minimum of `RuntimeDriver`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| trivial-agent-turn                 | none — always required                  | `startAgent`/`sessionId` is baseline, §14.2                                                                                                                                                                                                                                                                                                                                                                                                             |
| hydrate-and-collect-files          | none — always required                  | §15.3: every driver mounts a volume _or_ implements `putFiles`/`getFiles`; there is no third, capability-declarable option                                                                                                                                                                                                                                                                                                                              |
| resume-after-sandbox-gone          | none — always required                  | the driver's only obligation is not standing in the way of a fresh `create()`; session persistence itself is §20's, already on `main`                                                                                                                                                                                                                                                                                                                   |
| enforce-network-none               | `networkPolicies.includes('none')`      | the one field A.12's scenario is literally about                                                                                                                                                                                                                                                                                                                                                                                                        |
| enforce-network-restricted         | `networkPolicies.includes('allowlist')` | ditto                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| enforce-resource-limits            | `maxSessionSeconds !== null`            | the one field that IS a timeout ceiling — see "Round 2" below; round 1 gated this on `isolation` instead, a field this scenario's `run()` never reads                                                                                                                                                                                                                                                                                                   |
| interrupt-running-agent            | none — always required                  | `AgentConnection.interrupt()` is not optional in §14.2's contract                                                                                                                                                                                                                                                                                                                                                                                       |
| concurrent-sessions-file-isolation | `isolation !== 'none'`                  | `local`'s own `LOCAL_RUNTIME_WARNINGS` says as much: _"Concurrent sessions share one filesystem and can read each other's workspaces"_                                                                                                                                                                                                                                                                                                                  |
| no-host-claude-config-visible      | none — always required                  | §14.7's rule that a host-side Claude configuration location must not be reachable from inside the sandbox is unconditional — driven for real via a `read-path` action against a marker THIS scenario seeds and designates as the host configuration root (see "Round 3" below, ADR-0047), not inferred from a config-dir value the harness's own probe invented, and never dependent on whether this particular host happens to have a real `~/.claude` |

A scenario with no legitimate capability gate that a driver nonetheless cannot pass is not
`unsupported-by-capability` — it is `fail`. This is ADR-0015 applied to this task's own gate: a
positive assertion (`capabilities.<field>` says so) decides `unsupported-by-capability`; its
absence is not evidence of anything and defaults to attempting the scenario for real.

### 4. `local`'s real report, as of round 3: 5 pass / 4 unsupported / 1 fail — unconditionally, on every machine

**This section has now been wrong in both directions on two prior rounds: "6/4/0 always" (round 1,
false — `no-host-claude-config-visible` was measuring the wrong thing), then "5 pass / 4 unsupported
/ 1 fail on a machine with a `~/.claude`; 6/4/0 on one without" (round 2, true of round 2's own
scenario but environment-dependent — ADR-0047's finding). Round 3 repairs the SCENARIO rather than
this sentence: `no-host-claude-config-visible` no longer asks about this host's real `~/.claude` at
all (see "Round 3" below), so the report below is now a fixed fact about `local`, not a fact about
whatever machine happens to run this suite.**

Run against the real `local` driver with its real, unmodified `LOCAL_RUNTIME_CAPABILITIES`
(`packages/runtime/src/local.ts`), `runA12ConformanceSuite` reports, on every host:

- `pass`: create-and-destroy, trivial-agent-turn, hydrate-and-collect-files,
  resume-after-sandbox-gone, interrupt-running-agent.
- `unsupported-by-capability`: enforce-network-none, enforce-network-restricted (`networkPolicies`
  is `['open']` only), enforce-resource-limits (`maxSessionSeconds` is `null`),
  concurrent-sessions-file-isolation (`isolation` is `'none'`).
- `fail`: no-host-claude-config-visible. `local` has no isolation boundary at all
  (`isolation: 'none'`), so a marker this scenario seeds at a host location it designates — never
  the real `~/.claude` — is readable from inside it, exactly as `local`'s own
  `LOCAL_RUNTIME_WARNINGS` already says. §14.7's obligation has no capability field a driver can
  decline it through (see the table above), so this is `fail`, not `unsupported-by-capability`,
  exactly as ADR-0015 requires — and it is now a fixed property of `local` in the abstract, on any
  host, because the scenario no longer asks about the host's own state at all (ADR-0047). Both
  `tests/conformance/a12-local.test.ts` and `a12-honesty.test.ts` assert this as a plain constant
  now; round 2's `HOST_CLAUDE_CONFIG_VISIBLE`-conditional expectation is gone from both.

Pasted, real output is in this task's PR body — `report.ok` is `false` and
`report.dishonestCapabilityClaims` contains exactly `no-host-claude-config-visible` on every run.
`local`'s capability record is still honest about the four gaps it declares through
`RuntimeCapabilities` (no lie there), but §14.7 is a baseline obligation with no such field, and
`local` does not meet it — full stop, not "when there happens to be something to leak." That is a
real, load-bearing finding this task's own suite surfaces about the driver it runs against by
default, carried forward for whichever task next touches `packages/runtime/src/local.ts` (outside
this task's `Owns` glob) to address.

### 5. Fixtures prove both directions of the harness's own gate (ADR-0029)

- `tests/conformance/a12-honesty.test.ts` — the required proof that the harness **fails** a driver
  claiming a capability it lacks. `local`, capabilities lied about (`networkPolicies` widened to
  include `"none"`), `enforce-network-none` attempted for real, `fail`, naming both the claim
  (`capabilities.networkPolicies claims "none" is supported ...`) and the observation (`... but the
sandbox reached "blocked.external.a12-fixture"`).
- `tests/conformance/a12-container-fixture.test.ts` — the positive counterpart: a fixture driver
  (`fixtures/container-fixture.ts`) that actually enforces what it claims (`isolation: 'container'`,
  real per-session path sandboxing, real network enforcement) reports `pass` on all ten scenarios.
  Without this, a passing honesty test alone would not distinguish "the harness correctly rejects
  dishonesty" from "the harness's `enforce-*` scenarios always fail when actually run" — a
  possibility this fixture rules out by construction.
- `tests/conformance/a12-file-transfer-fixture.test.ts` — the same positive proof for the
  `putFiles`/`getFiles` branch of scenarios 3 and 9 (§15.3's other mechanism), against a fixture
  with `persistentFilesystem: false` that `local` never exercises.

None of these three fixture drivers is a driver this repository ships. `fixtures/container-fixture.ts`
and `fixtures/file-transfer-fixture.ts` borrow real `RuntimeDriverId` values (`'docker'`,
`'aws-agentcore'`) only because `RuntimeHandle.driver` is typed as that closed union with no
harness-fixture member — each file says so in its own header, once, so it cannot be misread as a
claim about the real `docker` driver (which does not exist yet; the Wave 3 plan's 3b-1 row,
W3-RT-03, is sequenced after this task).

### 6. The scenario names are asserted against `docs/spec.md`, not merely copied from it

`tests/conformance/spec-scenarios.ts` parses A.12's fenced ` ```text ` block by locating the
heading, taking the block, and treating every non-empty line as a `"✓ "`-prefixed scenario or a
hard failure (ADR-0015/ADR-0031: the classifier's `else` rejects; no line is silently skipped).
`tests/conformance/scenario-names.test.ts` then compares the **parsed length and content**, in
order and as a set, against `tests/conformance/scenarios.ts`'s ten hand-typed `name` fields — the
same two-sided check `packages/runtime/src/spec-transcription.test.ts` (W3-RT-01) uses for
§14.2/§14.5/§15.1, applied to a list of strings instead of a list of type members. Nothing here
assumes the count is ten: `harnessScenarios.length` is asserted equal to `specNames.length`, and a
scenario the spec gains or drops shows up as a length mismatch or a set difference, never a test
that silently keeps passing on a hand-typed `10`.

## What this task did not build (declared gaps — see PR body for the full ADR-0035 accounting)

- **The `putFiles`/`getFiles` wire format `fixtures/archive.ts` invents is not tar.**
  `packages/runtime/src/driver.ts` types the archive as a bare `ReadableStream`, not a committed
  format, so this is not a spec violation — but it is also not what a real driver's `putFiles` will
  send to the runtime HTTP contract (POSIX ustar, `packages/runtime/src/transfer.ts`, W3-CP-07's,
  out of this task's glob). This fixture format exists solely to prove the harness's own branching
  logic; a real driver supplies its own matching `A12FileTransferProbe` when it runs this harness.
- **Scenarios 2 and 4's "real model" / "real session store" halves are not exercised.** Every
  scenario in this suite runs against fixture starters this task controls, standing in for a real
  Claude Agent SDK call (scenario 2) and a real §20 `SessionStore` (scenario 4) — see
  `fixtures/common.ts`'s header comment on `sessionTranscripts`. The Wave 3 plan's own
  declared-gaps section already carries "scenario 2 against a real model" and "scenario 4 end to
  end" forward to Wave 4, for the whole wave, not only this task; this ADR records that this task's
  fixtures prove the _driver-contract_ half (the driver does not stand in the way), not the
  full-stack half.
- **Network and cross-session-isolation enforcement is never exercised against a real container.**
  `fixtures/container-fixture.ts`'s enforcement is a fixture-level simulation (a path-prefix check,
  an in-memory allow/block decision), not a real network namespace or mount namespace. The real
  `docker` driver (W3-RT-03) is a later, sequential task; this harness is what it will be run
  against, not a claim that `docker`'s real enforcement has been observed.

## Round 2 — five gates round 1 shipped green that asked the wrong question

Round 1's verifier failed this PR on five blocking items, three of which are the exact shape
[ADR-0046](0046-a-gate-may-not-assert-a-value-its-own-probe-fabricated.md) later gave a name to: _a
gate may not decide on a value that its own probe, fixture or harness produced._ Fixed in this
round, each watched failing on a tree built specifically to defeat it before being called done
(ADR-0029; the adversarial fixtures are `tests/conformance/a12-adversarial-repairs.test.ts`,
committed rather than thrown away, so a regression here is caught automatically rather than
depending on a verifier finding it a third time):

1. **Scenario 7 (`enforce-resource-limits`) called `connection.interrupt()` itself, then asserted
   the turn had stopped — the only force that ever stopped it was the harness's own call, and
   `capabilities.maxSessionSeconds` (the one field that IS a ceiling) was never read.** Fixed:
   `runEnforceResourceLimits` no longer calls `interrupt()` while the turn is live; it waits up to
   `capabilities.maxSessionSeconds` seconds plus a fixed grace window for the DRIVER's own
   enforcement to end the turn, and fails if it is still running past that. `requirement` now gates
   on `capabilities.maxSessionSeconds !== null` instead of `isolation !== 'none'`. The two fixtures
   that must actually pass this scenario (`container-fixture.ts`, `file-transfer-fixture.ts`) were
   themselves not enforcing anything before this round despite claiming a ceiling —
   `createFixtureStarter`'s new `maxSessionSeconds` option makes them really do so.
2. **Scenario 10 (`no-host-claude-config-visible`) inspected only `outcome.config`, a value the
   probe's own request-builder had invented one call earlier — it never asked whether the host's
   real `~/.claude` is reachable from inside the sandbox.** Fixed: the scenario now drives a
   `read-path` action at `path.join(homedir(), '.claude')` through the driver and fails if it
   succeeds, keeping the config-dir distinctness check as an additional assertion, not a
   substitute. Consequence: `local` (`isolation: 'none'`) now honestly fails this scenario on any
   machine whose real `~/.claude` exists — see "§4" above, including the correction one level
   below this: the fix's own test coverage (`a12-local.test.ts`, `a12-honesty.test.ts`) first
   asserted that failure as a fixed constant, which this round's own CI run — a fresh runner with
   no `~/.claude` at all — immediately failed. At the end of round 2, both files computed their expectation from
   `existsSync(path.join(homedir(), '.claude'))`, the same real condition the scenario itself
   checks, rather than a hard-coded verdict; this is the ADR-0046 check applied to the _test_, not
   only the scenario: does an environment that genuinely has nothing to leak still get told it
   leaked something? It did, once, here, until CI caught it. Round 3 superseded that
   host-dependent expectation with the designated-marker probe described below.
3. **Scenario 9's adversarial cross-read used `crossReadOutcome.readPath?.succeeded` in an `if` —
   when a probe does not report `readPath` at all, `undefined?.succeeded` is `undefined`, the
   branch is silently skipped, and the scenario passed anyway with a detail string claiming a
   cross-read had been refused when it was never attempted.** Fixed: `readPath === undefined` is
   now an explicit branch that fails, naming exactly what could not be checked (ADR-0015: a check
   that cannot run must fail, never pass by omission).
4. **Scenario 3's `persistentFilesystem` branch never involved the driver or the sandbox at all** —
   it wrote a file with `node:fs/promises` to `handle.workspacePath` and read it back in the same
   process, so a driver whose `startAgent` unconditionally threw still passed. Fixed _on that one
   branch_: after the host-side write ("hydrate in", still legitimate — `persistentFilesystem:
true`'s whole premise is that this is visible without `putFiles`/`getFiles`), the scenario drives
   a `read-path` action through the driver to prove that visibility crossed into the sandbox, and
   then drives a new `write-path` action (added to `A12AgentAction`/`A12AgentOutcome` in
   `types.ts`, and to the fixture starter and every fixture's file-access wiring in
   `fixtures/common.ts`) so the sandbox creates a file the harness only then reads out from the
   host side.
   **This item's own closing sentence — "both directions now go through the driver, so a driver
   that never really runs an agent can no longer pass either half" — was FALSE the moment it was
   written, and stood uncorrected until round 3.** It described the `persistentFilesystem` branch
   only; the sibling `putFiles`/`getFiles` branch (§15.3's OTHER mechanism, exercised by
   `fixtures/file-transfer-fixture.ts` and the branch W3-CP-07 and every managed cloud driver take)
   still never called `startAgent` at all, so round 1's exact counter-example — `startAgent(): never
{ throw }` — still passed it. See "Round 3" below, item C1.
5. **The PR body's acceptance evidence for `scenario-names.test.ts` was not this command's actual
   output** — a hand-typed `16 passed (16)` against a real `18 passed (18)`, with every `it.each`
   title rendering `NaN` (`scenario-names.test.ts`'s title string consumed two `%i` tokens from a
   two-element tuple whose second element was a string). Fixed: the title now reads `'scenario %i
in docs/spec.md ("%s") equals the harness table entry at the same index, verbatim'` — one `%i`
   for the index, one `%s` for the name — and the PR body's acceptance block is replaced with this
   round's own real run (ADR-0016: a measured number is generated or absent, never written into
   prose).

None of round 1's other claims changed: the honesty rule's two-argument shape (§1), the probe seam
(§2), the fixture-drivers-prove-both-directions structure (§5), and the spec-parsing technique (§6)
are all unmodified by this round.

## Round 3 — one shape, found by asking ADR-0046's question of the branches round 2 did not repair

Round 2 repaired the `persistentFilesystem` branch of scenarios 3 and 9, and a version of scenario
10 that measured a real question but inherited its precondition from this host's own state
(ADR-0047). Round 3's four items are the sibling branch of the same two scenarios, the scenario-10
fix made host-independent, and one defect round 2 introduced while repairing scenario 3.

**C1 (scenario 3, `putFiles`/`getFiles` branch): round 1's `startAgent(): never { throw }`
counter-example, one branch over, still passed.** Round 2's item 4 fixed only the
`persistentFilesystem: true` branch; the `putFiles`/`getFiles` branch — §15.3's OTHER mechanism,
the one `fixtures/file-transfer-fixture.ts` exercises and the one W3-CP-07's real driver and every
managed cloud driver (`aca-sessions`, `aws-agentcore`) will take — never called `startAgent` at
all, so a driver whose sandbox can never run anything still reported the putFiles/getFiles round
trip as `pass`. Fixed: after `putFiles`, the scenario now drives a `read-path` action through
`startAgent`, targeted at this handle's own workspace, and after that a `write-path` action
followed by `getFiles` to collect it back out — both directions on this branch now go through
`startAgent` too, for real this time (see the correction to round 2's item 4, above).
Regression test: `a12-adversarial-repairs.test.ts`, "C1".

**C2 (scenario 9, same branch): the adversarial cross-read targeted a location that branch never
writes to.** Round 2's cross-read used `path.join(handleB.workspacePath, 'mine.txt')` — a host
path. On the `putFiles`/`getFiles` branch, nothing is ever written under `workspacePath`; content
lives in whatever internal store the driver's `putFiles` uses. So the cross-read's `readPath`
outcome was `succeeded: false` for every driver on this branch, honest and dishonest alike, and the
scenario reported the honest-sounding `pass` detail _"A's sandbox could not read B's file by
path"_ regardless of whether any real boundary existed. Fixed, together with C4 below: the target
is now `{ locus: 'workspace', handle: handleB, relativePath: 'mine.txt' }` — a request named
relative to B's own handle, resolved by the driver/probe's own file-access implementation, never a
path this scenario pre-computed. A correctly-isolated implementation refuses it because the
handle named is not the one currently running; an implementation with no real isolation (this
round's counter-example: correct per-handle `putFiles`/`getFiles`, but a `read-path` handler that
forgot to check which handle is actually running) now honestly fails. Regression test:
`a12-adversarial-repairs.test.ts`, "C2".

**C3 (scenario 10): the fix was real but the machine it ran on decided the verdict.** Round 2's
`read-path` action targeted `path.join(homedir(), '.claude')` — this host's REAL config directory.
On any host without one (every CI runner in this programme), `stat` returns `ENOENT`,
`readPath.succeeded` is `false`, and the scenario cannot distinguish that from a refusal: it
reports `pass` either way. CI's own log for the round-2 head commit printed exactly this, four
times, including for `local` itself. This is [ADR-0047](0047-a-probe-establishes-its-own-precondition-it-never-inherits-one-from-the-host.md)'s
finding, made independently on this branch and on W3-CP-09's. Fixed: the scenario now seeds its own
marker file at a host location it designates, for this run only, as "the Claude configuration
root" — never inside the real `~/.claude` (a probe must not write into the operator's own
configuration) — and asks the sandbox to read that marker instead. The read is always meaningful
because the harness itself just wrote what is being asked for, so `local` (`isolation: 'none'`)
now fails this scenario for real on every host, including one with none of its own — the acceptance
test ADR-0047 names verbatim. `tests/conformance/a12-local.test.ts` and `a12-honesty.test.ts` assert
this as a fixed constant now; the `HOST_CLAUDE_CONFIG_VISIBLE`-conditional expectation both files
carried is gone. Regression test: `a12-adversarial-repairs.test.ts`, "C3" (points `HOME`/
`USERPROFILE` at a freshly created, empty directory and re-confirms `local` still fails).

**C4 (scenario 3, `persistentFilesystem` branch): a defect ROUND 2 introduced, and the over-
correction risk C1/C2's fix carried.** Round 2's new in-sandbox read drove `read-path` at
`absPath = path.join(handle.workspacePath, relPath)` — a HOST absolute path — and
`A12AgentProbe.buildRequest(action)` received only the action, with no handle, so a driver-specific
probe had nothing to translate a host prefix with. A real container driver whose in-sandbox mount
differs from `handle.workspacePath` (`docker`, the exact case round 2's item 4 named as its
motivation) would have its correct isolation and its correct mount both count against it: handed a
host-absolute string its sandbox cannot resolve, it fails a scenario it should pass. Fixing C1/C2
by naming a target relative to a handle rather than a pre-resolved path is what closes this too,
applied uniformly: scenario 3's `persistentFilesystem` branch and scenario 9's cross-read (C2) now
build the same `{ locus: 'workspace', handle, relativePath }` shape scenario 3's `putFiles`/
`getFiles` branch (C1) does, so no branch of any scenario resolves a workspace-relative path
itself — every driver/probe implementation does, through its own `FixtureFileAccess`/
`FixtureFileWrite` (or the equivalent seam a real driver's probe supplies). `A12PathTarget`
(`types.ts`) is the new type this travels as: `{ locus: 'host'; absolutePath }` for an arbitrary
host location (scenario 10's marker) or `{ locus: 'workspace'; handle; relativePath }` for a path
relative to one session's own workspace, named by that session's `RuntimeHandle` rather than
resolved before it reaches the probe. Regression test: `a12-adversarial-repairs.test.ts`, "C4"
(a driver that refuses every host-absolute read outright and only ever resolves a
workspace-relative target through its own translation now passes).

None of round 3's changes touch scenarios 1, 2, 4, 5, 6, 7 or 8, or either scenario's
`unsupported-by-capability` gating (§3 above) — `tests/conformance/a12-adversarial-repairs.test.ts`'s
existing B1-B4 tests (round 2's) and `a12-container-fixture.test.ts` / `a12-file-transfer-fixture.test.ts`
(both fixtures' full ten-for-ten `pass`) are the evidence that nothing round 2 landed correctly was
disturbed.

## Round 4 — preserve each scenario-9 branch's distinct boundary

Round 3 correctly made workspace-relative targets driver-resolved, but applying that target shape
uniformly removed the mounted branch's only direct containment check. Round 4 keeps the
cross-handle workspace target for both branches and, only when `persistentFilesystem` is the
mechanism in use, also asks A's sandbox to read B's host-side mounted file. A container whose
in-sandbox mount differs from the host path can refuse that host-locus request and still pass; a
sandbox that can read every host path now fails. The C4 positive fixture also normalises and checks
workspace-relative paths against their root, and its regression test proves a sibling-workspace
traversal is refused while scenarios 3 and 9 still pass.

## Alternatives considered

- **Hard-code the ten scenario names as the thing compared, with the spec read only to double-check
  a hand-picked subset.** Rejected: this is the exact defect the Wave 3 plan calls out —
  _"W3-RT-01 failed round 1 on exactly one thing ... it hard-coded the list of things its
  spec-reading gate compared, while the parser had already produced the full list."_ Both sides
  (`specNames` and `harnessScenarios`) are compared by length and by set, with the spec side always
  the parsed one.
- **A single concrete `TRequest`/`TEvent` pair (e.g. plain strings for requests, string tags for
  events), shared by every fixture and hard-coded into the harness.** Rejected: it would make
  "driver-agnostic" true only in the narrow sense that the same two closed-over types happen to
  satisfy every fixture in this task, not in the sense the wave plan needs — a later task supplying
  `apps/runner`'s real `RunRequest`/`ClassifiedSdkEvent` would then require changing this file's
  exported signature, which is exactly the amendment the wave plan says this task's shape should
  not force.
- **A wholly separate "dishonest" fixture driver for the honesty test**, built from scratch with a
  capability record that lies from the start. Rejected in favour of flipping one field on the real,
  unmodified `local` driver: it is a smaller, more legible proof (nothing about `local` needed to be
  faked, only the second argument), and it directly demonstrates that the same driver can be either
  honestly declared unsupported or dishonestly claimed, depending only on what capability record
  accompanies it — which is the actual shape of A.12's rule.
- **Gating `hydrate-and-collect-files` and `resume-after-sandbox-gone` as capability-declarable**
  (inventing, say, a `supportsFileTransfer` or `supportsResume` reading of existing fields).
  Rejected: `RuntimeCapabilities` has no field for either, and §15.3 states file transfer as a
  structural obligation ("mount a volume, or implement `putFiles`/`getFiles`") rather than an
  optional feature — a driver that does neither has a defect, not a declared limitation, so this
  suite reports `fail`, not `unsupported-by-capability`, exactly as ADR-0015 requires for a claim
  with no real field to rest on.
