# W1-CP-06 — The auth modules import nothing from each other, and declare their own module format

Status: accepted
Date: 2026-09-03
Decided by: W1-CP-06 (Control Plane)
Scope: `apps/web/server/auth/*.ts`, `apps/web/server/auth/package.json`

## Context

`tests/auth.test.ts` is the file this task's acceptance criterion is verified in, and it lives in
`tests/`, which is a Vitest project and is included by `tsconfig.root.json`. For it to test the
gate, it must import the gate's modules from `apps/web/server/auth/`. Two facts, both established
by running the toolchain rather than by reading documentation, make that harder than it sounds.

**Fact 1 — Turbopack does not resolve `./x.js` to `x.ts`.** Next.js 16.3.4 with Turbopack, on this
tree, on 2026-09-03:

```text
⨯ ./apps/web/middleware.ts:41:1
Error: Module not found: Can't resolve './server/auth/origin.js'
```

Extensionless specifiers resolve; the `.js`-for-`.ts` alias that webpack-based Next.js applies does
not. So inside `apps/web`, relative imports must be written without an extension.

**Fact 2 — the root TypeScript program requires the opposite, and rejects these files outright.**
`tsconfig.json` sets `module: NodeNext` and `verbatimModuleSyntax: true`. Under NodeNext a file's
module format comes from the nearest `package.json`, and `apps/web/package.json` declares no
`type`, which makes every file below it CommonJS. The result, before any of this was changed:

```text
apps/web/server/auth/paths.ts(109,1): error TS1287: A top-level 'export' modifier cannot be used
  on value declarations in a CommonJS module when 'verbatimModuleSyntax' is enabled.
```

— for every exported symbol in every file, whether or not it imports anything. And had the files
been made ES modules while keeping extensionless imports, NodeNext would have rejected those
instead (TS2835, "relative import paths need explicit file extensions").

The three obvious fixes are all outside this task's `Owns` globs: `apps/web/package.json`
(add `"type": "module"`), `tsconfig.root.json` (exclude `tests/`), `tests/tsconfig.json` (switch to
`moduleResolution: bundler`). Editing any of them fails the ownership gate.

## Decision

Two changes, both inside `apps/web/server/auth/`, which this task does own.

1. **`apps/web/server/auth/package.json` declares `{"type": "module"}`.** The nearest `package.json`
   is what NodeNext reads, so these files are ES modules for TypeScript. It matches no glob in
   `pnpm-workspace.yaml` (`apps/*`, `packages/*`), so pnpm does not install, build or licence-check
   it, and nothing resolves to it by name. Turbopack compiles the files identically either way.
2. **No module in the directory imports another**, with one exception. `paths.ts`, `origin.ts`,
   `session.ts` and `workspace.ts` have zero relative imports, so the extension question never
   arises for them and both toolchains read the same bytes. The exception is `index.ts`, which is
   the composition root, imports its siblings extensionlessly, and imports `next/headers` — so it
   is loaded only by Next.js and is type-checked only by `apps/web/tsconfig.json`, where
   `moduleResolution: bundler` accepts extensionless specifiers. `middleware.ts` is in the same
   position.

The visible consequences of rule 2:

- The bootstrap-administrator credential check and `signIn` live in `session.ts` rather than in a
  `bootstrap.ts`, because they need `mintSessionToken` and `readSessionSecret`. The file is longer
  than it would otherwise be and its subject is coherent: *the session — how one is minted,
  verified, carried, and who is allowed to have one*.
- `workspace.ts` used to describe the claims it consumes structurally, in a local interface
  called `WorkspaceScopeSource`, instead of importing the type from `session.ts`. That was the
  cause of the multi-tenancy defect verification round 1 found: a structural parameter type
  accepts a request body, so `workspaceScopeFrom({ sub: body.email, ws: body.workspace, … })`
  compiled. It now imports `VerifiedSessionClaims` from `session.ts` with an `import type`, which
  rule 2 does **not** forbid: rule 2 is about *runtime* imports, and `import type` is erased in
  full by both TypeScript and SWC before any resolver — Turbopack's included — sees a specifier.
  The live-server test compiles the whole graph through Turbopack and would fail if that were
  untrue. A type-only edge is the narrowest thing that carries a provenance guarantee between two
  files, and it costs nothing at runtime.

## Alternatives rejected

- **Add `"type": "module"` to `apps/web/package.json`.** The clean fix, outside `Owns`, and a
  change to how every file in the app is interpreted — made by the task least entitled to make it.
