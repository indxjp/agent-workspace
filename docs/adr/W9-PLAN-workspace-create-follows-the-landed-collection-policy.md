# ADR-W9-PLAN — Workspace creation follows the landed collection policy

Status: accepted
Date: 2026-09-12
Decided by: the Wave 9 orchestrator, at the renewed W9.6 pre-flight
Scope: the `W9-UI-120` minimum implementation and verifier attack; the API landed by `W9-WS-119`

## Context

The `W9-UI-120` verifier attack grouped create with rename and archive and required all three
controls to be absent for a Builder, followed by direct server refusals. That premise is false on
`main`.

`POST /api/workspaces` deliberately uses the `not-applicable` collection ownership shape. The
`WORKSPACE_MEMBER_SCOPED` grant allows that shape for every current role, and the route creates a
new workspace with the caller as its sole Owner. The route and policy comments both state that
#119 places no role gate on creation. Rename and archive remain Owner-only operations on an
existing target workspace.

Issue #120 requires that an Owner can create and that unauthorised controls are absent; it does not
require that only an Owner of the current workspace may create a different workspace. A UI-only
task cannot change the API or policy, and hiding a server-authorised operation would make the
client carry a contradictory role table.

## Decision

The workspace screen shows create to any authenticated current member. A successful create makes
that caller the new workspace's sole Owner, matching #119. Rename and archive controls are shown
only for an Owner membership of the target workspace and remain server-authoritative.

The verifier attack is corrected: as a Builder, create through the UI and directly through the API
and assert success plus sole-Owner membership; assert rename and archive controls are absent and
the corresponding direct requests are refused.

## Alternatives rejected

- **Hide create for every non-Owner.** Rejected because it contradicts the landed API and duplicates
  policy in the client.
- **Change `POST /api/workspaces` to Owner-only.** Rejected because no current workspace can confer
  authority over creating a distinct tenant, and the UI task owns none of that route or policy.

## Consequences

The W9-UI-120 branch needs no server change. Its tests must distinguish collection creation from
target-workspace administration rather than treating every workspace write as one capability.
