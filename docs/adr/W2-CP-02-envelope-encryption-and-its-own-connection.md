# W2-CP-02 — Envelope encryption, a self-contained secrets subsystem, and one export line outside this task's `Owns:` globs

Status: accepted
Date: 2026-09-05
Decided by: W2-CP-02 (implementer)
Scope: `packages/core/src/secrets/**`, `apps/web/server/secrets/**`, `apps/web/app/api/secrets/**`,
and one line of `packages/core/package.json`

## Context

Spec §23 says the default implementation "may encrypt values in PostgreSQL using a
deployment-level master key," and the design notes name envelope encryption — a per-secret data
key wrapped by the deployment master key, not the master key used directly on plaintext — over
`node:crypto`'s AES-256-GCM.

Sub-wave 2a (W2-DB-01, W2-DB-02) already shipped the `secrets` table
(`packages/core/src/db/schema/secrets.ts`) and the repository layer's shape
(`packages/core/src/db/repositories/**`), with `packages/core/src/db/index.ts` deliberately
re-exporting nothing but `openDatabaseRoot()` and its scope-bound providers — closing two
cross-tenant bypasses a wider barrel caused in verification. This task's brief says plainly: do
not widen that barrel, and it is not in this task's `Owns:` globs regardless.

`DatabaseRoot` (returned by `openDatabaseRoot()`) has no `secrets` field, and adding one would mean
editing `root.ts`, `repositories/index.ts` and `db/index.ts` — three files this task does not own
and was told not to touch. Getting from "a table exists" to "a route can read and write it" without
touching any of them is the problem this ADR records the answer to.

## Decision 1 — the secrets subsystem is its own composition root, not a client of `openDatabaseRoot()`

`packages/core/src/secrets/**` reaches PostgreSQL through its own `pg.Pool`, opened by
`service.ts`'s `createSecretsService(env)` — symmetrical with `openDatabaseRoot()` rather than
downstream of it. Internally it reaches `../db/client.ts`, `../db/schema/secrets.ts` and
`../db/repositories/scope.ts` (for `WorkspaceScope` and `requireWorkspaceScope`) by **relative
path**, which does not go through `@agent-workspace/core/db`'s barrel at all.

This is not a workaround of the reachability gate; it is the edge that gate's own `decide()`
classifier names as `permitted`: _"a path into the layer's source from inside the package that
owns it."_ `packages/core/src/secrets/**` is inside `packages/core/`, the package that owns the
database layer, so the edge is legitimate by the gate's own rule, not merely unexamined by it.
`packages/core/src/db/repositories/database-reachability.test.ts` (not owned by this task) is
expected to pass this edge unchanged; this task adds no exception to it.

**Consequence, stated so it reads as a decision rather than an oversight:** in every deployment
this subsystem's pool and `openDatabaseRoot()`'s pool are two separate connections to the same
PostgreSQL server. `WorkspaceScope` values are interchangeable between the two regardless — the
class is a value object identified by its private fields and `Object.freeze`, not by which pool
minted it, and both call sites import the identical module (`db/repositories/scope.ts`) — so a
scope obtained through `openDatabaseRoot().scopes` is accepted by this subsystem's repository
without any adapter. A future task that wants one pool for both is free to make that change from
the side that owns `root.ts`; this task does not, because that file is not its `Owns:` glob.

### Alternatives considered

- **Widen `DatabaseRoot` with a `secrets` field.** Rejected: requires editing `root.ts`,
  `repositories/index.ts` and `db/index.ts`, none of which are in this task's `Owns:` globs, and
  the task brief explicitly forbids widening the barrel.
- **Route every secrets query through `@agent-workspace/core/db/unscoped`.** Rejected outright:
  that subpath refuses to load outside a test process by design (`unscoped.ts`'s
  `assertTestProcess`), so a production route importing it would crash at import in every
  deployment.

## Decision 2 — the master key is `MASTER_ENCRYPTION_KEY`, hex-encoded, checked before anything else

