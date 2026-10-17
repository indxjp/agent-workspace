# ADR-W9-RUNS-135 — a durable, workspace-scoped run list, keyset-paginated and unindexed by design

Status: accepted
Date: 2026-09-12
Decided by: W9-RUNS-135 (implementing agent)
Scope: `packages/core/src/db/repositories/runs.ts`, `apps/web/app/api/runs/**`,
`apps/web/server/runs/**`

## D1 amendment

The forced own-run list filter now uses `ownerPrincipalId` reached through the run's session, not
`initiatingUserId`. The former Admin own-only gap G-7 was superseded by
[W9-AUTH-165](W9-AUTH-165-admin-reads-workspace-run-history.md): Admin reads workspace run history.
The resume cursor is trimmed before parsing by the current `runs/cursor.ts` implementation.

## Context

Issue #135 asks for `GET /api/runs`: a workspace-scoped, filterable, cursor-paginated list whose
items carry the same attribution and telemetry `GET /api/runs/:id` already carries, so the two
"cannot drift". Three things made that harder than "add a route":

1. **`GET /api/runs/:id` is not backed by the repository layer directly.** It goes through
   `apps/web/server/runs/environment.ts`'s `RunApiEnvironment`/`RunStore` port — W1-CP-04's seam,
   installed once by `apps/web/server/composition/register.ts` (outside this task's `Owns` globs)
   — and `RunStore` identifies a run by id alone (see `store.ts`'s own header on why). A collection
   has no id to look a workspace up from, so `listRuns` is the one member of that port that takes a
   workspace id explicitly.
2. **The public repository barrel (`packages/core/src/db/index.ts`) is a named export list**, not a
   wildcard, and it is outside this task's `Owns` globs. A new type that needed a name on that
   barrel to be reachable from `apps/web` would have been a file this task cannot edit.
3. **`packages/gateway/src/index.test.ts`** constructs a `RunRecord` object literal by hand, and is
   also outside `Owns`. Any field added to core's `RunRecord` as _required_ breaks that literal's
   type.

## Decision

1. **`RunRepository.listRuns`** is added to `packages/core/src/db/repositories/runs.ts` — the one
   file this task owns in `packages/core` — and needs no companion edit to `repositories/index.ts`,
   `db/index.ts`, or `repositories/root.ts`: `RunRepository` and `RunRepositoryProvider` are already
   on the public barrel, `DatabaseRoot.runs` is already typed as `RunRepositoryProvider`, and
   `openDatabaseRoot` already constructs it from `createDatabaseRunRepositoryProvider(db)`. Adding a
   method to an already-exported interface, implemented in the same factory function that already
   backs `DatabaseRoot.runs`, reaches every existing composition root with zero edits outside this
   file. `apps/web` derives the method's input/output shapes structurally
   (`RunRepository['listRuns']`) rather than importing new named types, for the same reason.

2. **`RunRecord.projectId` and `RunRecord.initiatingUserId` are added as _optional_ fields**, both
   in core's `RunRecord` and in `apps/web/server/runs/store.ts`'s mirror of it — never required.
   Core's `get()` and `listRuns()` both populate them (same `sessions` join `agentId` already uses),
   so every record either path produces carries real attribution; the field stays optional purely
   so `packages/gateway/src/index.test.ts`'s hand-built fixture keeps compiling. The same
   reasoning, and the same fix, applies to `accountingState`/`accountingError` on `store.ts`'s
   `RunRecord`, which had never carried issue #134's fields at all before this task — `readRun`'s
   existing `renderRun` output was missing them, which this task also closes.

3. **`RunStore.listRuns` is a workspace-id-taking, _optional_ member of the port**, implemented by
   both `InMemoryRunStore` (a real in-memory implementation, for fast tests — not a deployment
   path, see `store.ts`'s header) and `createRepositoryRunStore` (which resolves a scope from the
   dependencies it is _already_ constructed with — `repositories` and `scopes` — and delegates).
   Optional on the interface, not because either shipped implementation omits it, so a hypothetical
   third implementation of this port is not forced to answer a question issue #135 is the first
   caller to ask; `apps/web/server/runs/api.ts` treats an environment whose store has no
   `listRuns` as `503`, the same way it already treats `revokeRunTokens` being absent.

4. **`readRun` and `listRuns` (the HTTP handler) call the same `renderRun`.** `renderRun` is
   extended with the fields the card asks for on both routes: `projectId`, `initiatingUserId`,
   `accountingState`, `accountingError`, a derived `durationMs` (`null` unless both timestamps are
   set), and a derived `usage.totalTokens` (the sum of the four persisted counters). Neither route
   builds its own copy of this shaping.

5. **Cursor pagination is keyset, on `(created_at, id)` descending**, matching the order
   `runs_workspace_created_idx` (already on the table, from an earlier task) is shaped for. The
   cursor a client holds is opaque — base64url of `{createdAt, id}` — and a malformed one is `400`,
   never silently treated as "start over" (the same ADR-0015 shape `./cursor.ts`'s SSE resume
   cursor already uses, cited in that file's own header). One extra row is fetched per page
   (`limit + 1`) to answer "is there a next page" without trusting a count that can change under
   concurrent writes.

6. **The `user` filter is gated on the _grant_, not the _role name_.** `decideRunListAccess` calls
   `decide()` exactly as `readRun`'s `requireRunPermission` does, with `ownership: 'not-applicable'`
   (the collection-route case `rbac/decide.ts`'s own comment describes: the grant is returned so
   "the handler owes the result set the same filter"). A `grant !== 'any'` forces
   `initiatingUserId: principal.userId` onto the filter unconditionally — a caller cannot widen
   their own request past it — and a caller who explicitly names `user=` while holding a narrower
   grant gets `403 user_filter_forbidden`, even naming their own id: the filter is not _offered_,
   which is stronger than "offered but redundant". This reuses `permissions.ts`'s existing `runs`
   classification and edits no RBAC file, per the task card.

7. **No migration, no new index (gap G-6).** `#135`'s issue text asks for query plans before an
   index is added. `runs_workspace_created_idx` (workspace_id, created_at) already exists from an
   earlier task and is what every representative filter's plan below uses as its access path; this
   task adds none of its own. See `## Query plans` below and the PR's `## Declared gaps`.

8. **An Admin's `GET /api/runs` is narrowed to the Admin's own runs (gap G-7, undeclared until
   verification round 1).** The task card's own premise reads "`any` for Owner/Admin, `own` for
   Builder/Viewer", quoting spec §21. That is not what `permissions.ts` — outside this task's `Owns`
   globs, owned this wave by W9-WS-119 — actually encodes: `POLICY.admin.byResource.runs` is
   `OWN_READS`, not `EVERYTHING`/`any`, per that file's own comment ("§21 gives Admin no clause
   about sessions or runs, so an Admin has what every member has: their own. Least-privilege
   reading of silence"), recorded by W2-CP-06. Because `decideRunListAccess` reads the grant
   `decide()` returns rather than the role name, and `parseRunListQuery` treats any grant other
   than `any` identically, an Admin is routed through the same forced-own-filter branch as
   Builder/Viewer — silently, since nothing in this task's code asked "is this role Admin" and got
   a different answer than "is this role Builder". Issue #135's acceptance criterion "Owner/Admin
   see allowed workspace history" is therefore met for Owner only. This task cannot fix it: the fix
   is a one-line change to `permissions.ts`'s Admin `byResource.runs` entry, and that file is not in
   this task's `Owns` globs (a shared file this wave, per the task card's own words: "this task
   edits no RBAC file, which is what lets it share W9.5 with W9-WS-119"). What this task does
   instead: the header comment and the `own`-filter comment in `apps/web/server/runs/api.ts` now
   name Admin explicitly rather than omitting it, and `apps/web/server/runs/api.test.ts` adds a
   named test asserting today's behaviour (Admin sees only its own runs; `?user=` is `403` for
   Admin) — proven load-bearing by the same removed-line/removed-guard technique the PR already
   uses for Builder/Viewer — so that when `permissions.ts` widens Admin to `runs: any`, that test
   flips from green to red instead of the behaviour silently changing unnoticed. `GET /api/runs`
   needs no further change on that day: the grant-driven branch already does the right thing for
   any grant of `any`, Owner included.

## Query plans

Captured with `EXPLAIN (ANALYZE, BUFFERS)` against a seeded workspace. Pasted into the PR body
rather than duplicated here, so there is exactly one copy to keep honest as the seed size changes.

Round 2 finding 5 found the round 1 plans hand-abridged (`…` elisions, bracketed annotations) while
this sentence claimed "verbatim" — true of the capture method, not of what actually reached the PR.
Round 3 finding 7 found the round 2 plans still edited — every UUID in an `Index Cond`/`Recheck
Cond` elided to `'55fab138-…'` — under a heading that said "unedited", and the seed size typed into
prose rather than pasted. Both descriptions were wrong and are corrected in the PR body: the round
2 heading now says what was elided, and `## Verification round 3` carries plans pasted verbatim
from the file a temporary test wrote them to (the test seeded runs across several sessions,
projects, statuses and providers, printed `select count(*)` alongside each plan, and was deleted
before the round was returned, per the repair protocol's rule against a new file under this task's
single-file `runs.ts` `Owns` entry). The round 2 seed's artifact — every session in one project, so
its "project filter" plan filtered nothing — is gone from the round 3 seed. No count in this ADR or
in the PR body's round 3 section is typed; each is the output of the command beside it.

9. **A run-list cursor's `createdAt` is accepted only in the exact shape the stores mint (round 3
   finding 4).** `decodeRunListCursor` used to gate the value with `new Date(text)`, which accepts
   `"1"`, `"2026"`, `"0000-01-01T00:00:00Z"`, a signed six-digit year and `2026-02-30`, none of
   which PostgreSQL accepts (or reads the same way); a crafted cursor therefore passed the gate and
   threw out of the `::timestamptz` cast as a `500`, with the failing SQL in the error log. The
   gate is now a strict shape — `YYYY-MM-DDTHH:MM:SS.fZ`, one to six fractional digits, UTC,
   unsigned, no year 0 — plus a calendar check that rebuilds the instant from its fields and reads
   them back, so an impossible day or hour (which `Date` silently rolls over) is refused too. The
   shape admits exactly what `to_char(…, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` (the repository) and
   `Date.prototype.toISOString` (`InMemoryRunStore`) produce, and nothing else — including a
   timestamp with no fractional part, which neither store ever mints.

10. **`createdTo` is inclusive at millisecond precision, the precision the API renders (round 3
    finding 5).** `runs.created_at` holds microseconds; every `createdAt` the API renders is a
    `Date`, which holds milliseconds. A plain `created_at <= createdTo` therefore excluded a run
    from a range whose `to` was that run's own rendered `createdAt` whenever its last three digits
    were not zero — asymmetric with `from`, which a millisecond-aligned bound compares correctly
    without help. The repository now applies `created_at < createdTo + 1 ms`: the same inclusive
    bound at the precision the bound can carry, with `created_at` left bare for an index. `from`
    is unchanged, because for a millisecond-aligned `F`, `created_at >= F` and
    `floor_ms(created_at) >= F` already agree. `InMemoryRunStore` needs no change — it never had
    microseconds — and the port's doc comment now states the contract for both implementations.

11. **One run per predicate, differing from a base run in exactly that predicate's column (round 3
    findings 1–3).** The earlier "three near-misses, one match" intersection tests proved the
    filters composed, but a mutant that deletes one predicate survives them whenever another
    predicate already excludes the same near-miss (the round 2 `wrongStatus` run was also
    wrong-provider). The round 3 fixture in `apps/web/server/runs/store.test.ts` inserts, on real
    PostgreSQL, a base run and one run per column `listRuns` filters on, each identical to the base
    except in that column, and one test per repository predicate and per `parseRunListQuery`
    assignment asserts the filter excludes exactly that run. Each mutant in the PR body's round 3
    table fails a test that names the predicate it deleted.

