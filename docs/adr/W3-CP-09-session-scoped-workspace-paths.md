# W3-CP-09 — §25's per-session directory is a ready function; the call site is outside this task's `Owns` (ADR-0038 shape)

Status: accepted
Date: 2026-09-06
Decided by: W3-CP-09 (environment)
Scope: `packages/runtime/src/env.ts`, `apps/runner/src/runtime.ts`; binding on whoever next edits
`apps/web/server/compose/run-request.ts` or `apps/runner/src/index.ts`

## Context

Spec §25: *"Each workspace and session must get a distinct directory."* The production path that
composes a run's `cwd` and `CLAUDE_CONFIG_DIR` today, `apps/web/server/compose/run-request.ts`'s
`sandboxFor`, computes both **per workspace**:

```ts
export function sandboxFor(workspaceId: string, settings: RuntimeSettings) {
  const cwd = `${settings.workspaceRoot}/${workspaceId}`;
  return { cwd, scope: { projectKey: workspaceId, configDir: `${cwd}/.claude` } };
}
```

Two sessions started against the same agent share one workspace id, so they are handed the same
`cwd` and the same `CLAUDE_CONFIG_DIR` — the exact collision §25 exists to prevent, and the one
the Wave 3 plan's 3a-2 row names as this task's to close (*"a distinct `cwd` per
session"*). `apps/web/server/compose/run-request.ts` is not in this task's `Owns` globs
(`packages/runtime/src/env.ts`, `packages/runtime/src/env.test.ts`, `apps/runner/src/runtime.ts`,
`packages/core/src/config.ts`, `packages/core/src/config.test.ts`), nor is
`apps/runner/src/index.ts`, the runner's own composition root
(`docs/adr/W1-COMP-01-the-runner-supplies-the-base-environment.md`) that also creates these
directories on disk (`startAgentInThisContainer`'s two `mkdirSync` calls).

## Decision

This task ships the per-session allocator as a pure, fully-tested function in its own package,
and the SAME RULE mirrored where the runner side would call it, and stops there — it does not
edit either composition file.

* `packages/runtime/src/env.ts`'s `sessionWorkspacePaths(workspaceRoot, sessionId)` — proven by
  `env.test.ts`: two distinct session ids under one root produce two distinct `cwd`s and two
  distinct `configDir`s, and a path-traversal, absolute-path, empty, or space-containing session
  id is refused by name (ADR-0015).
* `apps/runner/src/runtime.ts`'s `sessionScopedWorkspacePaths` — the same rule, duplicated for
  the same reason `RunnerAgentConnection` duplicates `AgentConnection` in the same file (`apps/runner`
  does not depend on `@agent-workspace/runtime`; see that file's header), so whichever composition
  root ends up calling it does not need a new workspace dependency to do so. **Not byte-identical**
  to `env.ts`'s copy, and round 1 was wrong to call it that: `env.ts` validates `workspaceRoot`
  with a `typeof` check (`requireNonEmptyString`) while `runtime.ts` validates it with
  `workspaceRoot.length === 0`, so a non-string root throws a different error from a different
  place in the two. Proven independently now by `apps/runner/src/runtime.test.ts`, driven against
  the same refusal list `env.test.ts` uses (`['../escape', '..', '/etc/passwd', 'C:\Windows', '',
  'a/b', 'a b']`) — round 1 shipped this function with zero tests and zero callers while this ADR
  and the function's own comment both claimed `env.test.ts` already covered it, which it could
  not: `env.test.ts` imports `./env.js`, never `apps/runner`.

**The call site is named, not made:** `sandboxFor` should compute `cwd` and `configDir` per
session — `sandboxFor(sessionId, workspaceRoot, settings)` calling
`sessionScopedWorkspacePaths(`${settings.workspaceRoot}/${workspaceId}`, sessionId)` — rather than
per workspace as it does today, and `apps/runner/src/index.ts`'s `startAgentInThisContainer`
continues to `mkdirSync` whatever `cwd` / `scope.configDir` the request now carries, unchanged
itself. This is ADR-0038's shape: a composition decision belongs to the level that owns the
composition root, and this task ships the function that call installs.

## Why not edit `sandboxFor` here

`apps/web/server/compose/run-request.ts` is outside this task's declared `Owns` globs. Editing it
would violate the wave protocol's absolute prohibition #6 (*"Never change a file outside your
declared `Owns` globs"*) regardless of how small or clearly-correct the change would be. The
protocol's own remedy applies: *"If you need something outside your globs, say so in your report
and work around it."* The two functions above are that workaround — correct and tested on this
task's side of the boundary, inert until the owning task or the integrator makes the one-line
call this ADR names.

## Consequences

* Until `sandboxFor` is updated, §25's per-session distinctness is **proven** (by `env.test.ts`,
  including a real two-session run through the `local` driver) but **not yet exercised on the
  production request-composition path** — a declared gap, carried here rather than silently left
  for a future reader to rediscover by noticing two sessions share a directory. That same
  two-session run is where A.12 scenario 10 is evaluated: `scenario10Verdict` consults
  `RuntimeCapabilities.isolation` **first**, so `local` reports `unsupported-by-capability` and
  never `pass`, on every host, unconditionally — round 2's version consulted host state first and
  could report a silent `pass` on a host with nothing to leak, which is exactly the CI runner this
  PR is gated on (round 3, ADR-0047, `docs/adr/0046-a-gate-may-not-assert-a-value-its-own-probe-fabricated.md`
  and `docs/adr/0047-a-probe-establishes-its-own-precondition-it-never-inherits-one-from-the-host.md`).
  The probe no longer reads the real host `~/.claude` at all — it seeds its own marker at a
  `hostConfigRoot` it creates and destroys, per ADR-0047's rule that a probe establishes its own
  precondition rather than reading one the host happens to provide — see
  `packages/runtime/src/env.test.ts`'s scenario-10 describe block. Distinct `cwd`/`configDir` per
  session and scenario 10's verdict are two different claims and only the first is "satisfied"
  here.
* The fix, when made, is small and mechanical: `sandboxFor` gains a `sessionId` parameter and
  calls the function this task shipped; nothing about `RunRequest`'s schema, `compileRunRequest`,
  or the `local` driver needs to change alongside it.
