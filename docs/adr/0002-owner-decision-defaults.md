# ADR-0002 — Plan §11 Owner decisions are taken at their stated defaults

Status: accepted
Date: 2026-09-03
Decided by: orchestrator
Scope: whole programme

## Context

Plan §11 lists twelve PL-3 decisions that need a human, each with "a default that applies
automatically if the Owner has not decided by the stated wave" — designed so an unanswered
question delays a decision, not the programme. The Owner has instructed that execution runs
without stopping to ask ([ADR-0004](0004-autonomous-execution.md)).

## Decision

Every §11 row is taken at its stated default unless the Owner says otherwise. Applied so far:

| # | Decision | Value taken |
| --- | --- | --- |
| D-01 | Licence | Apache-2.0 |
| D-02 | Package scope / product name | `agent-workspace`, npm scope `@agent-workspace/*` |
| D-08 | Anthropic API budget in CI | Integration tests on demand, not per PR |

The remaining rows are taken at their defaults as their wave arrives, and each is recorded
here at that point rather than in advance — a default taken before its wave is a guess.

## Alternatives considered

- **Block on each row.** Rejected: it is exactly what §11's default mechanism exists to avoid,
  and the Owner has closed the asking route.
- **Take all twelve now.** Rejected: D-04 (which managed sandbox driver) and D-11 (first real
  deployment target) depend on facts research notes R-07…R-11 have not yet established.

## Consequences

- D-04's default is "no managed driver in 0.1.0", so Wave 6 ships `docker` + `kubernetes` only
  unless the Owner intervenes. That is a real product reduction and it is being taken silently
  by default — which is precisely why it is written down here.
- D-10 (acceptance of residual security risk) has default "release blocked until signed". No
  default can substitute for a signature, so v0.1.0 cannot be tagged autonomously. Wave 8 will
  produce the signed risk list and stop at the signature.