12. **`from`/`to` are accepted only in a strict, explicit-zone ISO-8601 shape, bounded to years
    0001–9999 (round 4 findings 2 and 5).** Point 9 called `new Date(text)` "the wrong gate" for
    the cursor and left the two sibling parameters, parsed six lines apart, on exactly that gate:
    `from=1`, `from=2026`, `to=Sep 12 2026`, a signed six-digit year and year 0 all passed it, and
    the last two threw out of the query as a `500` with the failing SQL logged; a zone-less
    `from=2026-09-13T00:00:00` passed it too and was read in the web process's own time zone, so
    one request answered different rows on instances configured differently — the opposite of
    issue #135's "complete across web instances". `parseRunListBound` now admits
    `YYYY-MM-DDTHH:MM:SS`, an optional fractional part of one to three digits, and a mandatory `Z`
    or `±HH:MM`; the calendar fields are checked by the same `instantOfUtcFields` the cursor gate
    uses; and the resulting UTC instant must lie in `0001-01-01T00:00:00Z`–`9999-12-31T23:59:59.999Z`,
    checked after the offset is applied (`9999-12-31T23:00:00-02:00` is already year 10000).
    Everything else is `400 invalid_from` / `invalid_to`. The shape is wider than the cursor's
    on purpose: a cursor is minted by this code and may be pinned to what it mints, while a bound
    is written by a caller, and `2026-09-12T00:00:00Z` or a `+09:00` offset is what a caller
    writes. It is narrower than `Date` on purpose: a fourth fractional digit would be dropped
    silently and move `from` onto rows the caller asked to exclude, so it is refused rather than
    truncated. The year range is not PostgreSQL's (4713 BC–294276 AD) but `toISOString`'s: every
    `Date` the query binds is serialised by it, and it prints a year outside 0001–9999 in the
    signed six-digit form PostgreSQL refuses.

