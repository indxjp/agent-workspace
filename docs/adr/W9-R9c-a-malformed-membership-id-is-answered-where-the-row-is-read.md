# W9-R9c — A malformed `:id` is answered where the row is read, not at the top of the handler

Status: accepted
Date: 2026-09-14
Decided by: W9-R9c (implementing agent), issue #203
Scope: `apps/web/server/rbac/handlers.ts`; `apps/web/server/rbac/routes.test.ts`;
`apps/web/server/rbac/memberships-isuuid-guard.test.ts`; `apps/web/server/rbac/conferral.test.ts`;
`apps/web/server/rbac/api-keys.test.ts`

## Context

`PATCH /api/memberships/:id` and `DELETE /api/memberships/:id` checked only that the path segment
was a non-blank string (`apps/web/server/rbac/handlers.ts`, the `typeof id !== 'string' ||
id.trim() === ''` arms) before handing it to `directory.changeMembershipRole` /
`directory.deleteMembership`. Those reach `eq(memberships.id, id)` in
`packages/core/src/db/repositories/directory.ts`, and `memberships.id` is `primaryKeyId()` —
`uuid('id').primaryKey().defaultRandom()`. PostgreSQL answers a non-UUID literal with
`22P02 invalid input syntax for type uuid`.

Nothing catches it. `apps/web/server/rbac/decide.ts` classifies `/api/memberships/<anything>` as
the row shape and §21 gives Owner and Admin `any` over `memberships`, so the request is allowed;
`authorise` in `apps/web/server/rbac/http.ts` calls the handler on the `allow` branch with no
`try`/`catch`. The rejection left the handler, so `/api/memberships/not-a-uuid` answered an
unhandled error where `/api/memberships/<unknown-uuid>` answers `404 no_such_membership`.

`DELETE /api/api-keys/:id` crosses the identical property, and an owner decision extended this
repair to it: `apps/web/app/api/api-keys/[id]/route.ts:27` → `revokeApiKey` in `handlers.ts`
(non-blank check only) → `eq(apiKeys.id, id)` at
`packages/core/src/db/repositories/directory.ts:469,480` → `packages/core/src/db/schema/api-keys.ts`
`id: primaryKeyId()` = `uuid('id')`. Reachable by Owner and Admin, with no `try`/`catch` above it.

This is the PRJ-06 root cause at a third site; the Wave 9 review record (added by PR #199, not yet
on `main`) records it as claim SWT-12 / repair block R-3. `apps/web/server/workspaces/access.ts` already fixed the same defect for
`/api/workspaces/:id` and states the repository's standing decision that each resource module
declares its own private `isUuid`.

## Decision

Declare a private `UUID` regex and `isUuid` in `apps/web/server/rbac/handlers.ts` and call it
**immediately before the directory read** in `changeMembershipRole`, `deleteMembership` and
`revokeApiKey`, returning a shared `membershipNotFound(id)` / `apiKeyNotFound(id)` — the same
`404 no_such_membership` / `404 no_such_api_key` those handlers already produce for an unknown
UUID. `apiKeyNotFound` is extracted from the existing `no-such-key` arm for the reason
`membershipNotFound` is extracted from the two `no-such-membership` arms: one construction, so the
guard cannot drift away from the directory's own answer. No new code and no new message was
invented. Four decisions sit inside that.

**1. Position: at the read, not at the top of the handler.** The acceptance criterion is that a
non-UUID id gets the *field-by-field identical* response an absent UUID gets, and only the late
position delivers it. `changeMembershipRole` validates the body and the role conferral before it
reads the row, so an absent UUID with a non-object body answers `400 malformed_body` and an absent
UUID with an unconferrable role answers `403 forbidden_role_conferral`. A guard at the top of the
handler would answer `404` to those same two requests — a *different* response from the one the
absent UUID gets, failing the very criterion it was added for. The guard is not input validation
rejecting a bad field; it is the answer that stands in for a row read that finds nothing, so it
belongs where the read is. (`access.ts` places its guard first only because nothing precedes the
read there.) Two cases in `routes.test.ts` hold that position: move the guard up and they fail.

`revokeApiKey` has only the missing/blank check before its read, so "at the read" places its guard
immediately after that check — the same first position it applies in that `deleteMembership` uses.

