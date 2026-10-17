# W1-CORE-01 — The tenant session key is validated before the run starts, because both of the SDK's failure modes are silent

Status: accepted
Date: 2026-09-03
Decided by: W1-CORE-01 (Schema/Core)
Scope: `packages/core/src/{types,schemas,config}.ts`, `tests/sdk-surface.test.ts`; binding on
W1-RN-01 (`apps/runner`) and on anything that launches a run

## Context

Spec §20 stores a Claude session id per session and §25 requires multi-tenant isolation. R-01 §7
established what actually keys a session's transcript, and the finding is uncomfortable:

- `SessionKey.projectKey` is supplied **by the SDK to the store adapter**. The adapter cannot choose
  it, and **there is no `projectKey` option** — the name appears nowhere in the 65 `Options` keys.
- The only lever is the environment variable `CLAUDE_CODE_PROJECT_DIR_NAME`, set **beside**
  `CLAUDE_CONFIG_DIR` in `options.env`, on SDK ≥ 0.3.234.
- Left at its default, `projectKey` is the sanitised `cwd`. Two tenants whose sandboxes share a
  workspace path then share one session-key namespace.

And both ways of getting it wrong are silent. From the resolver in the shipped `sdk.mjs`, which
reads `() => CLAUDE_CONFIG_DIR ? validate(CLAUDE_CODE_PROJECT_DIR_NAME) : undefined` with
`validate = (e) => (!e || !/^[A-Za-z0-9_-]{1,64}$/.test(e) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(e)) ? undefined : e`:

1. **`CLAUDE_CONFIG_DIR` unset ⇒ the name is ignored entirely.** The ternary short-circuits.
2. **A value that fails the regex, or names a Windows device, is ignored.** `validate` returns
   `undefined` — a bare `return`, not a throw.

In both cases the SDK falls back to the sanitised `cwd`. Nothing throws. Nothing is logged. The
platform cannot learn about it afterwards, and the observable symptom is the cross-tenant key
collision the override existed to prevent.

R-01 §7 closes with an instruction rather than a suggestion: *"W1 should assert both in
`tests/sdk-surface.test.ts` before the tenant-isolation claim is called closed"*, and *"the runner
must validate the value against that regex itself and refuse to start the run otherwise."*

This is also the textbook ADR-0015 shape. A guard written as "if the SDK complains, stop" decides on
the absence of a negative — and the SDK never complains.

## Decision

**1. `validateTenantSessionScope({ projectKey, configDir })` lives in `packages/core/src/schemas.ts`
and returns a two-arm verdict.** There is no "probably fine" arm and `ok: false` always carries a
sentence naming which of the two failure modes was avoided. It parses before it compares: a
non-string `projectKey`, a non-string or blank `configDir`, or a non-object argument are each
rejected by name rather than reaching a regex.

**2. The scope is part of `RunRequest`, and `compileRunRequest` re-parses it.** A run whose scope
fails validation does not compile, so it cannot start. It does not start with a warning and it does
not start with a fallback key.

**3. `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_PROJECT_DIR_NAME` are *derived* from the scope, never
copied from `env`.** `RunEnvironment` rejects a request that sets either variable itself. Two
sources for one value is two values, and the one that loses is the one that decides tenant
isolation.

**4. Both silent failure modes are asserted in `tests/sdk-surface.test.ts` against the installed
bundle.** The test locates the validator and the `CLAUDE_CONFIG_DIR` ternary in `sdk.mjs`, extracts
the SDK's two regex sources, and requires our verdict to agree with theirs case by case. If upstream
loosens either rule, the disagreement surfaces as a failing test rather than as a shared namespace.

## Alternatives considered

- **Trust the SDK to reject a bad value.** Rejected: it does not reject, it falls back. This is the
  precise failure ADR-0015 names.
- **Transcribe the regex into our code and stop there.** Rejected as insufficient: a transcription
  is correct on the day it is written. The surface test compares against the shipped regex instead.
- **Normalise an invalid tenant id (slugify it) rather than refusing.** Rejected. Two different
  tenant ids can normalise to one key, which re-creates the collision while looking like a fix. The
  platform must constrain tenant ids to the SDK's alphabet at the point they are minted; until then,
  refusing is the honest answer.
- **Validate only in the runner.** Rejected: the check belongs where the type is, so every caller
  gets it. The runner still needs its own pre-flight, and that is W1-RN-01's to write.

## Consequences

- A tenant id that is not `[A-Za-z0-9_-]{1,64}` cannot start a run. Whoever mints tenant ids must
  respect that alphabet — a bare UUID does, a human-readable slug may not. Declared as a gap: no
  table in this wave constrains tenant ids to it, because the tenant identifier the runner will use
  is not yet chosen.
- The evidence for the two failure modes is now **read from the shipped bundle**, which is stronger
  than R-01's vendor-page citation and still **weaker than a live probe**. No run in this task
  executed the SDK. `RuntimeCapabilities`-style claims about tenant isolation must continue to say
  so until a probe on the Linux runner image exercises it.
- The surface test's bundle patterns are deliberately exact and will break on an SDK upgrade. That
  is the point: re-reading the resolver is the correct response to a version bump.