13. **The `createdTo + 1 ms` of point 10 is added by PostgreSQL, not by `Date` (round 4 finding
    2, the repair regression).** In JS, `9999-12-31T23:59:59.999Z + 1 ms` is year 10000, which
    `toISOString` prints as `+010000-01-01T00:00:00.000Z` and PostgreSQL refuses — so the round-3
    fix turned a legal `to` that answered `200` before it into a thrown query. The repository now
    binds `createdTo` as the exact text `toISOString` prints for it and adds the millisecond in
    SQL (`created_at < $to::timestamptz + interval '1 millisecond'`), where year 10000 is an
    ordinary value. `created_at` stays bare for an index; the right-hand side is a constant the
    planner folds once. No branch, no clamp: there is no edge left to special-case.

14. **The task card's verifier attack 2 — three inserts and one delete between page one and page
    two — is a shipped test, not a declared gap (round 4 finding 6, both verifiers).** The round-3
    body declared it unautomatable because `apps/web` cannot import `drizzle-orm`; the same suite
    was already running raw SQL through `db.execute` for the microsecond test, and a `delete from
runs where id = …` through the same call is the whole mechanism. The gap is deleted, not
    restated: the test runs once over seven distinct instants and once over seven rows sharing one
    instant, deleting the row page two would have started with, and asserts no duplicate, the
    deleted row absent, every other pre-existing row seen exactly once, and none of the three
    mid-walk inserts served.

