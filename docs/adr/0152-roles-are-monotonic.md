# ADR-0152 — Roles are monotonic

Status: accepted
Date: 2026-10-18
Decided by: Owner (engineering-audit owner decision D2, finding F-21)
Scope: `apps/web/server/rbac/permissions.ts`, `formal/AgentWorkspace/Authz/**`, spec §21, `docs/sdk/04-api-specification.md` §3.3; extends ADR-0116

## Context

Spec §21 lists what each of the four roles may do, one clause per role, and introduces the list
with the word "Suggested". `permissions.ts` reads each clause literally where §21 is silent. Read
that way, a lower role sometimes held a grant a higher role lacked. ADR-0116 fixed this for Admin's
`skills` and `files`. A property test written for the engineering audit found four cells that were
still inverted:

| Cell             | Higher role   | Lower role         |
| ---------------- | ------------- | ------------------ |
| `agents.run`     | Builder `own` | Viewer `permitted` |
| `connectors.run` | Admin `none`  | Builder `own`      |
| `projects.read`  | Admin `none`  | Builder `own`      |
| `projects.write` | Admin `none`  | Builder `own`      |

The `agents.run` cell had a visible effect. An `agent_grants` row let a Viewer run an agent, but
the same row did not let a Builder run it, because `own` does not admit a `permitted` ownership
fact. The other three cells also had a visible effect: `conferRole` refused to let an Admin confer
Builder, and refused to let a Builder confer Viewer, because neither role held everything the role
below it held.

## Decision

**Roles are monotonic.** In the order Owner, Admin, Builder, Viewer, each role holds at least
every grant of every role after it, on every resource and every operation. When a cell would
break this, we raise the higher role. We never lower the other role. This follows ADR-0116.

The corrections (the four the audit found, and `triggers.run`, which appeared after it):

- Builder `agents`: `{ read: any, write: own, run: permitted }`, and `permitted` now means "own or
  granted": `applyGrant` admits a `permitted` grant for ownership `own` as well as `permitted`.
  A Builder runs the agents it owns and the agents an `agent_grants` row names, and no other
  agent. Before, Builder held `OWN_WRITES` and could not run an agent it had been granted.
- Admin `connectors`: `EVERYTHING`. Before, Admin held `MANAGE`, which has no run verb.
- Admin `triggers`: `EVERYTHING`. Triggers (ADR-0144) landed after the audit with Admin `MANAGE`
  `{ any, any, none }`, Builder `OWN_WRITES` `{ any, own, own }` and Viewer none, which is the
  same inversion as `connectors`. `EVERYTHING` is the smallest of the named grant shapes that
  covers Builder's `run: own`; `{ any, any, own }` would also cover it, but that is not one of the
  named shapes, and Admin holds every other resource it manages workspace-wide as `MANAGE` or
  `EVERYTHING`. No route classifies as `run` on triggers, so this cell changes no reachable
  decision.
- Admin `projects`: `MANAGE`, so Admin reads and writes every project. A project has nothing to
  run, and Builder holds no run verb on projects either.

`permitted` appears only on the `agents.run` cells of Builder and Viewer, so widening it to admit
`own` changes nothing else. Admin's `any` still covers it.

`permissions.test.ts` asserts the rule over every cell, and so does the formal model's
`roles_are_monotonic`. A new cell that breaks the rule fails both.

### Alternatives rejected for `agents.run`

- **Give Builder `run: any`.** This covers `permitted` too, but it lets every Builder, and every
  Builder API key, run any agent in the workspace. It would also remove two guards: a Builder
  could bind another member's agent to its own endpoint client (issue #949), and OAuth consent
  would no longer refuse such an agent. D2 asks only that Builder hold what Viewer holds, which
  is "own or granted". ADR-0116 widened Admin to `any` because Admin manages the whole workspace;
  that reason does not apply to Builder.
- **Make `own` admit a `permitted` ownership fact.** This changes what `own` means on every
  resource that uses it, not only on this one cell.
- **Add a grant width for "own or permitted".** This adds a fifth width that `decide`,
  `conferRole`, the formal model and the documents would all have to learn. Making `permitted`
  admit `own` gives the same set of agents without a new width.

## Consequences

- A Builder named by an `agent_grants` row can run that agent and bind it to an endpoint client.
  A Builder still may not run or bind an agent it neither owns nor was granted.
- A Viewer who owns an agent, for example after being demoted from Builder, can now run it.
- An Admin can confer Builder. The conferral matrix is now the ladder: a role may confer itself
  and every role below it. An Admin still may not confer Owner, because Owner holds `secrets`.
- `conferRole`'s `undecidable` answer (`own` against `permitted`) stays in the code, but no pair of
  the four roles reaches it.
- An Admin can list, read, edit, archive and restore every project. `GET /api/projects` already
  listed every project for an Admin. The table now agrees with it.
- In the formal model, `roles_are_monotonic` replaces `admin_is_not_above_builder_exactly_at`
  and `builder_is_not_above_viewer_exactly_at_agent_runs`.
  `granted_builder_runs_the_agent_a_granted_viewer_can` replaces
  `granted_builder_cannot_run_the_agent_a_granted_viewer_can`, and
  `permitted_grant_admits_own_and_permitted` replaces `permitted_grant_admits_exactly_permitted`.

## Amendment (2026-10-19, PR #1467): dominance is the `Grant.le` order

The consequence above that `conferRole`'s `undecidable` answer stays in the code no longer holds.
`dominates` now compares widths by their rank in the formal model's `Grant.le` order: `none`, then
`own`, then `permitted`, then `any`. That order covers every pair of widths, so `undecidable` was
removed. A `permitted` holder may confer `own`, and an `own` holder is denied `permitted`.
`conferRole` still refuses a caller role or a requested role that is not one of the four. The
decision above is unchanged.
