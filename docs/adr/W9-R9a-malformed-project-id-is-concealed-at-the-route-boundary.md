# W9-R9a — A malformed project id is concealed at the route boundary, not classified at the driver

Status: accepted
Date: 2026-09-14
Decided by: W9-R9a (implementing agent)
Scope: `POST /api/projects/:id/archive` and `/restore`; the `isUuid` predicate in
`apps/web/server/projects/http.ts`; the enumeration of the other project routes the same root cause
reaches

## Context

Issue #200 is a Wave 9 resumption repair, filed from step 9's review record
(the Wave 9 review record, finding PRJ-06 / R-1). At `63273d5` the two routes #183 landed answer a
non-UUID `:id` with `500 internal_error`, where a well-formed UUID naming nothing answers
`404 project_not_found`:

```
POST /api/projects/<random UUID naming nothing>/archive → 404 {"error":{"code":"project_not_found",…}}
POST /api/projects/not-a-uuid/archive                    → 500 {"error":{"code":"internal_error",…}}
POST /api/projects/not-a-uuid/restore                    → 500 {"error":{"code":"internal_error",…}}
```

The path is short. `apps/web/app/api/projects/[id]/archive/route.ts` and `…/restore/route.ts` hand
the raw path segment to the one shared handler `transitionProject`
(`apps/web/server/projects/lifecycle.ts`), whose first database touch is `projects.get(id)`.
`projects.id` is a `uuid` column, so PostgreSQL raises `22P02 invalid input syntax for type uuid`;
the handler's `catch` gives it to `errorResponse`, which classifies an unclassified persistence
failure as `500`.

Two facts decide the disposition:

- **This is a contract defect, not a disclosure one.** The response body carries no SQL, no column
  name and no driver text — `errorResponse`'s infrastructure branch emits a fixed public message.
  What leaks is the *distinction*: `lifecycle.ts`'s header states, and
  `lifecycle.test.ts` already asserts field by field, that `projectNotFound()` is **the one
  response** a caller receives for an id that names nothing at all. A malformed id names nothing,
  so answering it differently breaks that equality.
- **The guard already exists, three times over, and once in this very module.**
  `apps/web/server/workspaces/access.ts` applies the identical `isUuid(id)` one level up, with a
  real-PostgreSQL proof that it is load-bearing (`apps/web/server/workspaces/isuuid-guard.test.ts`).
  `apps/web/server/projects/http.ts` already declares `UUID_RE` + `isUuid` and already applies it —
  to this module's **body** field `defaultModelConnectionId` (issue #153), with a comment naming the
  exact failure being avoided. The **path** field was never given the same treatment.

## Decision

**1. The guard is `isUuid(id)` at the route boundary, in the shared handler.**
`isUuid` is exported from `apps/web/server/projects/http.ts` (it was module-private) and
`transitionProject` refuses a malformed segment with the same `projectNotFound()` it already returns
for `null`. Both routes are covered by the one line because both already share the one handler.

Exporting the existing predicate rather than adding a second copy inside `lifecycle.ts` keeps one
definition of "UUID" for the whole projects module; two regexes in one directory would drift. The
per-module local copy remains the repository convention
([W9-PROJ-153](W9-PROJ-153-cross-workspace-model-connection-refusal.md), and the same private
declaration in `server/{agents,runtimes,runs,secrets,models}`) — this widens one module's surface by
one pure predicate, it does not introduce a shared module.

**2. The guard sits inside the `withProjects` callback, never above it.** `withProjects` answers
`503` (no runtime), `401` (unauthenticated) and `403` (forbidden actor) before the callback runs, and
`lifecycle.ts`'s own header records why that order matters: concealment applies to a **refusal**,
never to the absence of a credential. A guard placed in the two `route.ts` files, or anywhere above
`withProjects`, would turn an unauthenticated call carrying a malformed id into a `404` and make a
missing credential indistinguishable from a wrong one. What holds that position is the new case's
first two assertions — an unauthenticated call **carrying a malformed id** must still be answered
`401`. `lifecycle.test.ts`'s existing "keeps a 401 a 401" case cannot: its id is a well-formed UUID
that `isUuid` accepts, so it stays green wherever the guard sits. It is left untouched by this
repair.

**3. The fix is not made at the driver.** Classifying PostgreSQL `22P02` inside `errorResponse` (or
through a `postgresViolations`-style cause reader) was rejected: it would convert an infrastructure
signal into a domain answer globally, for every route and every id-shaped column at once; it cannot
tell *which* id was malformed, so a genuinely corrupt internal id would also be reported as "not
found"; and it treats the symptom where the boundary check removes the cause. Validating inside
`ProjectRepository.get` was rejected for the dependency direction `docs/architecture.md` and
`AGENTS.md` fix — HTTP boundary validation does not belong in the persistence layer, and it would
silently change the contract for every other caller of `get`.