15. **The page-size ceiling is a number this port states twice, held together by a text-reading
    drift test, and enforced by the conformance suite rather than by one implementation (issue
    #166).** `MAX_RUN_LIST_LIMIT = 200` lives in `packages/core/src/db/repositories/runs.ts`, where
    the repository refuses a larger page by name, and in `apps/web/server/runs/api.ts`, which
    answers `400 invalid_limit` before any store is reached. `InMemoryRunStore` had neither, so
    `listRuns(workspace, { limit: 201 })` resolved on one implementation of this port and was
    refused by the other — invisible over HTTP, reachable by a direct port caller. It now restates
    the same constant, in `apps/web/server/runs/store.ts`, and refuses with the repository's exact
    message. Restated and not imported, for point 2's reason and `store.ts`'s header's: `apps/web`
    reaches `@agent-workspace/core` through `import type` only, and a value import would mean a new
    runtime dependency in `apps/web/package.json`. What keeps the three copies honest is a test
    that reads the other two files as *text* — the pattern `store.test.ts` already uses for
    `runStatuses` — and what keeps the two implementations answering identically is that the limit
    assertion moved out of the PostgreSQL-only block into `describeRunStoreConformance`, where both
    stores run it and both must produce the same message string.

## Alternatives considered

- **Offset/limit pagination.** Rejected outright: issue #135's own acceptance criterion is "cursor
  pagination is stable with simultaneous new runs", and an offset is defined by a row count that a
  concurrent insert or delete changes out from under a client mid-walk — the exact failure the
  verifier's attack scenario 2 checks for.
- **A raw SQL row-value comparison (`(created_at, id) < (?, ?)`) instead of the `or(lt, and(eq,
lt))` form.** Both are equivalent; the `or`/`and`/`lt`/`eq` form was chosen because every other
  predicate in this file is built the same way, and a raw-SQL tuple comparison would be the one
  exception a future reader has to remember has the same meaning.
- **Making `RunRecord.projectId`/`initiatingUserId` required, and fixing `packages/gateway`'s test
  fixture instead.** Rejected: `packages/gateway/src/index.test.ts` is outside this task's `Owns`
  globs; touching it is exactly the kind of collateral edit the task card forbids. Optional fields
  are the change that stays inside this file's own boundary.
- **Exporting `MAX_RUN_LIST_LIMIT` from `packages/core` and importing it into `apps/web` (point
  15).** Not available: it is a value import, `apps/web` has no runtime dependency on
  `@agent-workspace/core`, and adding one to `apps/web/package.json` to share one integer would
  trade a drift risk a test already covers for an architectural one nothing covers.
- **Leaving `InMemoryRunStore` permissive and recording the divergence as a gap (point 15).**
  Rejected: "one suite, two implementations" is this port's stated contract, and a conformance
  suite that runs one of its assertions against one implementation is not asserting conformance.
- **Deriving `RunStore.listRuns`'s filter/cursor/page types by importing core's exported names.**
  Not available: those names are not on `@agent-workspace/core/db`'s barrel, and adding them means
  editing `packages/core/src/db/repositories/index.ts` and `packages/core/src/db/index.ts`, neither
  of which is in this task's `Owns` globs. `apps/web/server/runs/store.ts` restates the shapes
  instead, field for field, the same way it already restates `runStatuses` and `modelProviders` for
  documented reasons this ADR does not repeat.
- **Comparing `to` against `date_trunc('milliseconds', created_at)` (round 3 finding 5).**
  Rejected: it says the same thing as `created_at < to + 1 ms` but puts a function on the column,
  which no future index on `created_at` could serve — and G-6 exists precisely so an index can be
  added later without rewriting the predicate.
- **Rendering `createdAt` at microsecond precision instead, so `to` and the rendered value agree
  at the database's precision (round 3 finding 5).** Rejected: `RunRecord.createdAt` is a `Date`
  on every path that renders it, a `Date` cannot hold microseconds, and changing the rendered field
  to a string would change the contract of every consumer of `GET /api/runs/:id` for a bound the
  API only ever accepts at millisecond precision anyway (`from`/`to` carry at most three
  fractional digits — point 12).
- **Gating `from`/`to` on exactly the cursor's shape (`.fZ`, one to six fractional digits, `Z`
  only) (round 4 findings 2 and 5).** Rejected: a caller writes `2026-09-12T00:00:00Z` and, from
  a browser in Tokyo, `2026-09-13T00:00:00+09:00`; refusing both to reuse one regular expression
  would trade a `500` for a `400` on input every ISO-8601 client produces. The calendar check is
  shared; the shape is not.
