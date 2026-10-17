# W1-CP-06 — The session carries the workspace slug, and workspace scoping is a contract this task cannot enforce

Status: accepted
Date: 2026-09-03
Decided by: W1-CP-06 (Control Plane)
Scope: `apps/web/server/auth/workspace.ts`, `apps/web/server/auth/index.ts`

## Context

The task line reads *"session cookie, workspace scoping on every query"*, and spec §25 is
unambiguous about why: *"Do not allow Claude configuration from one workspace to leak into
another."* The database half of that rule is already mechanical — `tenancy.test.ts` in
`packages/core` fails the build if a new table carries no `workspace_id`, and names the only two
exemptions.

One fact constrains what the application half can be, on this branch:

**This task owns no query code.** The §34 route handlers are W1-CP-04's
(`apps/web/server/runs/**`, `apps/web/app/api/{agents,runs}/**`) and W1-CP-05's
(`apps/web/server/agents/**`, `apps/web/app/api/agents/**`), on parallel branches. On this branch
`apps/web/app/api` does not exist.

### The fact this record used to lead with was not a fact

Every version of this record before verification round 2 opened with *"`apps/web` has no database
client. Its dependencies are `next`, `react` and `react-dom`."* That was true when the sentence
was written, against base `aw/w1-02-core-types`. It was **false** by the time it was read: this
branch was rebased onto `aw/w1-02b-deps`, whose whole purpose (W1-DEP-01, and
[its own record](W1-DEP-01-dependency-wiring-belongs-to-the-manifest-owner.md)) was to add the
dependency. The claim survived a round of repair, was repeated in two sibling records and in the
PR body, and was the stated justification for the decision below. It is withdrawn here and
everywhere it appeared, and the decision has been re-taken rather than re-worded.

What is actually true, measured on this branch:

```console
$ node -e "console.log(JSON.stringify(require('./apps/web/package.json').dependencies))"
{"@agent-workspace/core":"workspace:*","next":"16.3.4","react":"19.2.8","react-dom":"19.2.8"}

$ ls -l apps/web/node_modules/@agent-workspace/core
... core -> ../../../../packages/core
```

A declared dependency is not automatically a usable one, so the state of *that* was measured too —
twice, because the base moved underneath this record while it was being written and the first
measurement stopped being true. Both readings are kept, because the second is the interesting one.

**On base `3a49175`**, `packages/core`'s exports map sent every condition to `./dist`, a build
artefact that is git-ignored and absent from the tree. Neither the type-checker nor the runtime
could see the package:

```console
$ ls -d packages/core/dist
ls: cannot access 'packages/core/dist': No such file or directory
$ cd apps/web && node -e "…createRequire…resolve…"
@agent-workspace/core     -> MODULE_NOT_FOUND
@agent-workspace/core/db  -> MODULE_NOT_FOUND
$ node node_modules/typescript/bin/tsc -p <a probe inside apps/web>
probe.ts(1,28): error TS2307: Cannot find module '@agent-workspace/core/db' …
```

**On base `22ca2a2`** — W1-DEP-01's follow-up, *"make `@agent-workspace/core` actually resolve from
`apps/web`, with no manual build"*, which landed while this repair was in progress — the `types`
condition points at `./src`, and `apps/web`'s own `dev` and `build` scripts build the dependency
first. Re-measured, `dist` still absent:

```console
$ ls -d packages/core/dist
ls: cannot access 'packages/core/dist': No such file or directory
$ node node_modules/typescript/bin/tsc -p <the same probe inside apps/web>
TSC EXIT=0
$ cd apps/web && node -e "…createRequire…resolve…"
@agent-workspace/core     -> MODULE_NOT_FOUND
@agent-workspace/core/db  -> MODULE_NOT_FOUND
```

So the **type**-level import is now free, and the **runtime** import still is not: `default` still
resolves to `./dist`, which `pnpm --filter @agent-workspace/web dev` now builds first. `signIn`
would need the runtime one.

## Decision

**The session's tenant claim is the workspace *slug*, not the workspace id**, and a
`WorkspaceScope` is derived from verified session claims and from nothing else:

```ts
export class WorkspaceScope {
  readonly workspaceSlug: string;
  readonly actorEmail: string;
  readonly role: 'owner';
  readonly #tenantFromVerifiedSession: string;                // nominal, unnameable elsewhere,
  readonly #actorFromVerifiedSession: string;                 // and the guard's reference copy
  readonly #roleFromVerifiedSession: 'owner';
  private constructor(claims: VerifiedSessionClaims);         // ends with Object.freeze(this)
  static fromVerifiedSession(claims: VerifiedSessionClaims): WorkspaceScope;
  static isWorkspaceScope(value: unknown): value is WorkspaceScope;   // the runtime half
}
export function workspaceScopeFrom(claims: VerifiedSessionClaims): WorkspaceScope;
export async function requireWorkspaceScope(): Promise<WorkspaceScope>;  // from @/server/auth
```

`VerifiedSessionClaims` is likewise a class whose value is not exported from `session.ts`, so the
only expression in the program that constructs one sits below `crypto.subtle.verify` returning
true in `verifySessionToken`.

