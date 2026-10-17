# W1-DEP-01 — A wiring task is a symptom; the dependency belongs to the task that owns the manifest

Status: accepted
Date: 2026-09-03
Decided by: W1-DEP-01 (Infra), applying ADR-0017
Scope: the two app manifests, `packages/core`'s `exports` map and the lockfile; binding on every
       future wave's dependency planning

## Context

This task was not in the plan. It was invented mid-wave to repair a state that two Wave 1a tasks
could not repair themselves, and the first thing this record has to explain is why it had to be
invented at all.

Plan §2.3 rules that dependency additions for a whole wave are batched into that wave's **first**
task, and [ADR-0009](0009-pnpm-lock-ownership-exception.md) extends the same rule to
`pnpm-lock.yaml`. The rule is sound for the collision it was written against: two tasks editing one
manifest in parallel produce a conflict that neither can resolve alone.

It fails when the manifest that needs changing is not the first task's. Wave 1 needed exactly two
dependency edits, and neither of the two manifests belonged to the wave's first task:

- `apps/runner` needs `@anthropic-ai/claude-agent-sdk` pinned at the exact version R-01 §11 prints.
  Spec §42 requires a pin and R-01 records why an exact one: the SDK is 0.x and ships breaking
  changes in patch releases, so a caret range takes one silently.
- `apps/web` needs `@agent-workspace/core` at `workspace:*`. Without it, every §34 agent route
  answers `503 agents_runtime_not_configured` — the state W1-CP-05 landed in and could not leave.

ADR-0009's remedy for this case is one sentence: "A later task in the same wave that discovers it
needs a new dependency **escalates**; it does not edit the lockfile in parallel." Both tasks did
escalate. Escalation is a way to *stop*, not a mechanism for getting a dependency added, so the
escalations had no destination and the work stalled with the runtime unwired.

The most useful evidence that this was a design fault and not an accident is in ADR-0009 itself.
Its Alternatives considered rejected "a dedicated 'lockfile' task per wave" as "ceremony: it
serialises every wave behind a task that does nothing but run `pnpm install`." That is a precise
description of this task. The alternative it rejected is what the programme ended up doing, because
the rule it chose instead had no path out of the case above.

## Decision

`pnpm-lock.yaml` remains owned by the wave's first task, as ADR-0009 says. **A `package.json`
does not.** Per ADR-0017 — which amends ADR-0009 and lands with this wave's repair, not on this
branch — a package manifest is owned by the task that owns the package, and a task that needs a
dependency in its own package's manifest adds it there, regenerates the lockfile with
`pnpm install`, and declares the lockfile in its PR body's Ownership section. Lockfile conflicts are resolved by re-running `pnpm install`, never by
hand-merging. The root `package.json` is still the wave's first task's.

**Withdrawn: "a future wave in this position must not invent a task like this one."** The first
revision of this record ended the Decision with that sentence. It contradicts the ADR the record
declares itself to be applying, and ADR-0017 is authoritative. Its rule 5 reads:

> Where a wave needs wiring that spans packages … that is **a task** … Wave 1a's repair adds
> `W1-DEP-01` for exactly this.

The reconciled rule, and it has two halves, not one:

- A dependency that lives **inside one package** belongs to the task that owns that package's
  manifest. It is not batched into the wave's first task, and it does not need a task of its own.
  `apps/runner` → `@anthropic-ai/claude-agent-sdk` is that case, which is why W1-CORE-01 had
  already landed it and this task changed nothing there.
- Wiring that **spans packages** — one package's manifest, another package's exports, and the
  resolution path between them — is a task. `apps/web` → `@agent-workspace/core` is that case.
  ADR-0017 rule 5 names this task as the example. The second half of this record, below, is the
  part that could only have been done by a task holding both manifests at once, and it is the
  evidence for rule 5 rather than against it.

What a future planner should take from this record is therefore not "do not plan a wiring task"
but "a wiring task owns the resolution, not just the specifier". ADR-0017 is an orchestrator draft
and is on no branch in this repository; the quotation above is reproduced from the task brief so
that the reconciliation is legible before the ADR lands. See declared gap 3 in the PR body.

## What this task wired, and the constraint on each

**`apps/runner` → `@anthropic-ai/claude-agent-sdk`, exact, in `dependencies`.** Two constraints,
and both are load-bearing:

- *Exact, not a range.* R-01 §11's Contract summary prints the manifest fragment to copy, and R-01
  §1 states the reason: a caret or tilde range would take a breaking change from a 0.x patch
  release silently. The version is read from R-01, not chosen here.