- **Keeping `new Date(text)` and adding a year-range check on the result.** Rejected: it still
  admits `1`, `2026` and `Sep 12 2026` (read as local-time instants nobody asked for) and still
  reads a zone-less timestamp in the process's time zone. The instant has to be built from the
  digits, not read out of `Date`'s permissive parser.
- **Clamping `createdTo + 1 ms` in JS (fall back to `lte(created_at, createdTo)` when the sum
  would leave year 9999) (round 4 finding 2).** Rejected: it adds a branch that is exercised by one
  value and answers that value slightly wrongly (a run in the last 999 µs of year 9999 is dropped);
  doing the arithmetic in SQL has no branch and no wrong answer.
- **Refusing `to=9999-12-31T23:59:59.999Z` as `invalid_to` because the millisecond after it is
  year 10000.** Rejected: it is a well-formed, in-range bound that answered `200` at the PR's own
  first head; the defect was in the arithmetic, not the input.
- **Catching the database error a malformed cursor throws and answering `400` from the catch
  (round 3 finding 4).** Rejected: the catch would have to distinguish a cursor-shaped failure from
  every other failure the same query can raise, from the error text — and would still have let a
  caller run a statement the route already knew could not succeed. Refusing the shape before the
  query is the ADR-0015 direction: the check runs, or the request fails by name.
