# ADR-W9-PLAN — The live egress P0 is a serial gate before W9.6

Status: accepted
Date: 2026-09-12
Decided by: the Wave 9 orchestrator, after the pre-landing review surfaced a live defect
Scope: issue `#168`; the W9.5a wave row, ownership table, task card, dependency graph and disjointness proof

## Context

The Wave 9 pre-landing security review reproduced a fail-open SSRF path on `main`. The shared egress
policy accepts the IPv4 this-network range and the IPv6 unspecified address, including URL-parser
canonical forms such as bare `0` and IPv4-mapped IPv6. On this host, a request to `0.0.0.0` reached a
service bound on loopback. The model-connection contract accepted the same production `baseUrl`, and
`guardedFetch` invoked its transport instead of refusing it. Issue #168 records the commands and
outputs and carries the `security` label.

The programme's stop rule requires a live security defect on `main` outside the current Wave 9 scope
to be filed as P0 and then stops execution. The Owner subsequently authorised expanding the plan and
completing the work end to end. The defect therefore needs an explicit task and ownership partition
before W9.6 implementation continues.

## Decision

Issue #168 joins the plan as the serial W9.5a gate `W9-SEC-168` on branch
`aw/w9-sec-168-unspecified-egress-addresses`.

The task owns only:

- `packages/core/src/net/egress-policy.ts`
- `packages/core/src/net/egress-policy.test.ts`
- `docs/adr/W9-SEC-168-*.md`
- the generated `docs/adr/README.md`

It adds no migration and changes no caller. The existing callers already route model-connection
validation and provider traffic through this policy.

`W9-SEC-168` is implemented, independently verified, merged, and its issue is closed before the
original W9.6 tasks are dispatched or resumed. Those branches are then brought to the new `main`.
This converts the previous stop condition into planned work without letting unrelated UI work
proceed while a known production SSRF bypass remains live.

The partition is disjoint from every W9.6 task. `W9-TEAM-121` owns
`packages/core/src/db/**`, while the new task owns the named source and test under
`packages/core/src/net/`; the UI tasks own only web shell/run paths and their declarations. The migration owner remains
`W9-TEAM-121`.

## Alternatives rejected

- **Fix the files in an orchestrator-only plan PR.** Rejected because the implementation requires
  its own issue PR, CI signal and independent verifier PASS.
- **Dispatch the security task and W9.6 together.** Rejected because the stop condition is about
  exposure on `main`, not ownership collision. Parallel UI work would leave the known bypass live
  for longer and complicate the evidence boundary.
- **Fold the fix back into the already-landed #127 PR.** Rejected because #127 is merged and closed;
  rewriting its branch would destroy the audit trail for a defect found later.

## Consequences

Wave 9 gains a serial non-migration gate between W9.5 and W9.6. The original task branches may be
reused only after confirming their state and merging the new `main` into them. The manifest records
#168 as a pre-landing-review finding that was fixed before programme close-out.
