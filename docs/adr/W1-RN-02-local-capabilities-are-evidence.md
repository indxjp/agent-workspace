# W1-RN-02 — Every field of `LOCAL_RUNTIME_CAPABILITIES` carries a basis, and a gate checks that it does

Status: accepted
Date: 2026-09-03
Decided by: W1-RN-02 (Runner)
Scope: `packages/runtime/src/local.ts`; the pattern is binding on every driver W3-RT-01 and later
waves add

Supersedes the first accepted revision of this record, whose Decision sentence — *"A capability
answers `true`, or a permissive value, only where a scenario passed"* — this driver could not keep
and did not keep. See **Verification round 1** at the end for what was wrong and how it was found.

## Context

Spec §14.5 exists because a driver that overstates its isolation is the failure this product is
built to avoid, and A.12 makes the rule mechanical: *"A driver that cannot pass a scenario declares
it unsupported in `RuntimeCapabilities`; it must never pass by weakening the test."* §14.4 adds one
more, specific to this driver: *"Never advertise this as tenant isolation. The UI must show a
persistent warning when an agent is deployed on `local`."*

Every field of `RuntimeCapabilities` can be filled in plausibly by reading the code, and none of
that is evidence. The question this record answers is what each field is allowed to say, on what
basis, and — the part the first revision got wrong — **what stops the answer to that question from
drifting once it is written down.**

## Decision

**Every field carries a basis, the basis is one of exactly two kinds, and a gate rejects the record
if any field lacks one.** The two kinds:

* **`exercised`** — a scenario was run and it could have failed. The `scenario` string names it
  precisely enough to be re-run, including what a failure would look like.
* **`structural`** — no scenario is possible or would mean anything, because the value follows from
  what this driver *is*: there is no image, there is no provider, there is one host. The `reason`
  string names the structural fact.

There is no third kind, and in particular there is no kind meaning "reads right". A `true` may rest
on a `structural` basis — `sessionAffinity` does — but it may never rest on nothing.

The basis lives in `LOCAL_CAPABILITY_BASIS`, next to the record it justifies, as data rather than
as a doc comment. Field by field:

| Field | Value | Kind | Basis |
| --- | --- | --- | --- |
| `isolation` | `'none'` | structural | §14.4's own word for this row. Same process tree, same uid, same kernel, same filesystem, same network namespace as the runner. There is no isolation to measure. |
| `customImage` | `false` | structural | There is no image. Nothing is pulled and nothing is built. |
| `persistentFilesystem` | `true` | **exercised** | A file written under `workspacePath` was read back after `destroy()` and a second `create()`. A `destroy()` that removed the directory fails it. |
| `sessionAffinity` | `true` | structural | There is one host, so every request for a session necessarily reaches the instance holding it. The driver contributes no mechanism: it parses `sessionId` and discards it, because §14.6 puts the `session → runtime handle` mapping in the control plane. Scoped to Simple Mode (§32). |
| `maxSessionSeconds` | `null` | structural | Nothing imposes a lifetime — no session product, no idle timer, no microVM budget. `null` is "no limit", not "unknown". |
| `networkPolicies` | `['open']` | structural | This driver starts no proxy, writes no firewall rule and creates no namespace, so it cannot enforce `none` or `allowlist`. |
| `execCommands` | `true` | **exercised** | A run through the driver with `Bash` in the tool surface executed a shell command that wrote a harness-minted token, `hostname` and `whoami` to a *relative* path. The harness read that file back from under the handle's `workspacePath` — which is what shows where the command ran — and the host and user it reported matched the runner's own `os.hostname()` and `os.userInfo().username`. |
| `gpu` | `false` | structural | The host may have one; the driver neither requests, reserves nor guarantees it. A capability record answers for the driver, not for the machine. |
| `managedByProvider` | `false` | structural | There is no provider. |
| `typicalStartMs` | `0` | structural | Not "fast" — *absent*. `create()` ensures a directory exists and starts no sandbox. `0` claims nothing is started; `null` would claim the driver cannot say, and it can. |

**The gate is `auditCapabilityRecord`, and it runs at import.** It is ADR-0015 applied to §14.5, and
it decides only on positive assertions:

1. both arguments are plain objects, or it rejects by name;
2. every capability field **has** a basis **and** every basis **names** a capability field — both
   directions, because a one-way check accepts a record that grew a field nobody justified;
3. every basis matches one of the two arms and carries a non-empty sentence, and the classifier
   ends in an explicit `else` that **rejects** rather than accepting an unrecognised `kind`.

`LOCAL_CAPABILITY_AUDIT` calls it at module scope, so importing `@agent-workspace/runtime` is what
enforces it. `packages/runtime/src/index.test.ts` imports the package, so the gate runs in CI on
every build. The compiler covers the other half: `LOCAL_CAPABILITY_BASIS` is typed
`Record<keyof RuntimeCapabilities, CapabilityBasis>`, so a field added to §14.5's type stops this
file compiling until someone says why `local` answers it the way it does.

