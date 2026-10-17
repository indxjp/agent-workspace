# ADR-W9-AUTH-165 — an Admin reads the workspace's run history; §21's silence on runs is read against the Admin sentences §21 does print

Status: accepted
Date: 2026-09-14
Decided by: W9-AUTH-165 (implementing agent)
Scope: `apps/web/server/rbac/permissions.ts` (the single cell `(admin, runs, read)`),
`apps/web/server/rbac/permissions.test.ts`, `apps/web/server/rbac/authorisation-matrix.test.ts`,
`apps/web/server/runs/api.ts`, `apps/web/server/runs/api.test.ts`

Amended by [SDK-03-RUN-235](SDK-03-RUN-235-an-interrupt-is-a-control-plane-transition.md):
Admin now has `run: 'any'` on runs and may interrupt a workspace run. This ADR's read-only
description and its statement that Admin cannot cancel a run describe the decision at the time;
the later ADR controls the current run verb. Ordinary `runs.write` remains `none`. Revoking run
tokens is a separate Owner/Admin capability, added to `decide()` in PR #294 (F-089).

## Context

Spec §21 names Admin's capabilities in one sentence — *"Users, agents, models, API keys,
connectors, runtimes."* (`docs/spec.md:1601-1603`) — and says nothing at all about **runs**.
W2-CP-06 read that silence the least-privilege way and classified `POLICY.admin.byResource.runs` as
`OWN_READS` (`{ read: 'own', write: 'none', run: 'none' }`), with the reason written into the table
itself: "§21 gives Admin no clause about sessions or runs, so an Admin has what every member has:
their own."

Issue #135 (W9-RUNS-135, PR #163) then shipped `GET /api/runs` against an acceptance criterion that
assumes the opposite reading — "Owner/Admin see allowed workspace history". Because
`decideRunListAccess` reads the *grant* `decide()` returns rather than the role name, and
`parseRunListQuery` treats every grant other than `any` identically, an Admin was routed through the
same forced-own-filter branch as a Builder. That task's verifier found the mismatch in its first
round and could not change it — `permissions.ts` is a repository-wide policy file owned by another
task in that wave — so it landed as gap **G-7** of
`docs/adr/W9-RUNS-135-durable-run-list.md:87-109`, with a named test pinning the narrower behaviour
"so that widening flips this named test". `docs/adr/W9-PLAN-the-run-list-card-assumed-an-admin-grant-the-policy-does-not-give.md`
filed the product decision as issue #165 and explicitly declined to make it.

This ADR makes it. The conflict to resolve is stated plainly: a least-privilege reading of §21's
silence versus the product expectation §21's own Admin role implies and #135 wrote down.

## Decision

**§21's silence on runs is read as "an Admin reads the workspace's run history."**
`POLICY.admin.byResource.runs` becomes the existing `READ_ONLY` constant
(`{ read: 'any', write: 'none', run: 'none' }`) — the same shape Admin already holds for `metrics`
and `sharing-policies`. Builder and Viewer keep `OWN_READS`; the shared constant itself is not
edited, only Admin's reference to it.

The reading rests on three sentences §21 does print:

1. **`docs/spec.md:1617`** — the sharing block: *"Admin  revoke or suspend **any** share in the
   workspace, see the shared-links page"*. §21 therefore already grants Admin a workspace-wide view
   of other members' artefacts, by name. A reading of §21's silence that leaves Admin at own-only
   everywhere contradicts an explicit workspace-wide Admin clause in the same section.
2. **`docs/spec.md:1622-1623`** — *"Publishing a **runnable** public link (section 20.6.3) requires
   Admin or Owner, because it spends the workspace budget on behalf of anonymous visitors."* §21
   names Admin as a role accountable for workspace budget spend. Run history is the persisted record
   of that spend — cost, tokens, accounting state, all of it rendered by `renderRun` — and an Admin
   who sees only their own runs cannot discharge the accountability §21 assigns.
3. **`docs/spec.md:1601-1603`** — Admin's own clause gives unqualified control of "agents", which
   `permissions.ts` already reads as `EVERYTHING`, including the `run` verb. Reading every execution
   record of a resource one may create, edit, delete and run is *narrower* than the powers Admin
   already holds, not wider.

Four things this decision deliberately does **not** do:

- **It is a `read` widening only.** `write` and `run` stay `none`, identical to `OWN_READS` in those
  two operations. An Admin still cannot start, cancel, or write a run through the `runs` resource.
- **It does not touch `sessions`.** Admin keeps `OWN_ONLY` there: §21's only sessions sentence is
  Viewer's, and issue #165's acceptance criteria name runs only. That cell is not a message-content
  boundary, and nothing here should be read as saying it is. The session routes never consult this
  table — `apps/web/server/composition/session-rbac.ts:79-85` wires `canAccessSession` as
  `session.userId === principal.userId || principal.role === 'owner' || principal.role === 'admin'`,
  so an Admin already reads every session in the workspace, `GET /api/sessions/:id/transcript`
  included. The `events` widening below is therefore the run-shaped view of access that role holds
  already, not a new class of access. That the `sessions` cell and the session routes disagree
  predates issue #165; it is its own decision and its own issue.