### Why the slug, now that the id is reachable

The old justification is gone, so here is the decision taken again from the facts as they now
stand. The choice is between two lookups, not between a lookup and none:

- **The id in the token.** `signIn` resolves `WORKSPACE_SLUG` to `workspaces.id` once per
  sign-in. Handlers get the foreign key every tenant-scoped table already carries and query with
  no further work.
- **The slug in the token** (what is built). Each handler that needs `workspace_id` resolves it,
  once per request, on the `workspaces_slug_key` unique index.

Three things decide it.

1. **Sign-in performs no I/O today, and that is load-bearing.** `signIn` reads `SESSION_SECRET`,
   `BOOTSTRAP_ADMIN`, `BOOTSTRAP_ADMIN_PASSWORD` and `WORKSPACE_SLUG` from the environment,
   compares two MACs and signs one — no socket, no file, no clock beyond `Date.now()`. See
   [the bootstrap-credential record](W1-CP-06-bootstrap-credential-is-a-deployment-value.md) for
   why the credential is not in the database in the first place (§27 has no column for it).
   Resolving the id makes the single door into the application depend on Postgres being up, and
   makes a database outage present to the operator as a failed sign-in — the same screen a wrong
   password produces. That is a worse failure mode than a slower handler.
2. **The runtime import still costs a build edge, though much less than it did an hour ago.** This
   was the second-strongest argument on base `3a49175` and W1-DEP-01's follow-up has largely
   answered it: `tsc` now resolves the package from `apps/web` with no `dist`. What survives is
   that `signIn` needs the *runtime* import, `default` still resolves to `./dist`, and
   `tests/auth.test.ts` spawns the `next` binary directly rather than through
   `pnpm --filter @agent-workspace/web dev` — so the suite would have to build `packages/core`
   itself before it could spawn a server whose auth path imports it. A modest, real cost, and it
   is named here at its true size rather than at the size it had when the sentence was first
   written.
3. **`workspaces.slug` is the schema's *stable* identifier, so this is not the rename trap it
   looks like.** Its own schema comment says so — *"URL-safe stable identifier"* — and the
   mutable human-facing label is a separate column, `workspaces.name`. Renaming a workspace in
   the UI changes `name` and does not touch the session. Changing a *slug* is a deliberate
   identity change that already breaks every URL under it; sessions are the smaller casualty and
   the operator doing it is not doing it by accident.

**The cost, stated plainly rather than waved past:** every handler that needs `workspace_id` pays
an index probe per request, and every such handler has to remember to do it. If W1-CP-04 or
W1-CP-05 finds that cost real, the migration is small and belongs to whoever owns the query layer:
add the id to `SessionClaims`, resolve it in `signIn`, and accept item 1 above as the price. This
record should be superseded rather than amended when that happens.

### The first version of this decision was wrong, and this is the correction

As opened, this PR shipped both types as structural interfaces and claimed the property above in
five places anyway. Verification round 1 refuted it in one line, which compiled under `--strict`:

```ts
workspaceScopeFrom({ sub: body.email, ws: body.workspace, role: 'owner', iat: 0, exp: 9e9 });
```

A phantom `unique symbol` brand was the first repair and it was not enough either: TypeScript
carries symbol-keyed properties across an object spread, so `{ ...verifiedClaims, ws: body.ws }`
still type-checked and still named the attacker's tenant. A `#private` field is not carried across
a spread and cannot be named from another module, which closes both shapes. The forgeries now live
in a fixture that `tests/auth.test.ts` compiles with `tsc`, asserting a diagnostic on each
forbidden line by line number and none on the legitimate derivation — the property is checked,
not described.

### The second version was wrong too, in the other direction

Verification round 2 refuted the repair above with a line the fixture had not thought of. The
fixture forbade *spreading* a real scope and overwriting its tenant; it said nothing about the
one-token sibling of that:

```ts
Object.assign(realScope, { workspaceSlug: body.workspace });
```

No cast, no `any`, no diagnostic under this repository's own `tsconfig.json` — and at runtime it
replaced a genuine scope's tenant with a value out of a request body while `isWorkspaceScope()`
went on answering `true`. `readonly` is a compile-time modifier and nothing more, and
`Object.assign` is typed `assign<T, U>(target: T, source: U): T & U`, which consults no `readonly`
modifier on `T`. It cannot be made a compile error.

So the property moved to where it can actually be enforced. **The constructor ends with
`Object.freeze(this)`**, which makes every own property non-writable and non-configurable and the
object non-extensible. `Object.assign`, `Object.defineProperty` and `Object.setPrototypeOf` raise
`TypeError` on it regardless of the caller's strict-mode setting; `scope.workspaceSlug = x` and
`delete scope.workspaceSlug` throw in strict mode — which is every module in this repository —
and in sloppy mode fail silently instead. Measured both ways; nothing writes the field under
either.