- *`dependencies`, not `devDependencies`.* The SDK reports its licence to pnpm as the literal
  string `Unknown`, so it can only pass `scripts/check-licenses.mjs` through R-16's recorded
  exception, and that exception is scoped `prod`. The gate compares an exception's scope against
  the scope of the run and rejects a mismatch by name, so a `devDependencies` placement is reported
  as scope-mismatched — correctly. `dependencies` is also where it belongs on the merits: the
  runner loads the SDK at runtime and the published runner image redistributes it.

By the time this task branched, W1-CORE-01's amendment had already landed exactly that fragment.
This task verified the pin against R-01 §11 and changed nothing. That is the outcome ADR-0017 wants
— the dependency arriving in the task that owns the package — reached from the other direction.

**`apps/web` → `@agent-workspace/core` at `workspace:*`.** A workspace protocol specifier, not a
version: `packages/core` is `private: true` and is never published
([W0-INF-01](W0-INF-01-internal-packages-are-not-published.md)), so there is no registry version to
pin and `workspace:*` is the only specifier that means "the one in this tree". `pnpm install`
records it in the lockfile as `link:../../packages/core`; no external package enters the tree.

**The licence policy was not touched.** Both `node scripts/check-licenses.mjs` and
`node scripts/check-licenses.mjs --dev` were run against the installed tree after the change and
both pass. Neither `POLICY` nor `EXCEPTIONS` in `scripts/check-licenses.mjs` was edited, and the
file is not in this task's Owns globs. Had either gate tripped, the instruction was to report and
escalate rather than widen the policy; it did not trip.

## The manifest link was necessary and not sufficient

The first revision of this record claimed, in Consequences, that with the manifest edit in place
"Wave 1a's escalated tasks can rebase onto this branch and their routes resolve
`@agent-workspace/core`". **That was false, and it was false in the way that costs a downstream
task a red CI run rather than a confusing one.** The review that caught it reproduced the failure;
so did this repair, before changing anything. The manifest edit does everything it can: `pnpm
install` creates `apps/web/node_modules/@agent-workspace/core` as a symlink to `packages/core`.
Resolution then died one step later, inside the target package.

`packages/core` is `type: module` and its `exports` map pointed every condition at `./dist`:

```json
".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
```

`dist/` is produced by `packages/core`'s `build` script — invoked directly, by the root `pnpm
build`, or by core's own `db:migrate` and `db:seed`, which chain `pnpm run build` — and by nothing
else. None of those is reached by `pnpm typecheck`, by `pnpm test` or by any step in
`.github/workflows/ci.yml`, and
`tsconfig.root.json` declares no project references, so no build happens transitively either. A
consumer in `apps/web` importing the package therefore failed at `tsc` with `TS2307`, and at Node
with `MODULE_NOT_FOUND` — with the dependency correctly declared and correctly linked. A wiring
task that stops at the specifier has wired a link to a directory that does not exist.

### Decision: `packages/core` publishes its TypeScript sources through the `types` condition

The `exports` map now resolves types to source and runtime to build output:

```json
".":    { "types": "./src/index.ts",    "default": "./dist/index.js" },
"./db": { "types": "./src/db/index.ts", "default": "./dist/db/index.js" }
```

`apps/web` sets `moduleResolution: "bundler"` and every other tsconfig in the repository inherits
`nodenext` from the root config. Both honour `exports` and both take the `types` condition first —
`--traceResolution` under each prints the same answer, `packages/core/src/index.ts`, and the PR
body shows both traces. **Plain `pnpm typecheck` from a clean
checkout, with `packages/core/dist` absent, type-checks an `apps/web` file that imports
`@agent-workspace/core`.** That is this task's acceptance line and the PR body prints the run,
including the trace showing which file the specifier resolved to and a negative control proving
the module is really read rather than widened to `any`.

**What it costs, plainly:**

- A consumer's `tsc` now compiles `packages/core`'s sources under the *consumer's* compiler
  options, not core's own. The two configs differ — `apps/web` overrides `lib`, `module`,
  `moduleResolution` and `jsx` among others — so a construct that is legal in core's project can
  fail in a consumer's, and the error surfaces in the consumer with a path into someone else's
  package. Both projects extend the same root config for every strictness flag, which is what
  keeps this narrow. This is not theoretical and was not left as an inference. The PR body prints
  two demonstrations. First: a deliberate `TS2322` planted in `packages/core/src/index.ts` is
  reported *by `apps/web`'s typecheck*, at a `../../packages/core/src/index.ts` path — the
  consumer now owns core's errors. Second, and the sharper one, found while checking this very
  bullet: type-checking the same probe with `strict` **off** makes `packages/core/src/schemas.ts`
  itself fail with `TS2339`, in a consumer that never touched that file. Nothing in this repository
  is exposed to that — the root `tsconfig.json` sets `"strict": true` and every package's config
  extends it, and the same command with `--strict` restored is silent — but it is precisely the
  coupling this bullet declares, caught in the act rather than argued for.
- Consumer type-check time now includes core's sources rather than reading finished `.d.ts` files,
  and `skipLibCheck` does not apply to them because they are `.ts`, not `.d.ts`.
- The legacy top-level `main` and `types` fields still point at `dist/`. This task's grant on
  `packages/core/package.json` is the `exports` map only, and no resolver in this repository reads
  those fields. Checked rather than assumed, and the PR body prints it: with `main` and `types`
  repointed at a directory that does not exist, both a `bundler` and a `nodenext` consumer still
  resolve the package, because both prefer `exports`. Moving those fields is `packages/core`'s
  owner's edit, not this task's. Named so it is inherited rather than discovered.

### The bundler is a second path, and it needed the other fix

The `types` condition does not help Turbopack or Node, which take `default` and therefore still
need `dist/`. This is not hypothetical: a route handler under `apps/web/app` that imports the
package fails `next build` with `Module not found: Can't resolve '@agent-workspace/core'` when
`dist/` is absent — reproduced in the PR body, because W1-CP-05's routes are exactly that shape.

