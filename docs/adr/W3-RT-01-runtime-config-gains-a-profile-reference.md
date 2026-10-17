# W3-RT-01 — `RuntimeConfig` gains an optional `runtimeProfileId`, a reference, never a copy

Status: accepted
Date: 2026-09-06
Decided by: W3-RT-01 (the one abstraction)
Scope: `packages/runtime/src/driver.ts`; binding on every driver task that reads `RuntimeConfig`
(W3-RT-03, W3-RT-04) and on W3-CP-06 / W3-RT-10b, which populate the id this references

## Context

The Wave 3 plan's 3a-1 cell states one of the three things the task card does not say
explicitly, because `driver.ts` already exists on `main`:

> `RuntimeConfig` today carries only `sessionId` and `workspacePath`, and its comment says the
> profile *"joins here in Wave 3, when there is a driver whose behaviour it can change."* That join
> is this task's: `RuntimeConfig` gains the `RuntimeProfile` reference, and §14.9's reversibility
> rule — *"Runtime selection therefore stores a profile reference, never a copy of the profile"* —
> means a reference, not an inlined profile.

Spec §14.2 does not print `RuntimeConfig` at all (`driver.ts`'s own header has always said so), so
this addition is not something `spec-transcription.test.ts` can check against a fenced block — it
is a decision this ADR records instead.

## Decision

`RuntimeConfig` gains one field:

```ts
export type RuntimeConfig = {
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly runtimeProfileId?: string;
};
```

Three choices inside that one line, each forced by something outside this task's own preference:

1. **A reference (`runtimeProfileId: string`), never an inlined `RuntimeProfile`.** §14.9, quoted
   above, rules out storing a copy. A `RuntimeProfile` is a database row (§27, built by W3-CP-06 at
   3a-2 in `packages/core`); the natural, and only honest, reference to a database row from a
   package that may not depend on anything database-shaped is its `id`.
2. **Optional, not required.** Two independent reasons converge on the same answer:
   * §15.1 itself: *"[`driverConfig`] must never be required to create a working profile: every
     driver ships defaults."* The same principle extends to the profile as a whole — a
     `RuntimeConfig` with no profile reference is a legitimate value, meaning "use this driver's
     defaults," not a malformed one.
   * Backward compatibility: `packages/runtime/src/local.ts` is not in this task's `Owns` globs
     (see "Nothing else in this PR" in the plan's 3a-1 cell), and its `create()` destructures
     `config.sessionId`/`config.workspacePath` and constructs `RuntimeConfig`-typed values nowhere
     else that would need updating — but a hypothetical future required field would break any
     other tracked caller of `create()` that constructs a `RuntimeConfig` literal without it, none
     of which this task may touch. An optional field is additive and cannot break a caller that
     predates it; verified directly — `pnpm build`, `pnpm typecheck` and `pnpm test` all pass
     unchanged against `local.ts` and the rest of the tree with this field added (see this task's
     PR body for the pasted output).
3. **Resolving the id to an actual `RuntimeProfile` is not this package's job.** `create(config:
   RuntimeConfig)` still only constructs a `RuntimeHandle`; a driver that wants the profile's
   resource/network settings reads them from the resolved `RuntimeProfile` its caller looked up
   (in `packages/core`, which *can* depend on a database) and passes down through means the driver
   itself defines — `RuntimeConfig.runtimeProfileId` is the identity the platform threads through,
   not a channel for the profile's fields. This keeps `packages/runtime` at zero dependencies:
   resolving an id to a row is a database read, and this package does not do those.

## What this does not do

This task does not wire `runtimeProfileId` into `local.ts`'s `create()` (out of `Owns` globs by
construction — see the plan's 3a-1 cell), does not create the `runtime_profiles` table (W3-CP-06,
3a-2), and does not add the column that stores this reference on `agents` (also W3-CP-06, per its
Accept cell: *"§14.9's 'Runtime selection therefore stores a profile reference, never a copy of the
profile' is the column added to `agents`"*). Those are the two declared consumers of this field —
one at 3a-2 (same sub-wave, in parallel) and one across the driver tasks of 3b (which construct
real `RuntimeConfig` values against real drivers) — and this ADR exists so both know the field's
name and semantics without re-deriving them.