**4. The regression test asserts an equality, not a status class.** The new case in
`apps/web/app/api/projects/[id]/archive/lifecycle.test.ts` takes the response to an absent
well-formed UUID as its control and asserts `toEqual` — status **and** body, field by field — for
three malformed shapes (`not-a-uuid`, a one-character-short near-miss, and a well-formed UUID with a
trailing suffix) on **both** `archive` and `restore`, then asserts the stored `archived_at` is still
`null` and that workspace A's audit-row count is unchanged across the requests — counted rather than
compared to `[]`, because the file's `auditRows()` helper is scoped to the fixture project's id,
which a malformed id can never name. It also pins the guard's position per §2, with a `401` asserted
for an unauthenticated call carrying a malformed id. "Some 4xx" would pass for a `400` that tells a
malformed id apart from an absent one, which is the defect. It needs real PostgreSQL: the in-memory
project repository is a `Map` keyed by string and cannot raise `22P02`, so a run without
`TEST_DATABASE_URL` says nothing — the point `workspaces/isuuid-guard.test.ts` already makes for the
sibling guard.

## The ADR-0048 enumeration

Root cause as a property: **no caller-supplied path segment reaches a `uuid`-typed `projects` column
without first being checked for UUID shape.** The sink was enumerated with
`grep -rn 'projects\.\(get\|archive\|restore\|update\|delete\)(' apps/web --include=*.ts` at
`63273d5`, and each hit classified by where its id came from.

| Site | Id source | Disposition |
| --- | --- | --- |
| `apps/web/server/projects/lifecycle.ts` `projects.get(id)` (reached by `…/[id]/archive/route.ts`) | path segment | **repaired here** |
| the same line, reached by `…/[id]/restore/route.ts` | path segment | **repaired here** (one shared handler) |
| `apps/web/app/api/projects/[id]/route.ts:16` (`GET`) | path segment | **reached, not repaired** |
| `apps/web/app/api/projects/[id]/route.ts:30` (`PATCH`) | path segment | **reached, not repaired** |
| `apps/web/app/api/projects/[id]/sessions/route.ts:43` (`POST`) | path segment | **reached, not repaired** |
| `apps/web/app/api/projects/[id]/sessions/route.ts:76` (`projects.get(existing.projectId)`) | column read from a row | not a crossing — the value is already a `uuid` |
| `apps/web/server/composition/register.ts:831` (`projects.get(sessionRow.projectId)`) | column read from a row | not a crossing — the value is already a `uuid` |

The three unrepaired sites are worse than the two repaired ones, not better: `GET` and
`…/sessions` have **no `try`/`catch` anywhere in the handler**, so the driver error escapes the route
entirely rather than becoming a classified `500`. They predate the review range that produced this
finding, they are #187's open question 4, and issue #200's "Do not broaden" section instructs this
repair not to reach them.

**No total claim is made for the class.** This ADR does not assert that a malformed project id is
concealed on every project route; it asserts it for `POST /api/projects/:id/archive` and `/restore`,
and it names the three sites where it is still not.

ADR-0048 step 3 — *make the enumeration a gate* — is **not discharged here**, and that is declared
rather than implied. The table above is hand-maintained: a project route added tomorrow with the same
unguarded shape will not fail anything. ADR-0031 permits a hand-maintained enumeration only when the
weakness is stated as such, so it is stated: this list is weaker than a derived gate, and a
mechanised version belongs with whichever task repairs the three remaining sites, where it would have
something to assert over.

## Consequences

- A caller can no longer tell a malformed project id from an absent one on these two routes. No
  canonically-formed id changes behaviour: `isUuid` accepts every id this API ever emits (both
  `crypto.randomUUID()` and a `uuid` column render the canonical hyphenated form). The routes also
  narrow slightly, and deliberately: PostgreSQL's `uuid` parser additionally accepts braced and
  hyphen-less spellings, which now answer `404` rather than resolving the row. Otherwise only inputs
  that previously produced a `500` change — to the status the module's own contract already
  specifies. No client can have depended on the `500`.
- `apps/web/server/projects/http.ts` exports one more symbol. `knip` is satisfied because
  `lifecycle.ts` imports it.
- No migration, no schema change, no contract or type change, no new dependency, no route added, so
  `tests/route-inventory.test.ts` and the closed-world route declaration are unaffected.
- Rollback is a revert: the guard is additive and stateless, and nothing persists differently.
- Residual risk, declared and not hidden: the three enumerated sites remain defective after this
  change.