`apps/web`'s own `dev` and `build` scripts therefore build the dependency first:

```json
"dev":   "pnpm --filter @agent-workspace/core build && next dev",
"build": "pnpm --filter @agent-workspace/core build && next build"
```

This is deliberately in the consumer's manifest — a file this task owns — and not in CI. **A fix
that works only because CI happens to build first is not a fix**: it leaves every developer, and
every task running the acceptance line locally, on the broken path. Per the task brief, W1-INF-02
owns `.github/workflows/ci.yml` and is adding build ordering there in the same round — that is CI
enforcing the same invariant, not the invariant's only home. Stated as attribution rather than as
fact: `aw/w1-08-ci-database` was not on `origin` when this was written, so nothing here was checked
against it, and nothing here depends on it.

The root `pnpm build` did already order correctly on its own: `pnpm -r build` is topological, and
this task's `apps/web` → `@agent-workspace/core` edit is the workspace's only dependency edge, so
it is what puts `packages/core` before `apps/web` in that order. That was never the problem. The
problem is that no gate runs `pnpm build`, and neither does the command a developer actually
reaches for — `pnpm --filter @agent-workspace/web dev`. The script edit puts the ordering on *that*
path.

Neither half of this instructs a consumer to run a build by hand. That was the state this repair
was opened to leave.

## Alternatives considered

- **Wait for a Wave 1 restack that moves both dependencies into the first task.** Rejected: it
  serialises the whole wave behind a rewrite of a branch that other sessions are already stacked
  on, to reach a manifest state ADR-0017 says is wrong anyway.
- **Add the SDK to `apps/runner`'s `devDependencies` to dodge the redistribution question.**
  Rejected on two counts. It is false — the runner imports the SDK at runtime — and it would be
  caught, because R-16's exception is scoped `prod`. Retargeting the exception to `all` to make
  that placement pass would be widening a licence policy to accommodate a mislabelled dependency,
  which is the failure mode this programme keeps catching.
- **Vendor the SDK into the repository to avoid the `Unknown` licence entirely.** Rejected: R-16's
  exception is conditioned on the SDK being installed unmodified from npm at image build time and
  never vendored or patched, and D-13 governs redistribution on that basis.
- **Leave `exports` at `dist/` and tell consumers to run `pnpm --filter @agent-workspace/core
  build` first.** Rejected, and it is the state this repair exists to leave. It makes a green local
  run depend on a step nothing prints and nothing checks, and it hands the next task a red
  Typecheck it did not cause.
- **TypeScript project references (`composite` + `tsc -b`).** The structurally cleanest answer: it
  would build `dist/` on demand and keep consumers reading `.d.ts`. Rejected here on ownership, not
  on merit — it requires editing `packages/core/tsconfig*.json`, the root `tsconfig.json` and every
  consumer's `typecheck` script from `tsc -p` to `tsc -b`. Only the manifests are this task's.
  Recorded so the owner of the TypeScript layout can take it up as a follow-up; the `types`
  condition does not block it, and removing the condition afterwards would be a one-line revert.
