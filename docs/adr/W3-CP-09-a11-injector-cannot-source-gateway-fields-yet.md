# W3-CP-09 — The A.11 injector is a standalone, fully-tested contract; two of its five unconditional keys cannot be wired to production `RunRequest` yet

Status: accepted
Date: 2026-09-06
Decided by: W3-CP-09 (environment)
Scope: `packages/runtime/src/env.ts`, `packages/core/src/config.ts`; binding on whoever wires the
Wave 4 model gateway and the §15.1 `RuntimeProfile` into a live run

## Context

A.11 requires five environment variables unconditionally: `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, `AGENT_WORKSPACE_RUN_ID`, `AGENT_WORKSPACE_SESSION_ID`
— plus four more conditionally (`NODE_USE_ENV_PROXY`, `HTTP_PROXY` / `HTTPS_PROXY`,
`OTEL_EXPORTER_OTLP_ENDPOINT`), each gated on a network policy, a Node version or a configured
collector.

This task builds `packages/runtime/src/env.ts`'s `buildRuntimeEnvironment` as the complete,
spec-derived implementation of that contract — every key, every condition, tested against a
parse of `docs/spec.md`'s own A.11 table (`env.test.ts`: 23 `it()` blocks, 57 `expect()` calls —
`grep -cE '^ *it\(' packages/runtime/src/env.test.ts` and
`grep -o 'expect(' packages/runtime/src/env.test.ts | wc -l`, round 2; round 1's "40 assertions"
matched neither number) — and additionally wires
two of the five unconditional keys into the **production** path: `packages/core/src/config.ts`'s
`compileRunRequest` now derives `AGENT_WORKSPACE_RUN_ID` / `AGENT_WORKSPACE_SESSION_ID` from the
`RunRequest`'s own `runId` / `sessionId` fields, exactly as it already derived `CLAUDE_CONFIG_DIR`
from `scope.configDir`.

The remaining three unconditional-or-conditional keys that touch a **credential or a network
policy** — `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and every conditional key — cannot be
wired into `compileRunRequest` today, because `RunRequest` (`packages/core/src/schemas.ts`, outside
this task's `Owns` globs) carries no field for any of them:

* `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` need a model gateway connection (§26). The gateway
  is Wave 4 ([ADR-0021](0021-phase-0-credential-step-belongs-to-wave-4.md)), and
  `apps/web/server/compose/run-request.ts`'s `buildRunRequestFor` already documents the same wall
  in its own words: *"What this side would have to put here instead is a provider credential, and
  spec A.11 forbids one entering a sandbox: the model gateway of §26 injects a short-lived
  run-scoped token, the gateway is Wave 4 ... So a run composed here reaches the model with no
  credential, which is a declared gap on this task's PR."* The Wave 3 plan's own "Declared
  gaps" section, item 3, names the identical wall for A.12 scenario 2.
* `NODE_USE_ENV_PROXY`, `HTTP_PROXY` / `HTTPS_PROXY` need a resolved `RuntimeProfile`
  (§15.1's `networkPolicy`), which `RunRequest` does not reference — `RuntimeConfig` in
  `packages/runtime/src/driver.ts` carries `runtimeProfileId` as a reference the *driver* resolves,
  not something `compileRunRequest` (which runs inside the runner, after a driver has already
  started the process) receives.
* `OTEL_EXPORTER_OTLP_ENDPOINT` needs a configured collector, which no schema in this repository
  carries yet.

## Decision

**`buildRuntimeEnvironment` implements the full contract as a standalone function; `compileRunRequest`
wires in only the two keys `RunRequest` already carries the source data for.** The other three keys'
production wiring is a declared gap under ADR-0035, not a partial or approximated implementation:

* The command actually attempted: reading `packages/core/src/schemas.ts`'s `RunRequest` for a
  gateway, profile or collector field — `grep -n "gatewayBaseUrl\|authToken\|networkPolicy\|otel"
  packages/core/src/schemas.ts` — finds none.
* The named missing resource: a `RunRequest` field carrying a resolved model-gateway connection
  (§26, Wave 4) and a resolved `RuntimeProfile` (§15.1, this wave's W3-CP-06 and its consumers).
* What is achievable without it, and is done: the complete, correct, spec-derived function, ready
  to be called the moment either field exists — `buildRuntimeEnvironment`'s signature already
  takes `gatewayBaseUrl`, `authToken`, `networkPolicy`, `proxyUrl` and
  `otelExporterOtlpEndpoint` as plain parameters, so wiring it in is passing four more arguments,
  not writing new logic.

## Why not add the fields to `RunRequest` here

`packages/core/src/schemas.ts` is outside this task's `Owns` globs
(`packages/runtime/src/env.ts`, `packages/runtime/src/env.test.ts`, `apps/runner/src/runtime.ts`,
`packages/core/src/config.ts`, `packages/core/src/config.test.ts`). Adding fields there is a
schema change with its own migration and validation surface, belongs to the task that resolves a
gateway connection or a runtime profile into concrete values, and is exactly the kind of
composition decision ADR-0038 puts at the level that owns the shared contract, not at a task that
only consumes it.

## Consequences

* `packages/runtime/src/env.ts` is complete and independently correct today; nothing about it
  needs to change when Wave 4 lands the gateway or when a `RuntimeProfile` is resolved into a run
  — only the caller gains arguments to pass.
* `packages/core/src/config.ts`'s `compileRunRequest` emits **three of A.11's nine** possible keys
  in production today — `CLAUDE_CONFIG_DIR`, `AGENT_WORKSPACE_RUN_ID`, `AGENT_WORKSPACE_SESSION_ID`
  — and refuses `ANTHROPIC_API_KEY` outright; it does not yet emit `ANTHROPIC_BASE_URL` /
  `ANTHROPIC_AUTH_TOKEN` or any conditional key, and says so in its own header rather than
  implying otherwise. Round 1 said "seven of nine" by also counting `PATH`, `HOME` (copied from
  the caller's own `env`, not derived from A.11) and `CLAUDE_CODE_PROJECT_DIR_NAME` (not an A.11
  key at all — A.11 has no row for it), which more than doubled the true production coverage.
  Derived, not transcribed:
  ```
  A.11 identifier names derived from spec.md §A.11 : 9 (ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN
    CLAUDE_CONFIG_DIR AGENT_WORKSPACE_RUN_ID AGENT_WORKSPACE_SESSION_ID HTTP_PROXY HTTPS_PROXY
    NODE_USE_ENV_PROXY OTEL_EXPORTER_OTLP_ENDPOINT)
  compileRunRequest's emitted env keys (packages/core/src/config.ts:137-140) : CLAUDE_CONFIG_DIR
    CLAUDE_CODE_PROJECT_DIR_NAME AGENT_WORKSPACE_RUN_ID AGENT_WORKSPACE_SESSION_ID (plus a spread
    of the caller's own request.env, which is where PATH / HOME come from when present)
  intersection (A.11 keys actually emitted)        : CLAUDE_CONFIG_DIR AGENT_WORKSPACE_RUN_ID
    AGENT_WORKSPACE_SESSION_ID
  count                                             : 3 of 9
  ```
* This is carried forward exactly the way the Wave 3 plan's own declared gaps are carried:
  named, with the missing resource stated, so Wave 4's gateway task and W3-CP-06's profile
  consumers inherit a ready function rather than a rediscovery of A.11's rules.
