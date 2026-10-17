# W2-INT-01 — The runner has a composition root too, and ADR-0038 puts it at the integration level for the same reason

Status: accepted
Date: 2026-09-05
Task: W2-INT-01 (sub-wave 2b-1 integrator)
Scope: `apps/runner/src/index.ts` — one function added, one call site changed

## Context

[ADR-0038](0038-the-composition-root-and-the-shared-manifest-belong-to-the-integration-level.md)
names `apps/web/instrumentation.ts` explicitly and gives a general test for anything else: *"is a
conflict in this file resolved by **deciding**, or by **re-deriving**?"* Deciding what a process
installs is deciding.

`apps/runner/src/index.ts` says of itself, in its first paragraph: *"This is a composition root and
nothing else (§53): it reads the environment contract, calls `startRunnerServer`, and arranges for
the process to stop."* It is the runner's `instrumentation.ts`.

W2-CP-07 built the other half of spec §14.9 — `apps/runner/src/session.ts`'s `readMirrorConfig` and
`createHttpTranscriptMirror` — and could not call either, for the reason
`docs/adr/W2-CP-07-the-two-wiring-lines-this-task-does-not-own.md` states plainly: the file is
W1-COMP-01's, and W2-CP-07 could not promise disjointness on a file *"another wave's task wrote and
a later wave's task will edit."* That ADR writes the exact change out and declines to make it,
which is the behaviour the prohibition exists to produce.

The consequence on the union was measurable and had two halves, both worse than they look:

1. **No run mirrored anything.** `startAgentInThisContainer` called `startLocalAgent(request)` with
   no `deps`, so `sessionStore` was never supplied and every session lived only inside the sandbox
   — §14.9's release blocker, with the entire mechanism for avoiding it built, tested and
   unreachable.
2. **`readMirrorConfig`'s `invalid` arm had no caller, so it decided nothing.** That arm exists
   because a half-configured mirror — a URL with no cookie, an unparseable URL, a non-integer
   timeout — is an operator *turning durability on* and getting it wrong. With nothing calling the
   function, every one of those cases was indistinguishable from `absent`: exactly the ADR-0015
   fail-open shape the arm was written to close, one level up from where it was closed.

## Decision

**Make the call, in `apps/runner/src/index.ts`, as W2-INT-01's declared change, and read the
configuration once at start-up rather than once per run.**

```ts
export function sessionMirrorDeps(env = process.env): RunDeps {
  const config = readMirrorConfig(env);
  switch (config.kind) {
    case 'invalid':    throw new Error(config.reason);           // exit 1, named
    case 'configured': return { sessionStore: createHttpTranscriptMirror(config) };
    case 'absent':     return {};                                 // and say so
    default: { const unreachable: never = config; throw new Error(…); }
  }
}
```

`main()` calls it **before** `startRunnerServer`, and `startAgentInThisContainer` gained a third
parameter that defaults to `{}` so every existing caller and test is unaffected.

### Two deviations from the ADR's written-out code, each with its reason

W2-CP-07's record placed the check inside `startAgentInThisContainer`. It is placed in `main()`
instead:

- **"Refuse to start" has to mean the process, not the run.** A check inside the per-run function
  fails the first `POST /run` and leaves a runner that bound its port, answered `/healthz`, and was
  reported healthy by every orchestrator watching it. A start-up failure that happens after the
  port is published is one a health check calls healthy.
- **The environment is read once and closed over**, which is what the same file already does for
  `runnerBaseEnvironment()` and for the same stated reason: *"a run must not see a variable
  something mutated between requests."* Two reads of one configuration are two configurations.

The `default` arm with the `never` binding is added rather than omitted. `MirrorConfig` is a closed
union of three today; a fourth arm added later without a decision here must stop the runner, not be
read as "no mirror" by falling through — [ADR-0031](0031-a-static-gate-cannot-be-complete-so-undecidable-must-mean-refused.md).

## Consequences

- A runner started with `AW_SESSION_MIRROR_URL` and `AW_SESSION_MIRROR_COOKIE` set mirrors every
  transcript batch to the web application's `/api/sessions/:claudeSessionId/**` — the routes
  `installSessionApi()` had to be called for. **The two halves of §14.9 only work together**, which
  is why they land in the same commit rather than in two.
- A runner started with one of the two set and not the other **exits 1** with the reason printed,
  through the entry point's existing `[runner] failed to start: …` path. That behaviour did not
  exist before this change at any level.
- A runner started with neither logs `[runner] no session mirror: …` and runs. The run is honestly
  not durable, `claude.ts`'s `sessionDurability()` reports it, and nothing pretends otherwise.
- `apps/runner/src/index.ts` is declared on this task's `Owns globs:` line with this record as its
  reason, per [ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md) as narrowed by
  ADR-0038: the file has no other claimant at this level — W2-INT-01 is alone in sub-wave 2b-1-INT
  — and the change is composition, which is what ADR-0038 assigns here.
- `compose.yaml` does **not** set the two variables, and that file is not this task's. So
  `docker compose up -d` still produces a runner with no mirror. That is a declared gap on this
  task's PR, carried with the exact lines, not a silent one.

## Related

- `docs/adr/W2-CP-07-the-two-wiring-lines-this-task-does-not-own.md` — the declaration this record
  discharges, including the code it wrote out and the alternative (a module that installs itself on
  import) it correctly rejected as a service locator §53 forbids.
- [ADR-0038](0038-the-composition-root-and-the-shared-manifest-belong-to-the-integration-level.md)
  — the rule, and the "deciding versus re-deriving" test that extends it past the one file it names.
- [ADR-0015](0015-gates-decide-on-positive-assertions.md) — why an `invalid` arm with no caller was
  a fail-open, not merely unused code.