**2. The detail keeps echoing the id.** `membershipNotFound(id)` is used by the guard and by both
existing `no-such-membership` arms, so there is one response shape rather than three copies of the
sentence — and `jscpd`, part of `check:fast`, sees one. The rejected alternative was a constant
detail with no id, in the shape of `workspaceNotFound()`. It would make the two bodies
byte-identical rather than identical-modulo-the-id, but it changes the existing `404` body for
every caller who sends a well-formed unknown UUID, which this repair is not entitled to do.
Echoing leaks nothing: the detail names the id the caller itself sent, exactly as it does today for
two different absent UUIDs, into an `application/json`, `no-store` body with no HTML sink.

**3. The missing/blank `400 invalid_field` stays.** It answers a different fact — the route wiring
handed the handler no id at all, which Next.js cannot produce for a matched route — and folding it
into the `404` would broaden the diff past the issue's boundary.

**4. The regression is a new `TEST_DATABASE_URL`-gated file, and `routes.test.ts` is a contract
pin.** `routes.test.ts` drives the real route modules, but through `installRbacHarness` →
`createMemoryDirectory`, whose membership lookups are `Map.get` over a string key: it answers
`no-such-membership` for `'not-a-uuid'` with or without the guard, so a case added there is green
before the fix and proves nothing about the defect. `memberships-isuuid-guard.test.ts` therefore
drives the two handlers against `createPostgresDirectory` over an isolated PostgreSQL 17 — the
shape of `apps/web/server/workspaces/isuuid-guard.test.ts` and of this directory's own
`postgres-directory.test.ts`. Both files are kept: the gated one fails for the old behaviour, the
harness one pins the contract (and the guard's position) through the wiring that ships.

Review added a third layer in `routes.test.ts`, because the two above left the guard *deletable*
with no local signal: a gated regression says nothing when `TEST_DATABASE_URL` is unset, and a
harness case is green either way. It is a `WorkspaceDirectory` double wrapping the same
`createMemoryDirectory`, with the one fact that fixture cannot model — `memberships.id` and
`api_keys.id` are `uuid` columns, so a non-UUID literal is a driver rejection and not a missing row
— put back on `changeMembershipRole`/`deleteMembership`/`revokeApiKey`, driven through the three
handlers directly. Deleting any one guard fails a case by an unhandled rejection, in `test:unit`,
with no database. The double's fixture takes `newId: crypto.randomUUID` for the same reason the 204
case does: the default counter id is not a UUID, so without it the double would refuse the rows it
seeded. Each verb also has a sanity case revoking or removing a *seeded* row, so a double that
refused everything could not pass for the wrong reason.

The api-keys verb carries the same two layers and no gated file of its own. Its database-free case
is the regression (`DELETE /api/api-keys/:id answers a non-UUID id without calling the directory`);
its harness case is the contract pin through `apps/web/app/api/api-keys/[id]/route.ts`. Extending
`memberships-isuuid-guard.test.ts` to a third verb was rejected as broader than the owner decision
asked for: that file already proves the driver's `22P02` behaviour over a real column, and
`api_keys.id` is the same `primaryKeyId()` type as `memberships.id`, so a third gated case would
re-prove PostgreSQL rather than this repair. What is *not* covered is therefore stated plainly: no
test in this PR drives `revokeApiKey` against a real PostgreSQL column.

### Collateral: the in-memory fixture minted ids the `uuid` column could not hold

`createMemoryDirectory`'s default `newId` is a counter (`id-2`, `id-4`, `id-8`), so three existing
tests `PATCH`ed, `DELETE`d or revoked a row by an id the guard now correctly refuses:
`conferral.test.ts`'s `twoMembers()`, `routes.test.ts`'s 204 case, and `api-keys.test.ts`'s
`harnessWithOwner()`. All three now pass
`newId: crypto.randomUUID` to `installRbacHarness`, which `apps/web/server/invitations/routes.test.ts`
already does for the same reason. `api-keys.test.ts` is outside the file list the owner decision
named; it is edited because the new guard would otherwise leave an existing test red, and neither
deleting nor skipping it is permitted. The fixture's documented default — stable, assertable ids — is
left alone; changing it would alter a fixture shared by suites this issue does not own.

## Alternatives considered

- **Guard in the route files (`app/api/memberships/[id]/route.ts`, `app/api/api-keys/[id]/route.ts`).**
  The route files are documented as thin
  wiring, the tests drive the handlers directly, and a route-level guard would have to duplicate the
  not-found body outside the module that owns it. Both route files are in this issue's `Owns globs`
  and need no edit.
- **Import `isUuid` from another server module.** `apps/web/server/projects/http.ts`'s copy is
  private and cross-domain; `access.ts` records the standing decision that each resource module
  declares this predicate for itself. Roughly eight modules already do.
- **Teach `installRbacHarness` to accept an injected `DirectoryRoot`** so `routes.test.ts` could
  drive the real routes over real PostgreSQL. One end-to-end failing test, at the price of editing a
  harness shared by several suites — a much larger blast radius than the defect.
- **Change `createMemoryDirectory`'s default `newId` to `crypto.randomUUID()`.** It would stop this
  class of fixture mismatch at the source, but it changes a shared fixture's documented behaviour
  for every suite that uses it, for a problem three call sites can fix locally.

## Consequences

A non-UUID `:id` on any of the three verbs moves from an unhandled error to the `404` that verb
already gives an unknown UUID — `no_such_membership`, or `no_such_api_key` for the key. No client
can depend on the old answer, and the UI sends ids it read from `GET /api/memberships` and
`GET /api/api-keys`. No route file, RBAC decision table, response shape, schema or migration
changes. Rollback is a revert; nothing persists and nothing migrates.

The one shape risk is `membershipNotFound`/`apiKeyNotFound` touching the three existing `404` arms:
each must produce the same body as before. `routes.test.ts`'s absent-UUID controls are what hold
that, and each is asserted positively (`404`, and the code) before equality, so two matching `500`s
cannot pass it.

### The ADR-0048 enumeration, re-run for the three-verb repair

Per [ADR-0048](0048-a-repair-is-applied-at-every-site-the-root-cause-reaches-and-the-sites-are-enumerated-from-the-code.md),
a repair enumerates its sites from the code and says what it left. The owner decision that added
the api-keys verb also fixed the frame this enumeration is run over, so it is re-run rather than
amended.

**The frame, stated before the result.** Two sets, and nothing else:

- **(A)** every `[id]` route handler exported from `apps/web/server/rbac/handlers.ts` — the
  functions that take an `id` parameter, found by reading every `export async function` in the file;
- **(B)** every route under `apps/web/app/api/**/[id]/` that reaches a `uuid` column *through*
  `apps/web/server/rbac/handlers.ts` — found by taking the 25 `route.ts` files matching that glob
  and keeping those that import from `server/rbac/handlers`.

(A) is `changeMembershipRole`, `deleteMembership`, `revokeApiKey`; the file's six other exports
(`listUsers`, `createUser`, `listMemberships`, `createMembership`, `listApiKeys`, `createApiKey`)
take no `id`. (B) is two files — `memberships/[id]/route.ts` and `api-keys/[id]/route.ts`; the other
`[id]` routes import from `server/{agents,projects,files,connectors,models,secrets,runtimes,
invitations,skills,workspaces}/handlers`, not from `rbac/handlers`. The two sets meet in the same
three verbs:

| Verb | Route file | Column | Status |
| --- | --- | --- | --- |
| `PATCH /api/memberships/:id` | `app/api/memberships/[id]/route.ts` | `memberships.id` | **repaired here** |
| `DELETE /api/memberships/:id` | `app/api/memberships/[id]/route.ts` | `memberships.id` | **repaired here** |
| `DELETE /api/api-keys/:id` | `app/api/api-keys/[id]/route.ts` | `api_keys.id` | **repaired here** |

Nothing in the frame is *already-guarded* and nothing in the frame is *not-repaired*: all three are
repaired in this PR. `GET /api/api-keys/:id` does not appear because it does not exist — the route
file records that it is deliberately absent.

**The claim is exactly that, and no wider.** Within sets (A) and (B) as defined above, read from
the working tree on 2026-09-14 at `d2a1db8`, the repair is complete. No claim is made about sites
outside that frame; a tree-wide enumeration was not performed, and asserting one here is the
failure mode ADR-0048 names.

#### Outside the frame: sites this repair does not reach

Recorded, not repaired, and not claimed to be a complete list of what lies outside the frame. These
were found by the earlier reading and are carried forward so they are not lost:

1. `GET /api/projects/:id` and `PATCH /api/projects/:id` —
   `apps/web/app/api/projects/[id]/route.ts`. Both `await params` and pass `id` straight to
   `projects.get(id)`. Reaches a `uuid` column through `server/projects`, not `rbac/handlers`.
2. `POST /api/projects/:id/sessions` — `apps/web/app/api/projects/[id]/sessions/route.ts`. Same
   shape: `projects.get(id)` on the raw segment.

`GET`/`PATCH /api/workspaces/:id` is the precedent rather than a gap: `apps/web/server/workspaces/
access.ts` already guards it. Closing the class across the tree (#188) still needs its own issue.