- **Silently ignoring an unpermitted `user=` filter rather than `403`-ing it.** Rejected: a caller
  who believes their filter was applied and instead received the unfiltered "own" result is worse
  off than one who is told the filter does not exist for them (ADR-0015's "a check that cannot run
  fails" read the other way — a parameter that cannot be honoured is refused, not dropped).

## Consequences

- A run-list query plan is not proven at real history size; that is gap G-6, declared on the PR,
  not claimed away by this ADR.
- `to` is inclusive at the millisecond: two runs created 400 µs apart inside one millisecond are
  either both inside a range ending at that millisecond or both outside it. A caller who needs to
  split them has no rendered value to do it with, and this API does not offer one (point 10).
- `from`/`to` refuse a zone-less timestamp, a fourth fractional digit, and any instant outside
  years 0001–9999, even where `Date` would have read them (point 12). A client that sent
  `from=2026-09-13T00:00:00` and happened to run on a UTC instance now gets `400` where it got an
  answer; that answer was only right on that instance.
- `from`/`to` accept an offset, so two spellings of one instant are the same query; the response
  still renders every timestamp in UTC (`toISOString`), never in the caller's offset.
- `InMemoryRunStore.listRuns` is stricter than it was (point 15): a direct port caller asking for
  more than 200 rows now gets a rejected promise where it used to get a page. No HTTP caller is
  affected — `api.ts` refuses the same input as `400 invalid_limit` first — and no production caller
  asks for more.
- A run-list cursor that carries a timestamp with no fractional digits, or with more than six, is
  refused as `invalid_cursor` even though PostgreSQL could read the former. The cursor is opaque by
  contract and neither store mints either shape, so nothing but a hand-built cursor is affected
  (point 9).
- `RunRecord.projectId`/`initiatingUserId` being optional means a caller of `RunRepository` that
  builds its own `RunRecord` by hand (as `packages/gateway`'s test does) will not be told by the
  compiler that it is missing attribution a real repository read always carries. That is the
  accepted cost of not editing a file outside this task's globs.
- A future task that wants to widen who gets the `user` filter (or add a `metrics`-style
  aggregate) does so entirely in `permissions.ts` and `apps/web/server/runs/api.ts`; nothing in the
  repository layer encodes which grant unlocks which filter.
- Gap G-7: an Admin cannot see workspace-wide run history through `GET /api/runs` today, only its
  own runs, because `permissions.ts` (outside this task's `Owns` globs) classifies `runs` as
  `own` for Admin. Issue #135's "Owner/Admin see allowed workspace history" is met for Owner only
  until a `permissions.ts` change — owned elsewhere — grants Admin `runs: any`; when that lands,
  `GET /api/runs` widens with no change to this file. See point 8 above.
- Gap G-8 (added in verification round 2, finding 4): `decideRunListAccess`'s
  `decision.effect !== 'allow'` arm (a `deny` or `undecidable` classification of the `runs`
  resource) is untested and, today, unreachable: `permissions.ts`'s current table gives every one
  of the four roles `read: 'own'` or `read: 'any'` on `runs`, so `decide()` never returns anything
  but `allow` for `GET /api/runs`. Reaching it needs a `permissions.ts` change — owned outside this
  task's `Owns` globs — that gives some role no read grant on `runs` at all; this task cannot
  manufacture that input to test the branch honestly, and cannot delete a defensive authorisation
  check just because today's data does not exercise it. The sibling branch in the same function
  (`role === null`, a corrupt-membership-row principal) **was** reachable with a same-shape
  fixture and is now covered — see `apps/web/server/runs/api.test.ts`'s "refuses a principal whose
  role is not one of the four recognised roles" test — so only the `deny`/`undecidable` half of
  finding 4 remains an accepted, recorded gap rather than a fix.