**§14.4's persistent warning ships as data, not as a UI string.** `LOCAL_RUNTIME_WARNINGS` holds the
sentences, in the plain-language register of §14.5's examples, next to the capability record they
describe — so changing what the driver does forces a change to what the user is told, in one file.

**`create` and `destroy` decide on positive facts.** The driver keeps the handles it created;
`startAgent` and `destroy` reject a handle that is not in that set, by name. A driver that accepted
any handle-shaped object would run an agent in a workspace it never created and report a successful
`destroy()` for a runtime that was never there — a check failing open, which is ADR-0015's subject.
`create` parses its config before it creates anything, for the same reason.

## Alternatives considered

* **Keeping the original rule: `true` only where a scenario passed.** Rejected, because the driver
  does not obey it and cannot. `sessionAffinity: true` on a single-host in-process driver is a
  structural fact; the only "scenario" available for it is a caller passing the same workspace path
  twice and comparing it with itself, which is what the first revision shipped and what a verifier
  correctly called circular. A rule that a reasonable implementation must break is a rule that gets
  broken quietly. The replacement rule — *every field carries a basis, and the basis says which kind
  it is* — is weaker per field and much stronger overall, because it is checkable.
* **A doc comment per field, which is what the first revision had.** Rejected: prose beside a value
  is a claim nothing runs. The comment above the record said two of the `true` answers were
  exercised while the record itself answered `true` in three places, and nothing in the repository
  could notice, because nothing in the repository read the comment.
* **`sessionAffinity: false`, on the grounds that the driver derives nothing from `sessionId`.**
  Rejected. The capability asks whether a session reliably reaches the same instance; with one host
  it does. Answering `false` would be inaccurate in the other direction and would make the §14.8
  picker warn about something that cannot happen in the mode this driver is for. What was wrong was
  never the value — it was calling it exercised.
* **`typicalStartMs: null` ("unknown").** Rejected: `null` means the driver cannot say. This one
  can — there is nothing to start.
* **`gpu: true` when the host has one.** Rejected: it would make the record a statement about the
  machine the runner happens to be on, which no scheduler could act on and which would change under
  the platform without anything being edited.
* **Adding a `warnings` or `basis` field to `RuntimeCapabilities`.** Rejected: §14.5 prints the type
  and plan §3.1 names "adding a field the spec did not list" as a rejection. Both are separate
  exports from the same file.
* **Returning a verdict object from the audit instead of throwing.** Rejected: there is no useful
  degraded mode. A driver whose capability record and basis record disagree must not be exported at
  all, and the caller that would have to check a verdict is `import`.

## Consequences

* **The exercised set and the structural set are readable at run time, not asserted in prose.**
  `LOCAL_CAPABILITY_AUDIT.exercised` and `.structural` partition the record; anything that wants a
  count takes the length of an array it can also print. This ADR deliberately states no count.
* **When W3-RT-01 writes the driver conformance suite (A.12), the `structural` entries are the
  checklist.** Each one names the fact it rests on, so a driver that copies the record without
  copying the fact is visible.
* **The `local` row of the §14.8 picker will read badly, on purpose.** No isolation, no network
  policy, and the warnings. That is what §14.4 asks for.
* **The pattern is the deliverable.** A `docker` or `aca-sessions` driver that fills in `isolation:
  'container'` or `networkPolicies: ['none', 'allowlist', 'open']` gets the same two-kind basis
  record and the same import-time gate — and for those two, unlike for `local`, A.12 already prints
  the scenario the `exercised` kind has to point at.

## Verification round 1

An independent verifier failed this task on the honesty of this record, and was right to. What was
wrong, and what changed:

* The record had **three** `true` fields (`persistentFilesystem`, `sessionAffinity`,
  `execCommands`); the source comment, the PR body and this ADR all said **two**, and the ADR's
  Consequences said "two fields ... and eight do not". Every count is gone, replaced by the audit's
  two arrays.
* `execCommands: true` had a prose basis and no scenario, against this ADR's own binding sentence.
  It is now exercised: a `Bash` turn through the driver runs a command on the runner's host and the
  harness reads its effect and its self-report back.
* `sessionAffinity: true` was called *Exercised* on the strength of a check that could not fail —
  `create()` copies `workspacePath` out of its config, so asserting the two handles agree asserts
  the caller's argument against itself. Its basis is now `structural`, and the acceptance harness
  keeps the adversarial probe that shows the driver derives nothing from `sessionId`.
* The rule that made all three possible — a Decision sentence with nothing enforcing it — is
  replaced by `auditCapabilityRecord`, which runs whenever the package is imported.
