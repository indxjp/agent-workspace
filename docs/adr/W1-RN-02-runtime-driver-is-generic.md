# W1-RN-02 — `RuntimeDriver` is generic, because `packages/runtime` may not depend on `@agent-workspace/core`

Status: accepted
Date: 2026-09-03
Decided by: W1-RN-02 (Runner)
Scope: `packages/runtime/src/{driver,local,index}.ts`, `apps/runner/src/{runtime,server}.ts`; binding on
W3-RT-01, which widens this interface

## Context

Spec §14.2 prints the runtime driver contract with two named types this repository already owns:

```ts
startAgent(runtime: RuntimeHandle, request: AgentRunRequest): Promise<AgentConnection>;
interface AgentConnection { events: AsyncIterable<AgentEvent>; … }
```

`AgentRunRequest` is `RunRequest` and `AgentEvent` is `ClassifiedSdkEvent`. Both live in
`@agent-workspace/core`, both are SDK-free by construction, and importing them is the obvious
implementation.

The import cannot be made, for the same mechanical reason W1-CP-05 documented from `apps/web`
(`docs/adr/W1-CP-05-agents-api-has-no-core-dependency.md`):

* `packages/runtime/package.json` declares no dependencies, and pnpm's isolated `node_modules`
  layout means `@agent-workspace/core` resolves from neither the type-checker nor the loader.
* Adding `"@agent-workspace/core": "workspace:*"` edits `pnpm-lock.yaml`, which
  [ADR-0009](0009-pnpm-lock-ownership-exception.md) assigns to the **first** task in a wave and
  which explicitly rules that "a later task in the same wave that discovers it needs a new
  dependency **escalates**; it does not edit the lockfile in parallel". W1-RN-02 is not that first
  task. (**ADR-0017 has since amended this** — see the alternative below, which was re-decided in
  verification round 1 rather than left resting on a rule that had changed.)
* The mirror problem exists in the other direction too: `apps/runner/package.json` does not list
  `@agent-workspace/runtime` and is outside this task's `Owns` globs, so `apps/runner` cannot
  import the driver interface either.

So the choice was not "import core, or do something clever". It was "produce a driver interface
that needs no dependency, or land nothing".

## Decision

**1. The two spec-named types become type parameters.** `packages/runtime/src/driver.ts` declares
`AgentConnection<TEvent>` and `RuntimeDriver<TRequest, TEvent>`. Nothing else changes: the member
names, their order, and `RuntimeHandle`, `RuntimeDriverId` and `RuntimeCapabilities` are
transcribed from §14.2 and §14.5 unchanged. There is still exactly one abstraction (§14.1 rule 3);
the parameters are the seam where a caller that *can* import core supplies the concrete types.

**2. `createLocalDriver` takes the agent starter as an argument.** This is independently forced by
spec §42 — `apps/runner/src/claude.ts` is the only file that may import the Agent SDK, so a driver
that called `query()` would break the boundary on its first line. The generic parameters and the
injected starter are therefore the same seam seen from two sides, not two separate mechanisms.

**3. `apps/runner/src/runtime.ts` declares `RunnerAgentConnection` locally.** It is structurally
identical to `AgentConnection<ClassifiedSdkEvent>` plus one member — `sessionDurability()`, which
carries the §14.9 verdict `claude.ts` produces. The duplication is real, is declared as a gap on
this task's PR, and is not hidden behind a comment that says "keep in sync".

**4. The two halves were composed and executed, not assumed to fit.** The acceptance transcript
wires `createLocalDriver` from `packages/runtime/dist` to `startLocalAgent` from
`apps/runner/dist` and runs a real agent turn through the result. That is the assignment TypeScript
cannot check across the missing package link, so it was checked by running it. A structural match
asserted only by inspection would be exactly the "supported because nothing failed" claim
ADR-0015 forbids.

## Alternatives considered