- **It does not touch Builder or Viewer**, whose forced own-filter and `403 user_filter_forbidden`
  guards in `apps/web/server/runs/api.ts` are unchanged and keep their existing tests.
- **It is not a tenancy change.** Workspace scoping is independent of this cell: `listRuns` is
  scoped by the store, and `findRunForPrincipal` still answers `404` for another workspace's run.

**It supersedes W2-CP-06's reading for exactly one cell.**
`docs/adr/W2-CP-06-the-four-roles-and-their-permission-split.md` is a dated record and is not
edited; `(admin, runs, read)` is the only pair whose classification this ADR changes, and the
comment in `permissions.ts` at that cell now carries this reading and this ADR's name. Gap **G-7**
of `docs/adr/W9-RUNS-135-durable-run-list.md` is closed by it.

**The width follows the resource, not the route, and that is wider than issue #165's own text
implies.** `read` is a `(role, resource)` grant, so `read: 'any'` on `runs` reaches all three run
read routes:

| Route | Before | After |
| --- | --- | --- |
| `GET /api/runs` | the Admin's own runs; `?user=` refused | every run in the workspace; `?user=<id>` accepted |
| `GET /api/runs/:id` | `403` for another member's run | `200` |
| `GET /api/runs/:id/events` | `403` for another member's run | `200` — the SSE transcript |

`events` is a declared sub-resource of `runs` and inherits its parent's grants by design
(`apps/web/server/rbac/permissions.ts`'s `SPEC_34_SUB_RESOURCES`: "§21 says nothing about events as
a capability of their own; they are the contents of the run, so reading them is reading the run").
Run events can carry prompt and response text, which makes the transcript the widest part of this
change — larger than issue #165's "no change to `GET /api/runs` itself is expected" suggests, though
not a new class of access for an Admin: every run row references a session
(`runs_session_workspace_fk`), and `canAccessSession` already admits an Admin to that session's
transcript, per the `sessions` bullet above. It is accepted here, named in the table above, and
pinned by tests in both the matrix and the runs suite rather than left to be discovered. Splitting
the sub-resource off so the list could widen while the transcript stayed narrow would need a
per-sub-resource grant mechanism the RBAC
table does not have — a repository-wide shape change introduced to make one cell fit, which
`CLAUDE.md` forbids; if that split is wanted it is its own issue and its own ADR.

## Alternatives rejected

- **Leave Admin own-only and amend #135's acceptance criterion instead.** Rejected: it makes the
  Runs screen useless for the role that administers models, API keys, connectors and runtimes, and
  the issue author framed the narrowing as the defect, not the criterion. This stays the reversible
  answer — it would be a documentation-only change — if the reading in §21 is ever re-decided.
- **Special-case `role === 'admin'` inside `apps/web/server/runs/api.ts`.** Rejected: it moves a §21
  decision out of the central table into one handler. The table is what the authorisation matrix
  reads and what every future route inherits; a route that answers a policy question locally is the
  shape ADR-0015 and the matrix exist to prevent.
- **Introduce a per-route or per-sub-resource grant so `GET /api/runs/:id/events` could stay narrow
  while the list widens.** Rejected here, for the reason given above.
- **Widen Admin's `sessions` in the same change.** Rejected as out of scope, and recorded above as
  a decision not made.
- **Give Admin `EVERYTHING` on `runs`, matching `agents`.** Rejected: nothing in §21 or in issue
  #165 asks for an Admin to cancel or write another member's run, and the narrowest change that
  satisfies the acceptance criteria is the read widening.

## Consequences

- `GET /api/runs` needs no change: `decideRunListAccess` returns the grant and `parseRunListQuery`
  already branches on `grant === 'any'`. This is what G-7 predicted, and the only edit in
  `apps/web/server/runs/api.ts` is to comments that stated the old width as fact.
- The Runs screen (#136) follows with no UI edit. `apps/web/components/run/history-screen.tsx`
  probes `/api/runs?limit=1&user=<probe>` and shows the `user` control only when the server accepts
  it, so the control appears for an Admin the moment this cell lands — the outcome
  `docs/adr/W9-PLAN-the-run-list-card-assumed-an-admin-grant-the-policy-does-not-give.md` planned
  for.
- The collection route's width cannot be stated by the authorisation matrix. `applyGrant` allows a
  grant of `own` for `not-applicable` ownership (`apps/web/server/rbac/decide.ts`), so
  `GET /api/runs × admin × not-applicable` answers `allow` at either width. The matrix's
  load-bearing cells are `GET /api/runs/:id` and `GET /api/runs/:id/events` × `admin` × `other`;
  the list's width is pinned behaviourally in `apps/web/server/runs/api.test.ts`. Both test files
  say so in a comment, so a future reader does not mistake the matrix's silence for coverage.
- Rollback is reverting one constant reference and its tests. No schema, no migration, no persisted
  state, no route, no dependency.
- A future reader will find two ADRs that disagree about `(admin, runs, read)`. That is why this one
  names W2-CP-06 and G-7 explicitly: the later record is the live one, and the earlier stays as the
  dated account of why the narrower reading was taken first.
