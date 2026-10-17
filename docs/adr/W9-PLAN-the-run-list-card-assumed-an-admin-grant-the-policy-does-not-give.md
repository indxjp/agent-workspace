# ADR-W9-PLAN — The run-list card assumed an Admin grant the policy does not give; W9.6 cards are re-read against the landed APIs

Status: accepted
Date: 2026-09-12
Decided by: the Wave 9 orchestrator, at W9.6 pre-flight
Scope: the `W9-RUNS-135` card (a false premise, corrected after landing); the `W9-UI-120` and `W9-UI-136` cards (clarified before dispatch); follow-up issue `#165`

## Context

The `W9-RUNS-135` card said `GET /api/runs` "reuses the existing `runs` classification … `any` for
Owner/Admin, `own` for Builder/Viewer". `apps/web/server/rbac/permissions.ts` has never said that:
Admin's `runs` entry is `OWN_READS` (W2-CP-06's reading of spec §21, which gives Admin no clause
about sessions or runs). The verifier of PR #163 found the mismatch in its first round; the task
could not change it because `permissions.ts` was `W9-WS-119`'s in W9.5 and is a repository-wide
policy file, so it landed as the policy stands — an Owner sees the workspace's history, an Admin
sees their own — and declared it. The product decision (does §21's Admin clause include reading run
history?) is filed as `#165` and is not made here.

Two W9.6 cards were written against the same plan snapshot and are re-read against what W9.5
actually landed before any agent is dispatched (§5.1 of the orchestration protocol):

- `W9-UI-120` says controls are "gated on server-returned capability data". `#119` returns no
  capability object; it returns `role` on every workspace item and body, and rename/archive are
  Owner-only `PATCH`. `apps/web/app/api/workspaces/**` is on no W9.6 Owns line, so the UI task
  cannot add a capability object and must not need one.
- `W9-UI-136` renders "user" and offers a `user` filter. With the policy as it stands the API
  narrows an Admin to their own runs and refuses `?user=` for every role but Owner.

## Decision

1. The `W9-RUNS-135` card is corrected in place to "`any` for Owner, `own` for Admin, Builder and
   Viewer", with a pointer to `#165`. The card is historical (the task has landed); the correction
   exists so the next reader of the plan does not inherit the false premise.
2. The `W9-UI-120` card names the `role` field as the capability data and states that no capability
   object is added by that task.
3. The `W9-UI-136` card states that the page renders exactly what `GET /api/runs` answers for the
   caller's role and shows the `user` filter control only when the server accepts it — the page
   never carries a client-side role table, so `#165` landing later changes nothing in the UI.
4. `#165` stays a follow-up. It edits `permissions.ts`, which is `W9-TEAM-121`'s in W9.6 and a
   nobody-owned policy surface otherwise; folding it into a UI task would widen an Owns line to
   make a file legal, which the ownership rule forbids.

## Alternatives rejected

- **Change `permissions.ts` in a W9.6 plan PR so `#136` ships workspace-wide history for Admin.**
  Rejected: it is a product decision about §21's Admin clause, not a planning correction, and an
  orchestrator-level PR is not the place to widen a role's grant.
- **Leave the cards as written and let the `#136` implementer discover the narrowing.** Rejected:
  a card whose premise the orchestrator already knows to be false is a planning defect, and
  §5.1 says it is amended before dispatch, never by a task agent.

## Consequences

- The `W9-UI-136` verifier's attack "as an Admin, assert the history is workspace-wide" — if a
  verifier derives one from the issue text — is answered by this record, not by the code: the
  correct observation for an Admin today is their own runs.
- When `#165` lands, `GET /api/runs` widens for Admin and the Runs page follows without a change.