* **Add the workspace links and declare them in the Ownership section**, as W0-INF-01 did for the
  lockfile. Rejected when this record was first written, because ADR-0009 ratified that for the
  *first* task in a wave and required a later task to escalate.

  **Re-decided in verification round 1, under ADR-0017**, which amends ADR-0009: a manifest belongs
  to its package, and this task's `Owns` globs include `packages/runtime/package.json`. So adding
  `"@agent-workspace/core": "workspace:*"` there and regenerating `pnpm-lock.yaml` is now permitted,
  and the ADR-0009 argument above no longer carries the decision on its own. It was still not done,
  for reasons that survive the amendment:

  * It buys nothing this wave. The only consumer that needs the concrete types is `apps/runner`,
    and `apps/runner/package.json` is **not** in this task's globs — so the runner still cannot
    import `@agent-workspace/runtime`, still cannot construct the driver, and still needs its own
    `RunnerAgentConnection`. Dropping the type parameters would remove noise from call sites that
    do not exist yet.
  * It costs a build-order change. `packages/runtime` currently type-checks with no dependency
    graph; reaching `@agent-workspace/core` means reaching its built `dist/`, which is the problem
    `docs/adr/W1-RN-01-runner-typecheck-builds-core-first.md` had to solve for `apps/runner` with a
    `typecheck` script that builds core first. Taking that on in a repair round, to delete two type
    parameters nobody writes, is the wrong trade.

  Whoever adds `"@agent-workspace/runtime": "workspace:*"` to `apps/runner/package.json` should do
  both edits together; at that point the generics and the duplicated connection type go in one
  change, and the build-order cost is paid once for a benefit that exists.
* **Import `packages/runtime/src/driver.ts` from `apps/runner` by relative path**, the way
  `tests/sdk-surface.test.ts` reaches into `packages/core/src/types.ts`. Rejected on facts:
  `apps/runner/tsconfig.build.json` sets `rootDir: "src"`, so a file outside `src` fails to emit
  (TS6059) and `pnpm build` breaks. `tests/` gets away with it because it emits nothing.
* **Drop the type parameters and type the events as `{ kind: string }`.** Rejected: it type-checks
  and destroys the value. The consumer could no longer narrow `ClassifiedSdkEvent`, so
  `server.ts`'s exhaustive switch — the thing that makes a new SDK event arrive under a name
  somebody chose — would become an open `default`.
* **Duplicate `RunRequest` and `ClassifiedSdkEvent` inside `packages/runtime`.** Rejected outright,
  for the reason W1-CP-05 gave about the Drizzle schema: two definitions of one type is the failure
  a shared package exists to prevent, and this pair is far larger than one connection interface.
* **Escalate the whole task.** Rejected: the §14.3 server, the driver interface, the `local` driver
  and its capability record are all independent of which package name the types are imported under,
  and all four are exercised end to end here.

## Consequences

* **The generics are noise at every call site until the link lands.** `RuntimeDriver<RunRequest,
  ClassifiedSdkEvent>` is what a reader has to write where `RuntimeDriver` would do. That is the
  price, and it is visible rather than hidden.
* **`apps/runner` cannot construct the `local` driver.** Nothing in the shipped tree calls
  `createLocalDriver`; the acceptance script composes the two `dist/` outputs from outside the
  workspace to prove they fit. Whoever adds the two dependency lines can delete the local
  `RunnerAgentConnection`, import `AgentConnection`, and wire the driver in `runtime.ts` — an edit
  of a few lines, in files that already exist.
* **W3-RT-01 inherits a narrower interface than §14.2 prints.** `putFiles` and `getFiles` are
  absent, and the task card says so: that task transcribes the full interface and widens this file.
  A method declared now would be one no driver implements and no endpoint serves.
* **If a later wave decides the parameters should go, removing them is mechanical.** They appear
  only in this package's own declarations — `AgentConnection`, `RuntimeDriver`, `AgentStarter`,
  `createLocalDriver` — and nowhere else; the concrete types are already what every caller passes.
