# ADR-0064 — D1 public contract choices after the formal runs review

Status: proposed
Date: 2026-09-24
Decided by: pending Owner decision
Scope: run HTTP responses and SSE frames, browser-token lifetime, SDK decoding and run cost, RBAC policy, CLI exit behavior

## Context

The D1 [triage](../formal/domains/d1-runs-triage.md) separated repairs that preserve the current
public contract (PRs #282–#294) from disagreements whose resolution changes, or could change, a
shipped contract. The latter cannot be silently folded into a formal-model update. Each numbered
choice below is independent; the Owner can accept, reject or amend it separately. This ADR records
the current behavior and the proposed next action, rather than treating a proposed choice as shipped.

## Decisions requested

| Case | Current behavior | Proposed decision | Consequence if accepted |
| --- | --- | --- | --- |
| F-084, additive responses | Strict exported response schemas and SDK problem decoding can reject an added outer or inner field, losing a known problem code. | Make SDK response decoding tolerant of unknown additive fields while preserving known fields and stable error codes. Keep strict request validation. Decide separately whether exported response schemas should become tolerant. | Add old-client/new-response regressions, then release SDK and server compatibility guidance together. |
| F-088, agent grants | Builder's `own` run grant rejects a `permitted` agent; Viewer's `permitted` grant accepts it. | Let Builder's agent run grant admit both owned and explicitly granted agents, amending W9-AUTH-117. | Change the RBAC decision and add Builder/Viewer grant regressions. |
| F-097/F-102, terminal browser tokens | Terminal runs are refused at token resolution, but token rows remain active; a token holder cannot perform the SDK's final GET after terminal completion. | State whether terminality means effective refusal or persisted row revocation, and whether a run-scoped token may make one final read. Prefer explicit terminal refusal and have browser-token consumers use a different authorized principal for final record reads. | Align token lifetime prose, SDK guidance and either persisted revocation or final-read behavior; add terminal-token integration tests. |
| Suspicious point 4, unknown stream outcome | An indeterminate final lookup emits `run-failed` with `status: unknown` followed by `done`; `follow` stops and `waitForOutcome` may reject a live run. | Do not emit `done` until the run is terminal when the outcome is unknown. Let `follow` reconnect from its cursor after the connection ends. | Changes SSE completion semantics; add real stream and SDK reconnect regressions before release. |
| Suspicious point 8, run request errors | Run routes collapse unsupported media type, oversized body and malformed body into `400 invalid_body`; the documented vocabulary and RBAC routes distinguish them. | Return the documented 415, 413 and malformed-body response on run routes. | Changes shipped HTTP status and code; add route parity regressions and update clients. |
| Suspicious point 17, revoke outcome | Zero revoked rows return `already-revoked`, including a run that never minted a token. | Preserve the current outcome spelling and document that it means no active matching token was revoked. A distinct never-minted value would require a versioned wire change. | Documentation only if accepted; no product change. |
| Suspicious point 23, CLI terminal exit | `aw runs wait` exits 0 after a resolved failed or cancelled run and prints its status. | Preserve this process-exit contract; callers branch on the printed run status. A nonzero terminal exit needs a separately approved CLI change. | Documentation only if accepted; no command-tree change. |
| F-067, cost amount | `RunCostSchema` accepts any nonempty amount, while settlement validates decimal text. | Use one decimal predicate at contract and settlement boundaries. | Tightens a public response schema; add contract and server regressions before release. |

## Related decisions

- [FORMAL-P1-documented-row-invariants-are-checks](FORMAL-P1-documented-row-invariants-are-checks.md)
  already proposes the six possible database checks and migration for F-076. Each check needs a
  direct PostgreSQL write regression and Owner ratification before a schema change.
- F-098's meaning of `running` during preparation and point 27's distinction between Admin
  transcript reading and session continuation can be resolved in prose if the Owner confirms the
  current behavior. D3 owns the token-handler body/authentication precedence in point 19.
- The D1 private security finding is withheld; see the private ledger. It is outside this ADR.

## Consequences

No product behavior changes by merging this proposed ADR. The D1 model records current behavior
until each choice is accepted and implemented with a failing regression, an updated theorem and
regenerated vectors. The formal domain remains open for these decisions.
