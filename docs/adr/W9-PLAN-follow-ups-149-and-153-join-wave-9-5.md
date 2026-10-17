# ADR-W9-PLAN — The two follow-ups filed by Wave 9 work (#149, #153) join W9.5

Status: accepted
Date: 2026-09-12
Decided by: the Wave 9 orchestrator (plan amendment, before W9.5 dispatch)
Scope: the Wave 9 plan — the W9.5 wave row, Ownership table, shared-file table, two new task cards (`W9-SEC-149`, `W9-PROJ-153`), gap G-12 and the W9.5 disjointness paragraph

## Context

Two issues were filed *by* Wave 9 work rather than folded into the PR that found them:

- **#149 (P0)** — every `/api/model-connections*` route is authorised by workspace membership
  alone; a Viewer can repoint a connection's `baseUrl`, rotate its credential, or delete it (which,
  since #129, nulls the workspace and project default model in the same transaction). Surfaced by
  W9-PROV-128, whose card forbade widening into the files that own the defect.
- **#153 (P1)** — `parseProjectPatch` accepts only the keys it knows and silently drops
  `defaultModelConnectionId` / `defaultModel`, so #130's project default-model control has a UI
  and a resolution path but no write path. Neither W9-PROJ-125 nor W9-MODEL-130 owned both halves.

The Wave 9 status report §5 records both as "not in any wave yet" and says #149 "should
be scheduled before the remaining UI work compounds on top of it". The wave plan had no slot for
either.

## Decision

**Both join W9.5**, as `W9-SEC-149` and `W9-PROJ-153`, each with a full six-field task card.

The ownership argument, re-verified mechanically against `main` at `05f9218` (`git ls-tree` per
glob, `node scripts/check-wave-ownership.mjs <Wave 9 plan>` after the edit):

- `W9-SEC-149` owns `apps/web/app/api/model-connections/**`, `apps/web/server/models/**` and the
  single composition file `apps/web/server/composition/services.ts` (where `installModelsApi`'s
  `resolveActor` discards the role). Those directories were W9-PROV-126's and W9-MODEL-129's, both
  landed; no W9.5 card names them. It reads `apps/web/server/rbac/decide.ts` and edits nothing under
  `apps/web/server/rbac/**`, which is W9-WS-119's this wave; the sub-resource declarations it needs
  (`credential`, `test`) already exist. An RBAC edit it cannot avoid is an escalation, not a wider
  glob.
- `W9-PROJ-153` owns `apps/web/server/projects/**`, `apps/web/app/api/projects/**` and
  `apps/web/contracts/projects*.ts`. W9-PROJ-125 held the first two in W9.4 and landed;
  W9-PROJ-124 takes them in W9.7. No W9.5 card names them. It edits nothing under
  `apps/web/components/**` — #130's save flow already sends the pair and verifies the response.
- Pairwise, the five W9.5 sets separate at the first differing path segment under
  `apps/web/server/` (`{rbac,workspaces}` / `runs` / `models` / `projects`), `apps/web/app/api/`
  (`workspaces` / `runs` / `agents` / `model-connections` / `projects`) and
  `packages/core/src/db/repositories/` (four file families). Only W9-WS-119 adds a migration.
- Five tasks × (implement + verify) is ten agents, inside the fifteen-agent guideline.

**Reads of `/api/model-connections` and `/api/models` stay membership-scoped (gap G-12).**
`apps/web/server/rbac/permissions.ts` grants Builder and Viewer nothing on `model-connections` or
`models` (both fall to the `none` fallback), while #130's `ModelSelector` reads both lists for every
role that composes a run. Moving reads onto `decide()` would therefore take model selection away
from every Builder and Viewer — a product regression #149's acceptance does not ask for ("can still
read the list *if the role model says it may*"). The write operations are gated in W9.5; the read
policy needs a `permissions.ts` decision, and that file has one owner per wave who is not this
task. The gap is declared, not approximated.

## Alternatives rejected

- **A separate W9.4b wave for the two follow-ups.** Costs one more serial CI/merge cycle and buys
  no ownership separation: the sets are already disjoint from W9.5's three, and neither task adds
  a migration. Rejected as pure latency.
- **Fix #149 inside W9-WS-119 (which owns `rbac/**`).** Rejected: it would put a models-runtime
  change under a workspace-lifecycle card, and the verifier attack for it belongs with the models
  routes. Ownership by directory is what keeps the attack targeted.
- **Move reads onto `decide()` too, and grant Builder/Viewer `model-connections` read in
  `permissions.ts` in the same PR.** Rejected: `permissions.ts` is W9-WS-119's this wave; a policy
  widening for a security fix is a decision the policy file's owner records, not a side effect of
  a route change.

## Honest cost

W9.5 grows from three tasks to five. Its verify stage takes longer, and it now has two Opus
verifiers (`W9-WS-119`, `W9-SEC-149`, `W9-PROJ-153` are security/lifecycle-bearing) instead of
one. A Viewer's read of provider connection names and readiness remains possible after #149 lands;
that is G-12, stated on the PR and in the manifest.

## Related

- [W9-PLAN-the-composition-root-moved-after-the-plan-was-written](W9-PLAN-the-composition-root-moved-after-the-plan-was-written.md)
  — why `W9-SEC-149`'s composition file is `services.ts` and not `instrumentation-node.ts`.
- [W9-PROV-128-controls-match-the-api-the-runtime-actually-enforces](W9-PROV-128-controls-match-the-api-the-runtime-actually-enforces.md)
  — the PR that surfaced #149 and declared it rather than folding it in.
- [W9-MODEL-130-project-default-write-awaits-sibling-patch-support](W9-MODEL-130-project-default-write-awaits-sibling-patch-support.md)
  — the client half of #153, already shipped.
