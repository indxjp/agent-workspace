# W2-CP-06 — the four roles of §21, and what this repository decided where §21 does not say

Status: accepted
Date: 2026-09-05
Scope: `apps/web/server/rbac/**`; the §21 permission split and the authorisation matrix
Task: W2-CP-06 · Spec: §21, §22 · Research: research note R-12

## Context

Spec §21 lists four roles and then introduces the permission split with one word that decides how
much of this is a decision and how much is a transcription:

> Suggested permissions:

**Suggested.** §21 proposes a split; it does not fix one. R-12 §2.1 makes the same point and adds
that three specific things follow from the text as printed and must be *decided* rather than
discovered. This ADR is that decision, taken under one rule, given to this task in its dispatch:

> If §21 leaves a case ambiguous, choose the least-privilege reading and record it … with the
> ambiguity quoted.

Every section below quotes the ambiguity and then states the reading, so a later reader can
disagree with the reading without having to re-derive what the text actually said.

## Decision 1 — the shape: `(role, resource, operation) → grant`

The table lives in `apps/web/server/rbac/permissions.ts`. A grant is one of four widths — `any`,
`own`, `permitted`, `none` — and each role is declared as a **fallback plus the resources §21 names
for it**. Owner's fallback is `any`; every other role's fallback is `none`.

The fallback is the load-bearing part. A resource nobody classified is denied rather than granted,
which is ADR-0015's shape applied to a table instead of to a classifier, and it is what lets the
authorisation matrix keep working as other tracks add resources: the worst a forgotten resource can
do is refuse.

Whether a row is the caller's own is **not** decided by the table. It is an argument, `ownership`,
supplied by the handler that has the row, with four values including `unknown` — the honest answer
from a handler that has not read it. `unknown` denies.

## Decision 2 — Admin's list omits `skills` and `files`, and this build reads that literally

> **Superseded** by [ADR-0116](0116-admin-manages-skills-and-files.md) (2026-10-05): Admin now
> holds `skills` and `files` as `EVERYTHING`. The text below is kept as the historical record.

> ### Admin
>
> Users, agents, models, API keys, connectors, runtimes.

> ### Builder
>
> Create/edit/run agents, skills, files, connectors where permitted.

Read literally, an Admin may manage users, agents, models, API keys, connectors and runtimes but
**not** skills or files, while a Builder below them may. The alternative — that the four roles are a
total order and each includes the one below — is coherent, and R-12 §2.1 says exactly why it cannot
be adopted here: *"that is an interpretation, and not the text"*.

**Decision: the literal reading.** `grantsFor('admin', 'skills')` and `grantsFor('admin', 'files')`
are `none`. This is the least-privilege reading of the omission, and it is the one this task was
told to take. An Owner is unaffected — §21 gives Owner *"Everything."* — so no capability is
unreachable in a workspace, only unreachable to an Admin.

This is recorded as a **finding against the specification**, not merely as an implementation choice:
if §21 meant the roles to nest, §21 should say so, and the fix is an amendment to §21 rather than a
widening of this table.

## Decision 3 — Admin's clause has no verb, so it includes running

§21's Admin clause is a list of resources with no verb attached. Builder's is verb-qualified
(*"Create/edit/run"*). Unqualified control of "agents" therefore includes starting a run:
`grantsFor('admin', 'agents')` is `any` for read, write **and** run.

This is not a least-privilege exception. Reading the unqualified clause as
management-without-execution would be a *narrower* reading than the words, which is a different
thing from a least-privilege reading of an ambiguity — there is no ambiguity to resolve, only a
temptation to add a restriction the text does not contain.

## Decision 4 — Builder's "where permitted" is read as "its own rows"

> Create/edit/run agents, skills, files, connectors **where permitted**.

§21 names no mechanism that grants an individual permission on an individual object, and §27's table
list contains none (R-12 §2.1, item 3). Two readings are available and both are defensible:

* deny everything, because the qualifier can never be satisfied — which empties the Builder role;
* limit it to the rows the caller owns — a real restriction, expressible with data that exists, and
  strictly narrower than "any".

**Decision: `own` for write and run, `any` for read.** It is the least-privilege reading that leaves
§21's Builder clause with any meaning at all, and "the row the caller created" is a mechanism this
program can actually evaluate, unlike the one §21 gestures at.

The obligation this creates is stated rather than hidden: a grant of `own` on a **collection** route
(`GET /api/skills`) is allowed, and the handler then owes the result set the same filter. That is a
contract, not a gate. `apps/web/server/rbac/decide.ts` says so in the sentence it returns, and this
task's PR declares it as unchecked.

## Decision 5 — Viewer's "permitted agents" denies, and says why

> ### Viewer
>
> Run permitted agents and view their own sessions.

Here "permitted" modifies the objects directly, and there is still no mechanism. The least-privilege
reading is that the permitted set is **empty** until one exists, so a Viewer may run nothing.

**Decision: a distinct grant value, `permitted`, which denies.** It is deliberately not spelled
`none`:

* the denial carries its own explanation — the decision text names the missing mechanism and cites
  this ADR, so an operator reading a 403 is not left guessing;