And **the guard now checks the
invariant rather than the shape**: `isWorkspaceScope` requires the private field, requires the
object to be frozen, and requires each public field to still equal the value the constructor took
from the verified session — so an object that has the brand but has been tampered with answers
`false` instead of `true`.

`tests/auth.test.ts` asserts this against the real object, one mutation route per test, and each
test asserts both halves: that the attempt throws *and* that the tenant afterwards is still the
one the session named. A `TypeError` raised after the write had landed would satisfy the first
alone.

One honest qualification, because ADR-0015 cuts both ways. With the freeze in place, the guard's
three *invariant* questions are defence in depth and **no test proves them**: nothing outside
`workspace.ts` can build a branded object whose fields disagree with its private copies, which is
precisely what the freeze buys. Measured rather than assumed, by running both mutations —
reverting `isWorkspaceScope` to the bare `#` check leaves the suite green, while removing
`Object.freeze(this)` turns every test in the runtime block red. (The counts are in the PR, not
here: a count in prose goes stale the next time a test is added — [ADR-0016](README.md).) The
extra questions stay because the freeze is one line a future edit can drop, and a guard that would
go on answering `true` after that is worse than one that would not.

The slug is the natural key `workspaces.slug` already carries, it is what `pnpm db:seed` keys on,
and it is what `WORKSPACE_SLUG` names in both halves.

The tenant is derived from the session and from nothing else: not a query parameter, not a path
segment, not a request body, not a header. All four are caller-controlled, and a scope taken from
any of them is not a scope — a compile error where the compiler can see it, and a `TypeError`
where it cannot.

The limits of the mechanism, stated rather than left to be discovered, because two rounds of
verification have now found one each:

- A deliberate `as WorkspaceScope` cast, or `Object.create(WorkspaceScope.prototype)`, still
  produces a value the compiler accepts, exactly as they do for every other type in this program.
  `isWorkspaceScope` rejects both at runtime; the compiler rejects neither.
- Minting a token with a secret the caller chose and verifying it with the same secret produces
  genuine `VerifiedSessionClaims` naming a tenant out of a request body, and compiles clean.
  Nothing here stops it; `mintSessionToken` and `verifySessionToken` are both exported because
  the sign-in route and the test suite need them.

Both now sit in the compile fixture on lines tagged `DECLARED`, asserted to produce **no**
diagnostic. That is deliberate: it makes each declared gap a checked fact rather than a sentence,
it fails the suite if one is closed and the declaration is left stale, and it means no future
reader has to take this paragraph's word for it. The claim is that request data cannot become a
tenant by accident or by the obvious shortcut, and it is no stronger than that.

Related, and part of the same decision: **the middleware adds no identity header.** It answers 401
and passes the request on unchanged. A handler that needs to know who is calling calls
`requireSession()` and verifies the cookie itself. One source of truth, and no `x-user` header that
becomes a forgery vector the moment something reaches the app without traversing the middleware.

## What is honestly not built

**Nothing mechanically prevents a route handler from querying without a scope.** The contract is a
type and a convention, and W1-CP-04's and W1-CP-05's handlers are free to ignore both.

A source-scanning gate — "every `route.ts` under `apps/web/app/api/**` imports `@/server/auth`" —
was written and then deleted, for two reasons. First, it would have judged only files this branch
does not contain, so on this branch it would pass because it had nothing to judge, which is the
exact shape [ADR-0015](README.md) forbids. Second, and worse, it would have landed as a failing
assertion in the integrator's build over code the integrator is explicitly told not to fix
(*"Do not fix other tasks' code; report conflicts instead"*), turning a real concern into a stalled
wave.

So it is declared instead of claimed. **The gate belongs to the first task that owns query code**
— W1-CP-04 or W1-CP-05 in this wave, or W2-CP-06 with the four-role model — and should assert both
directions against fixtures, so that it is proven by a scenario passing and a scenario failing
rather than by an empty inventory.

## Alternatives rejected

- **Put the workspace id in the session.** Reachable — `@agent-workspace/core` is a declared
  dependency of `apps/web` — and rejected on the three grounds in *Why the slug, now that the id
  is reachable* above, chiefly that it makes sign-in depend on Postgres. It is the right change to
  make the day a handler shows the per-request lookup is costing something, and it supersedes this
  record rather than amending it.
- **Carry both the slug and the id.** Two names for one tenant in a signed token, which have to be
  consistent and cannot be checked against each other without the lookup the id was supposed to
  remove. It buys nothing over the id alone.
- **Make `workspaceSlug` a getter over the private field instead of freezing.** Closes assignment
  and `Object.assign` (both throw on an accessor with no setter) and leaves
  `Object.defineProperty` open, and it makes the field non-enumerable, so `JSON.stringify(scope)`
  would stop producing the three fields a handler expects. `Object.freeze` closes more and changes
  nothing a caller can see.
- **Ship the source-scanning gate anyway.** Covered above: a vacuous pass here, a peer's broken
  build there.
- **A `ScopedDatabase` wrapper that makes an unscoped query impossible to write.** The right
  answer, and it is a design decision belonging to whoever owns the query layer — this task owns
  no query code to wrap.
