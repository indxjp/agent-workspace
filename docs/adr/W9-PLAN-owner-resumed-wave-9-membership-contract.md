# W9-PLAN — Owner-resumed authority for the Wave 9 membership contract

Status: accepted — amends W9-PLAN-owner-directed-documentation-only-pause
Date: 2026-09-13
Decided by: Owner instruction in issue `#181`, recorded by the W9.7a landing task
Scope: issue `#181`; the membership-contract step of the Wave 9 resumption, and nothing else

## Context

[W9-PLAN-owner-directed-documentation-only-pause](W9-PLAN-owner-directed-documentation-only-pause.md)
records the Owner's direction to pause Wave 9 implementation after W9.6: not to implement #124 or
#122, and not to merge, close or otherwise modify PR #177, without renewed Owner authority.

Issue #181 is that renewed authority. The Owner opened it as step 1 of 10 of a Wave 9 resumption,
asking for the joined user name to land in the workspace-scoped `GET /api/memberships` response, for
PR #177 to be repaired or replaced and any superseded PR closed with a pointer, and for the pause
history to be preserved while the planning text records the resumed authority and the actual
evidence.

The pause ADR is therefore neither wrong nor withdrawn. It described a state that held, and the
documentation written under it recorded that state honestly. What has changed is the authority, and
only for one named step.

## Decision

The documentation-only pause is amended, not revoked, and the amendment covers the membership
contract alone.

- Authorised by #181: land `users.name` in the membership summary at the port, both adapters and the
  HTTP body, with its tests and its own ADR
  ([W9-PLAN-membership-list-must-return-the-joined-user-name](W9-PLAN-membership-list-must-return-the-joined-user-name.md)).
- Authorised by #181: replace PR #177 rather than restack it, and close #177 as superseded with a
  pointer to the replacement. The branch `aw/w9-7-membership-name-contract` is left in place, because
  the Wave 9 manifest cites it as evidence and deleting it would break that citation.
- Still paused: #124 and #122. Neither is implemented here, #122 is explicitly not closed here, and
  the Wave 9 exit criterion stays `Met: no`.
- The pause ADR's Context, Decision, Alternatives and Consequences are left byte-identical. The
  amendment is a pointer on its `Status:` line, so the pause history reads as what it was rather than
  as something later rewritten.

This landing is planned as the serial level `W9.7a`, task `W9-INT-181`, rather than as a new row on
the existing parallel `W9.7` level: the task owns `packages/core/src/db/**` files that W9-PROJ-124
already claims there, and serialising the gate is what makes the two disjoint instead of overlapping.

## Alternatives considered

- **Record renewed authority for the whole ten-step resumption programme.** Rejected as the default:
  this change can evidence one merged step, and an ADR that authorised nine unlanded ones would be
  claiming a state no gate on this PR can measure. Later steps record their own authority.
- **Rewrite the pause ADR to say the pause is over.** Rejected: #181 asks for the pause history to be
  preserved, and an ADR rewritten to match a later decision stops being a record of the earlier one.
- **Supersede the pause ADR outright.** Rejected for the same reason plus a practical one — #124 and
  #122 are still paused by it, so most of it is still in force.
- **Restack and repair PR #177 instead of replacing it.** Rejected: its documentation half needed
  rewriting against `main`'s pause narrative either way, and its head already carried a round-1
  verification FAIL plus a body-only evidence correction. The acceptance criterion asks for one exact
  final head with CI green and a verifier PASS, which a clean head makes unambiguous.

## Consequences

Wave 9 remains open and paused, with one authorised exception now landed. The manifest and status
ledgers stop describing PR #177 as open and awaiting authority, and describe it as superseded and
closed with a pointer instead — without restating the pause as if it had never happened.

Any further Wave 9 implementation still needs its own Owner direction. This ADR is not a general
resumption of development.