* the day a per-agent permission mechanism lands, the change is one word in one table rather than an
  archaeology exercise over which `none`s were principled and which were oversights.

This is ADR-0031 applied to a permission rather than to a static gate: the predicate is undecidable,
so it is refused, and the refusal is the `else`.

**Consequence, stated plainly because it is a product consequence and not only a code one:** on this
build a Viewer can read the agent list and read its own sessions and runs, and can do nothing else.
That is what §21 says once "permitted" is taken seriously. It is declared as a gap in this task's PR
so that whoever owns the agent-permission mechanism inherits a decision, not a surprise.

## Decision 6 — Viewer may read the agent list

No clause of §21 grants a Viewer *read* on agents. But *"Run permitted agents"* is not a sentence
about anything a Viewer can do unless the agent list is visible to them, and no clause of §21
restricts reading either.

**Decision: `read: 'any'` on `agents` for every role.** This is the one place where a *wider* reading
than the bare text is taken, it is taken for exactly one resource, and it is taken because the
narrower reading makes the lowest role's own clause unsatisfiable. Everything else in the table is
literal or least-privilege.

## Decision 7 — resources §21 does not name at all

§21 names no role for `secrets` (§23), `audit-events` (§36), `sessions` for Admin, or `projects` for
Admin. Owner has *"Everything."*; everyone else falls to the `none` fallback, except where §21's
**sharing** block — which does enumerate all four roles — says otherwise:

> ```text
> Owner     everything, including the workspace "Public sharing: off" policy switch
> Admin     revoke or suspend any share in the workspace, see the shared-links page
> Builder   share own agents, projects and sessions to workspace or public link
> Viewer    share own sessions to workspace; public links only if the workspace allows it
> ```

So `shares` is `any` for Admin and `own` for Builder and Viewer, from the text; `sessions` and
`projects` are `own` for the roles that block names as owning them; and `secrets` is Owner-only.

`memberships` is the one resource this ADR grants Admin without §21 naming it, and the reasoning is
in the table itself: §21 gives Admin *"Users"*, and a membership is how a user is attached to a
workspace with a role. §21's user model has no other way to say who belongs where, so reading
"Users" as excluding memberships would grant Admin a capability with no mechanism.

## Decision 8 — the matrix derives its routes and fails closed

The acceptance criterion asks for *"an authorisation matrix test covering four roles × every route
registered at the time it runs, derived from the route declarations rather than transcribed"*.

`apps/web/server/rbac/authorisation-matrix.test.ts` reads the union of
`tests/route-declarations/**` — the same union `tests/route-inventory.test.ts` asserts **equals** the
route handlers the tracked tree serves (ADR-0025) — and crosses it with the four roles and all four
ownership answers. A cell `decide()` cannot classify comes back `refuse`, and the test reports every
refusal as a failure. Nothing in that file lists a route or counts one; the products are computed
from the union and the two exported constant lists (ADR-0016).

Three consequences follow, and they are the reason for the shape:

1. a route another task adds is in the matrix the moment it is committed, with no edit here;
2. a route whose resource nobody classified **fails** the test rather than being skipped;
3. a route that exists but is declared nowhere fails the *inventory* gate, so it cannot escape this
   one by being undeclared.

`decide()`'s third answer, `refuse`, maps to `500 authorisation_undecidable` at the HTTP edge and
never to `403`. A `403` asserts that a rule was applied; when nothing was decided, saying so is the
only honest status.

## What this decision does not give you

The matrix proves the **table**. It does not prove the **wiring** — that each handler calls
`authorise` — and R-12 §2.2 names that trap explicitly. `apps/web/server/rbac/routes.test.ts` proves
the wiring for the routes this task owns, by driving the real route modules with real `Request`
objects and comparing each status against a prediction computed from `decide()`. For routes owned by
other tasks it is **not** proved, because those files are outside this task's `Owns` globs. That is
carried as a declared gap in this task's PR rather than left implied.

## Amended in verification round 2

Two things this ADR argued for turned out not to be enforced, and each now has a record of its own:

* **Decision 2's argument was voidable.** It argues at length that an Admin literally may not write
  `skills` or `files` because §21's Admin clause omits them — while nothing stopped an Admin from
  making itself an Owner and taking all of it, by `POST /api/api-keys {role:'owner'}` or by one
  `PATCH` on its own membership row. The rule that closes it, and the fact that it is *derived from
  the table above* rather than from a privilege ordering the table contradicts, is
  [W2-CP-06 — a caller may not confer a role it does not itself
  hold](W2-CP-06-a-caller-may-not-confer-a-role-it-does-not-hold.md). Read it with Decision 2: the
  conferral matrix is a consequence of the reading taken there, including the part that costs
  something (an Admin may not confer Builder either).
* **Decision 8's "a route whose resource nobody classified fails the test" held for the resource
  segment and not for the sub-resource segment.** `/api/<classified>/:id/<anything>` inherited the
  parent's grants silently. See [W2-CP-06 — an unclassified sub-resource is refused, not given its
  parent's grant](W2-CP-06-an-unclassified-sub-resource-is-refused-not-inherited.md).