`.env.example` (not in this task's `Owns:` globs, read rather than edited) already names the
variable and its format: _"Spec §23's key for encrypting stored secrets at rest … Generate with:
`openssl rand -hex 32`."_ `master-key.ts`'s `loadMasterKey` matches that contract exactly — 64
hex characters, decoding to 32 bytes — rather than inventing a second format, and it is the first
thing `createSecretsService` calls, before a pool is even opened. A deployment with no key, or a
malformed one, fails at construction; there is no code path that stores a value unencrypted.
`master-key.test.ts` and `service.test.ts` assert this as a positive requirement (ADR-0015): the
function must throw, not merely "not obviously succeed."

`.env.example`'s comment that `MASTER_ENCRYPTION_KEY` is "NOT READ BY ANY CODE IN THIS REPOSITORY
YET" is now false. Updating it is outside this task's `Owns:` globs; it is declared as a gap on
this task's PR instead of edited.

## Decision 3 — write-only means the type cannot hold a value, not that a route happens not to return one

`SecretMetadata` (core) and `SecretRecord` (`apps/web/server/secrets/store.ts`) have no field an
envelope's ciphertext, nonces, tags or wrapped data key could occupy. `list`, `create` and
`replace` — the only methods on the port a route handler holds
(`WorkspaceSecretsStore`) — cannot produce a value because their return types do not have room
for one, the same shape choice `packages/core/src/db/schema/secrets.ts`'s CHECK constraints make
about the table.

Decryption lives in a separate module, `packages/core/src/secrets/resolve.ts`. `SecretsService`
(core) does carry a `resolveByName` method, on the same object as `list`/`create`/`replace` — see
`service.ts`'s header for why a second composition root purely to hide one method would be
security theatre — but the **port** `apps/web/server/secrets/store.ts` hands to route handlers,
`WorkspaceSecretsStore`, simply does not declare it.

**Revised in verification round 2 (F1, F2).** The first version of this decision said
`resolve-isolation.test.ts` "fails by name if `resolveByName` appears anywhere" outside two files —
a text match. The verifier planted a route that built the identifier at run time
(`['resolve','By','Name'].join('')`) and imported `createSecretsService` directly through the
`./secrets` subpath this task added, and got a real decrypted value over HTTP while that test and
the leak scan both stayed green. ADR-0030 names the rule this broke: an import edge is resolved by
the compiler, not matched by regex. `resolve-isolation.test.ts` was rewritten to resolve every
specifier in `apps/web/app/api/secrets/**` and `apps/web/server/secrets/**` with
`ts.resolveModuleName` and fail on any **value** edge into the secrets package outside an explicit
allow-list (`memory-store.ts`, test files); a `type`-only edge — the only kind `store.ts` itself
carries — is erased before anything runs and calls nothing.

**Revised again in verification round 3 (B1, B2).** Round 2's fix was still only a **one-hop**
check: it inspected each file's own direct edges, so a route importing `createSecretsService`
_re-exported_ from the allow-listed `memory-store.ts` obtained a live, decrypting `SecretsService`
with that gate, `tsc` and `eslint` all green. This is not an adversarial edge case — re-exporting a
factory from an existing module is an ordinary refactor — and the property is a tenant-isolation
boundary, so the fix is to close the class rather than declare the gap: the gate now walks the
resolved import graph **transitively** from every route and server file, following each value edge
(through `memory-store.ts`, through a test file, or through any file outside the two directories
that itself imports the package) until it either reaches the secrets package or the chain leaves
the set of files worth following (a third-party package under `node_modules`). The same round also
found an aliased `createRequire` — `const req = createRequire(import.meta.url); req(specifier)` —
that the reader neither followed nor refused, the ADR-0015 shape of a classifier that decides
nothing; the reader now recognises a `require`-shaped binding the same way it recognises `require`
itself, and refuses (rather than skips) a call through one whose argument is not a string literal,
matching the treatment dynamic `import()` already had.

What the round-3 gate still could not decide, stated per ADR-0031 rather than implied away: a
property access on a value some _other_ file already holds (`store.ts`'s
`RepositorySecretsStoreDependencies.service` parameter is typed `CoreSecretsService`, and nothing
stops a future edit of `store.ts` from calling `.resolveByName()` on it directly); an alias of
`require` the reader does not know the shape of (a destructured or property-read alias, as opposed
to `const x = require` or `const x = createRequire(...)`); and it still does not read files outside
`apps/web/app/api/secrets/**` / `apps/web/server/secrets/**` _as roots_ — a sibling task's own
route, reachable only from outside those two directories, is `no-plaintext-leak.test.ts`'s
narrower, declared blind spot, not this one's.

**Revised a third time in verification round 4 (B1).** The paragraph above, in round 3's version of
this decision, also claimed the gate's chain-following limit was "a third-party package's own
internals rather than through the pnpm workspace symlink for `@agent-workspace/core` itself, which
`ts.resolveModuleName` already resolves to the real `packages/core/**` path" — stated as settled,
and false. `insideSecretsPackage` compared `path.relative(REPO_ROOT, resolvedFileName)` against the
package's roots as plain strings, and `ts.resolveModuleName` does **not** collapse the pnpm
workspace symlink for a specifier spelled as a relative path _through_
`apps/web/node_modules/@agent-workspace/core` rather than through the package's own name — only
`realpathSync` does. A route importing `createSecretsService` that way (`../../../node_modules/
@agent-workspace/core/src/secrets/index.js`, and the `dist` spelling identically) obtained a live,
decrypting `SecretsService`, with the round-3 gate, `tsc`, `eslint` and `prettier` all clean; the
chain was silently dropped rather than refused, because `isExternal`'s `node_modules` match fired
on the _un_-realpathed path before anything asked whether the real file underneath it was the
package. A repo-relative prefix test over a path the compiler did not normalise is ADR-0030's
mistake — comparing specifier text instead of resolving it — one layer down, at the filesystem
rather than the specifier. Every path the gate compares — every resolved edge, and the package's
own roots — is now put through `realpathSync` first, matching
`database-reachability.test.ts`'s own approach, and a path that cannot be realpathed at all is a
hard failure naming it rather than a silent non-match.

## Decision 4 — one line of `packages/core/package.json`, declared as an addition outside this task's `Owns:` globs

`apps/web` already depends on `@agent-workspace/core` (`workspace:*`, added in Wave 1), so no
dependency or lockfile change is needed — only a new `exports` subpath, `./secrets`, shaped
identically to the existing `./db` entry, so `apps/web/server/secrets/**` can reach
`packages/core/src/secrets/**` the same way `apps/web/server/agents/store.ts` already reaches
`@agent-workspace/core/db`.

This is a file outside this task's declared `Owns:` globs. It is declared here, with its reason,
under the precedent [ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md) sets for
exactly this situation — W1-DB-01 needed `pnpm-workspace.yaml` for a reason its task card could not
have foreseen, and the fix was to declare the file with its reason rather than route around a
genuine structural need. The alternative — building `packages/core/src/secrets/**` with no way for
`apps/web` to import it — would leave this task's own routes unable to compile, which is a worse
failure than a one-line, structurally-necessary addition to a manifest.

The diff is exactly one new object added to `exports`, at the same nesting depth and shape as
`./db/unscoped`; nothing else in the file changes. A sibling Wave 2 track (W2-CP-03, `storage`) is
expected to need the same kind of addition (`./storage`) for the same reason, and the two additions
are to different keys of the same JSON object — a textually disjoint change even though the file
is shared, which is the situation the orchestrator resolves at the integration level per this
task's protocol. This is flagged explicitly in this task's PR body rather than left for someone to
discover in the diff.

## Declared gaps this decision does not resolve

- **`apps/web/instrumentation.ts` wiring is not part of this task.** That file is a composition
  root outside this task's `Owns:` globs, and every Wave 2 resource track needs the same kind of
  wiring done there. Until it is wired, every `/api/secrets/**` route answers
  `503 secrets_runtime_not_configured` in a real deployment — the correct, honest answer for a
  capability that exists in code and is not yet installed, mirroring exactly how the agent API
  read before W1-COMP-01 wired it.
- **No `DELETE /api/secrets/:id`.** The task's acceptance criteria name create, replace and list;
  a delete route was not built, to keep this task's route surface to exactly what was asked for.
- **`.env.example`'s stale comment**, as above.