- **Point `default` at source too, and let Node 24's type stripping run core directly.** Rejected
  on a checked fact rather than a preference: core's modules import each other with `.js`
  specifiers (`export * from './types.js'`), and Node's type stripping does not rewrite `.js` to
  `.ts`. Importing the source entry point directly under Node 24 fails with
  `ERR_MODULE_NOT_FOUND ... packages\core\src\types.js`; the PR body prints it. It would also make
  `dist/` dead while
  `db:migrate`/`db:seed` still execute from it.
- **Add build ordering only to `.github/workflows/ci.yml`.** Not this task's file, and not
  sufficient anyway — see the paragraph above on why a CI-only fix is not a fix. W1-INF-02 adds it
  there as enforcement on top of a fix that already holds without it.

## Consequences

- Wave 1a's escalated tasks can rebase onto this branch and import `@agent-workspace/core` from
  `apps/web` without a manual build step: `pnpm typecheck` resolves it through the `types`
  condition with `dist/` absent, and `pnpm --filter @agent-workspace/web build` builds `dist/`
  before Turbopack needs it. Both were reproduced against a probe import before and after the
  change; the PR body prints both runs. This is a correction — the first revision of this bullet
  claimed the same outcome from the manifest edit alone, which was false, and the section above
  records why.
- This task still does not un-503 any route: no route exists on this branch to un-503, and no
  source file was touched. What it now guarantees is that the route the next task writes compiles
  and bundles, rather than that the specifier is spelled correctly.
- `packages/core`'s consumers pay the coupling named in the section above: their `tsc` compiles
  core's sources under their own compiler options. `packages/core` is the only workspace package
  any other package depends on today, and `apps/web` is its only consumer, so the blast radius is
  one edge.
- `pnpm-lock.yaml` gains one importer entry and no packages. It is declared in this task's PR body
  Ownership section per ADR-0009 and ADR-0017.
- **Declared gap — nothing asserts either dependency is present.** Read this task's acceptance line
  honestly against [ADR-0015](0015-gates-decide-on-positive-assertions.md): every command in it
  decides on the absence of a negative. `pnpm install --frozen-lockfile` asserts that the lockfile
  and the manifests agree with each other, not that either dependency is declared; a diff that
  deletes `@agent-workspace/core` from `apps/web` and re-runs `pnpm install` passes the whole
  acceptance line, and the routes silently return to `503 agents_runtime_not_configured`. The
  licence gates likewise pass on a tree from which the SDK has been removed, because there is then
  nothing to license. The two specific holes:
  - no test reads `apps/runner/package.json` and asserts `dependencies['@anthropic-ai/claude-agent-sdk']`
    is a bare exact version — a specifier carrying `^`, `~`, `>=`, `x`, `*` or a range must be
    rejected, and so must an absent key and a `devDependencies` placement;
  - no test reads `apps/web/package.json` and asserts `dependencies['@agent-workspace/core']` is a
    `workspace:` specifier.

  This task cannot close either: its Owns globs are the two manifests, the lockfile and this
  record, and its brief forbids source files, so the assertion has nowhere to live that this task
  owns. The assertion belongs beside the SDK surface gate in the task that owns `tests/`, and it is
  named here so the next task inherits a written gap rather than an unexamined green.
- **Declared gap — the resolution route is fixed but not yet gated, for the same ownership
  reason.** The fix above is demonstrated by a probe that this task creates, runs and deletes,
  because no committed file in `apps/web` imports `@agent-workspace/core` and this task may not add
  one. So on *this* branch `pnpm typecheck` still passes over a tree where no consumer exercises
  the route; it would have passed before the fix too. The positive assertion arrives with the first
  committed import — W1-CP-05's `apps/web/app/api/agents` routes — at which point `pnpm typecheck`
  becomes the standing gate on the `types` condition and `pnpm --filter @agent-workspace/web build`
  on the `default` one, with no new machinery needed. Two consequences worth stating rather than
  discovering:
  - a future edit that reverted the `exports` map to `./dist/*.d.ts` would go green on this branch,
    and red on the branch above it *as soon as that branch actually imports the package* — which is
    not true of W1-CP-05 as it stands today: its files name `@agent-workspace/core` in comments
    only, which is why it 503s. The PR body's A/B runs both sides with a probe supplying the import
    the rebase exists to unlock. The record above is what tells the person reading that red build
    why the condition is there;
  - the ADR-0015-shaped assertion that *would* close this is a test importing
    `@agent-workspace/core` from a consumer's project with `dist/` absent. It has the same home as
    the two manifest assertions above: the task that owns `tests/`.
