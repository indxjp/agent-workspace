# W2-CP-06 — a caller may not confer a role it does not itself hold

Status: accepted
Date: 2026-09-05
Scope: `apps/web/server/rbac/conferral.ts`; every route of this task that reads a `role` from a request body
Task: W2-CP-06 · Spec: §21, §22 · Research: research note R-12

## Context

Round 1 of this task shipped four routes that write a role into a row —
`POST /api/users`, `POST /api/memberships`, `PATCH /api/memberships/:id`, `POST /api/api-keys` —
and read the `role` field of the body with `parseRole`, which asks exactly one question: *is this
value one of §21's four roles?* The question it does not ask is *may THIS caller confer THAT
role?*, and no code anywhere in the branch asked it.

Verification built and ran the consequence, through the shipping route modules, in a workspace
holding one Owner and one Admin:

```text
BEFORE  admin GET /api/secrets -> deny
POST /api/api-keys {role:"owner"} as ADMIN -> 201
the key authenticates with role -> owner
AFTER   that key GET /api/secrets -> allow

PATCH own membership {role:"owner"} as ADMIN -> 200
role now -> owner
```

`packages/core/src/db/schema/api-keys.ts` carries `role: text('role', { enum: membershipRoles })`,
so the first path is a durable column and not a fixture artefact.

Two things make this the most serious defect the wave found. The first is that it is a complete
bypass of §21: an Admin reaches `secrets`, which this task's own table denies to Admin, by one
`POST`. The second is that it voids the argument of
`W2-CP-06-the-four-roles-and-their-permission-split.md` — 182 lines arguing that Admin literally
may not write `skills` or `files` because §21 omits them, while one `PATCH` on the Admin's own
membership row makes the Admin an Owner and hands back all of it.

**Two independent routes had the identical hole.** That is the signal the check belongs below both
rather than in each.

## Decision 1 — the rule is domination over the permission table, not a privilege ordering

> A caller may confer a role only if the caller's own grants dominate that role's grants, over
> every resource and every operation.

The obvious rule is an ordering — `owner > admin > builder > viewer` — and it is wrong *here*, for
a reason this task had already recorded. Decision 2 of the permission-split ADR reads §21's Admin
clause literally, so Admin has no grant over `skills` and `files` while Builder has one. Under this
repository's own table the four roles are therefore **not** a total order, and an ordering written
into code would assert something the table contradicts (ADR-0016). `ROLES`'s comment in `roles.ts`
still called the order `owner ⊃ admin ⊃ builder ⊃ viewer`; that sentence has been corrected, since
the containment it claimed does not hold.

Domination asks the table instead. The comparison is `dominates(held, conferred)` over
`RESOURCES × {read, write, run}`, and it is decided positively: `any` covers every width; `none` is
covered by every width; equal widths are equal sets. Nothing is concluded from the absence of a
mismatch.

## Decision 2 — an undecidable comparison refuses, and `permitted` is the one that is

§21 uses one grant width whose extent it never defines: Viewer's *"Run **permitted** agents"*.
`permitted` denies today, but *denying* and *being narrower than `own`* are different claims, and
§21 supports neither. Where either side of a comparison is `permitted` and the two are not equal,
`dominates` answers `undecidable`, and `conferRole` answers `refuse` → `500
authorisation_undecidable`, never `allow` and never a `403` that would assert a rule had been
applied (ADR-0015, ADR-0031).

The one pair this reaches is `builder → viewer`. No Builder can reach a role-accepting route on
this build — §21 gives Builder no write grant over `users`, `memberships` or `api-keys` — so it is
a refusal nothing exercises in production and a branch the tests do exercise.

## Decision 3 — the rule is enforced by the type system, in one place

`conferRole` returns a `ConferredRole`: a `Role` branded with a `unique symbol` that no other
module can name. `WorkspaceDirectory`'s three role-writing inputs and `changeMembershipRole` take
`ConferredRole` rather than `Role`, so a route that takes a role from a request body and reaches a
row without asking is a **compile error**, not a review comment. `handlers.ts` has one reader,
`readConferredRole`, and it is the only path from a body to a row.

`conferral.test.ts` also asserts, by scanning the tracked tree, that the cast which would defeat the
brand is written in exactly one file — `conferral.ts` itself. That is a string scan and is declared
as one; ADR-0030 does not apply to it, because the type system is what stops the other spellings.

## Decision 4 — the cost, stated rather than discovered

The matrix `conferralMatrix()` derives (there is no list of pairs in any test):

| caller \\ requested | owner | admin | builder | viewer |
| --- | --- | --- | --- | --- |
| owner | allow | allow | allow | allow |
| admin | **deny** | allow | **deny** | allow |
| builder | deny | deny | allow | **refuse** |
| viewer | deny | deny | deny | allow |

Two cells are product consequences and not only code ones:

* **`admin → owner` denies.** That is the fix.
* **`admin → builder` denies too**, because §21's Admin clause omits `skills` and `files` and
  §21's Builder clause names both, so an Admin conferring Builder would hand out a capability the
  Admin has not got. An Admin may still confer Admin and Viewer. This follows from Decision 2 of
  the permission-split ADR; the day §21's reading changes there, this matrix changes with it, and
  there is no second place to edit.

## What this decision does not give you

* **It does not stop an Admin from *removing* a capability.** Demoting an Owner to Admin is a
  conferral of `admin`, which an Admin may make. Only the last-Owner guard stands in the way of an
  Admin demoting the workspace's Owners one at a time, and that guard is about the *count* of
  Owners, not about who is doing the demoting. Carried as a declared gap, not fixed in this round.
  **Closed (2026-10-16):** `changeMembershipRole` and `deleteMembership` now refuse `403
  forbidden_role_conferral` unless the caller could confer the target's *current* role.
* **It says nothing about which rows a caller may act on.** Whose membership row is being patched
  is `decide`'s `ownership` question, and `PATCH /api/memberships/:id` passes `unknown` — which
  denies for every grant narrower than `any`, and §21 gives Owner and Admin `any` over
  `memberships`. So an Admin may patch any member's role, subject to the rule above.
* **It is a check on the role in the *body*.** A role that arrives any other way — a token, a
  seed, a database row — is `parseRole`'s business, and `parseRole` still refuses anything that is
  not one of the four.