- **Escalate.** The blocker is real but it is a five-line workaround inside this task's own
  directory, not a design question for the Owner.
- **Dynamic `import()` with a computed specifier in the test**, so `tsc` never sees the files. Buys
  a green typecheck by making the test untyped, which is the same trade as a suppression.
- **Test the pure logic from inside `apps/web` instead.** `tests/auth.test.ts` is the file this
  task's `Owns` names; a test under `apps/web/server/auth/` would also work, but the acceptance
  evidence would then live in two places.

## Honest downside

**A `package.json` in a source directory is surprising.** Someone will read it as a package. Its
`"//"` field says in full why it is there, and this record is cited from the file itself, from
`workspace.ts`, from `index.ts` and from `session.ts` — but the mitigation is documentation, not
structure, and documentation is the weaker kind.

**Rule 2 is a convention that nothing enforces.** A future edit adding `import { x } from './y'` to
`session.ts` breaks the root typecheck — loudly, in CI, with TS2835 — so the failure is immediate
and legible rather than silent. That is the only guard, and it is enough only because the failure
mode is a build error.

Both of these evaporate the moment `apps/web/package.json` can be edited: delete the nested
`package.json`, add `"type": "module"` one level up, and rule 2 becomes optional.

## Amendment — the auth modules may import a pure core with an explicit `.ts` path (refactoring part 06, 2026-11-09)

The section above ends with the condition under which rule 2 becomes optional: `"type": "module"`
in `apps/web/package.json`. That is now the case, and both facts that shaped the decision were
re-checked on main `e1d2613fe`:

- **Fact 2 no longer holds as written.** `apps/web/package.json` declares `"type": "module"`, so
  the files below it are ES modules for NodeNext without the nested `package.json`. The root
  program also sets `rewriteRelativeImportExtensions` (`tsconfig.root.json`), which accepts a
  relative `.ts` specifier.
- **Fact 1 still holds for `./x.js`, but not for `./x.ts`.** Turbopack resolves an explicit `.ts`
  specifier, and `apps/web` already ships modules that use one (`cli-auth/local-credential.ts`,
  `rbac/cli-token.ts`, `start.ts`).

So one specifier now reads the same to both toolchains: an explicit `.ts` path.

**The rule from here.** A module in `apps/web/server/auth/` may import a pure module under
`apps/web/server/auth/core/` with an explicit `.ts` path (`./core/session-rules.ts`). Runtime
imports between the other auth modules stay as rule 2 says: the shared logic goes into `core/`,
where `domain-core-is-pure` and the core globals ban hold it to no I/O, no clock and no `crypto`.
Signing and verifying stay in `session.ts`, which owns the key.

**How it is proven.** `tests/auth.test.ts` starts `next dev` and compiles the whole auth graph
through Turbopack, including the new import; `npx tsc -p tsconfig.root.json` type-checks the same
files under NodeNext; and `session-golden.test.ts` pins the token bytes, the claims, every refusal
and the cookie attributes, written before the rules moved and unchanged after.

The nested `apps/web/server/auth/package.json` is now redundant for TypeScript. It stays only
because the Dockerfile copies it; removing both is a separate change.

## Amendment — the auth modules may import the clock port with an explicit `.ts` path (refactoring part 06, step 8, 2026-11-12)

The clock ratchet (`scripts/check-clock-ceiling.mjs`) counts a `Date.now()` default argument as a
direct clock read. `session.ts`, `selection.ts`, `invitation-identity.ts` and `oidc.ts` each took
the time as an optional `nowMs` argument that defaulted to `Date.now()` (8 reads), and the rule
above let them import only `core/`.

**The rule from here.** These modules may also import `apps/web/server/clock.ts`, with the same
explicit path form (`../clock.ts`), and default `nowMs` to `systemClock.now().getTime()`. The clock
port imports nothing and does no I/O, so the edge bundle that `proxy.ts` builds from `session.ts`
gains one frozen object and nothing else. The time stays an argument: every caller and test that
passes `nowMs` today is unchanged.

**Rejected:** making `nowMs` required. It removes the default but moves the clock read into about
100 call sites, most of them tests, for no change in behaviour.

**How it is proven.** `tests/auth.test.ts` compiles the auth graph through Turbopack with the new
import; `npx tsc -p tsconfig.root.json` type-checks it under NodeNext; and
`apps/web/server/auth/clock-defaults.test.ts` (with one case in `oidc.test.ts`) pins that an
omitted `nowMs` is the current time for every one of the 8 functions. It passes on the code before
and after this change, and it fails when any one default is moved.
