# Security review 0.1.0

Review date: 2026-09-09  
External-contract basis: the release-boundary research note  
Coverage digest: `sha256:a6206ebfa1e4aee571781cca58f76b6ede0d5b82e60d4dda2a5f0fb2af6fb101` (58 rule lines)

The review covers every rule line in §20.6 and §23–§26. The digest is over the ordered
`section + NUL + trimmed line` records produced by `tests/security-review/evidence.test.ts`; a spec
line added, removed, or changed invalidates this review until it is classified again.

## Findings

| Id     | Spec rules                            | Code path                                                                                                       | Command | Output | Verdict                                                                                                                                |
| ------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-01 | §23, all rule lines                   | `packages/core/src/config.ts`; `packages/runtime/src/env.ts`; `apps/web/server/compose/run-request.ts`          | CMD-01  | OUT-01 | Pass — provider master credentials are refused and only assigned secrets enter a run.                                                  |
| SEC-02 | §24 and §26, all rule lines           | `packages/gateway/src/auth.ts`; `packages/gateway/src/tokens/run-token.ts`; `apps/web/server/gateway/issuer.ts`; `packages/core/src/db/repositories/run-tokens.ts` | CMD-02  | OUT-02 | Pass — issued token IDs and bearer digests are registered durably, checked on every gateway request, individually revocable, and revoked when a run terminates. |
| SEC-03 | §25, all rule lines                   | `apps/runner/src/runtime.ts`; `apps/runner/src/session.ts`; `packages/runtime/src/env.ts`                       | CMD-03  | OUT-03 | Pass — distinct session paths and durable session boundaries are exercised.                                                            |
| SEC-04 | §20.6, snapshot and policy rule lines | `apps/web/server/shares/**`                                                                                     | CMD-04  | OUT-04 | Pass for the implemented snapshot, definition, policy, and runnable-share controls.                                                    |
| SEC-05 | §20.6, runnable-link scope            | `apps/web/app/p/[token]/messages/route.ts`; `apps/web/server/shares/runnable/feature.ts`; `apps/web/server/shares/core/service.ts` | CMD-05  | OUT-05 | Pass — runnable creation and execution fail closed by default and the shipped share dialog offers definition sharing only, matching D-06. |
| SEC-06 | §24, network enforcement lines        | runtime drivers and deployment network boundary                                                                 | CMD-06  | OUT-06 | Not verifiable here — repository tests decide configuration, not each unavailable host or cluster lifecycle.                           |

## Reproducible evidence

### CMD-01 / OUT-01

```text
pnpm vitest run packages/runtime/src/env.test.ts packages/core/src/config.test.ts apps/web/server/compose/run-request.test.ts --reporter=dot
Test Files  3 passed (3)
Tests       57 passed (57)
```

### CMD-02 / OUT-02

```text
pnpm vitest run packages/gateway/src/auth.test.ts --reporter=dot
Test Files  1 passed (1)
Tests       4 passed (4)
```

### CMD-03 / OUT-03

```text
pnpm vitest run apps/runner/src/runtime.test.ts apps/runner/src/session.test.ts --reporter=dot
Test Files  2 passed (2)
Tests       37 passed (37)
```

### CMD-04 / OUT-04

```text
pnpm vitest run apps/web/server/shares --reporter=dot
Test Files  3 passed (3)
Tests       5 passed (5)
```

### CMD-05 / OUT-05

```text
git ls-files apps/web/app/p/[token]/messages/route.ts apps/web/server/shares/runnable/service.ts
apps/web/app/p/[token]/messages/route.ts
apps/web/server/shares/runnable/service.ts
```

### CMD-06 / OUT-06

```text
gh secret list --json name
[]
No provider credential or managed-runtime credential is available for a live external enforcement probe.
```

## Coverage partition

Every extracted rule line is assigned by section to exactly one finding row. General labels and
examples remain in the same bucket as the rule they introduce; they are not silently dropped.

| Section | Bucket | Finding           | R-17 classification                                  |
| ------- | ------ | ----------------- | ---------------------------------------------------- |
| §20.6   | cited  | SEC-04 and SEC-05 | repository, with external provider spend unavailable |
| §23     | cited  | SEC-01            | repository                                           |
| §24     | cited  | SEC-02 and SEC-06 | repository plus running-external-system enforcement  |
| §25     | cited  | SEC-03            | repository                                           |
| §26     | cited  | SEC-02            | repository                                           |

No line is classified as not-a-rule. The deployed network-enforcement portion of §24 is classified
not verifiable here by R-17, but its rule lines remain cited by SEC-06 so no line occupies two
buckets.

## Sharing review and D-06

The snapshot and definition-sharing implementation has server-side sanitation, revocation, expiry,
and policy tests. Runnable-link code remains dormant for later review, but D-06 is now enforced at
three boundaries: the share service refuses runnable creation unless an explicit server-side flag is
enabled, the public message route returns a not-found refusal while disabled, and the shipped share
dialog offers definition sharing only. Existing runnable rows therefore cannot execute by default.

## External claims

All external-system claims used by this review come from
the release-boundary research note. In particular, the proxy placement is from
that note's credential finding and the deployed-driver limitation is from its Sandbox Runtime
finding. This review adds no external contract from recollection.

## Residual risks

| Id      | Severity | Risk                                                                                                                                     | Accepted-by |
| ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| RISK-01 | Medium   | Mitigated — token IDs and bearer digests are durable; the gateway checks revocation per request, and repository operations support individual and terminal-run revocation. |             |
| RISK-02 | High     | Mitigated — D-06 is enforced by default-deny service, route, and UI gates; runnable implementation is dormant unless an operator explicitly enables it. |             |
| RISK-03 | High     | Live provider and deployed-runtime enforcement were not exercised because the required credentials and external systems are unavailable. |             |

Acceptance status: **not accepted**. Plan D-10 applies in its own words: **Release blocked until
signed**. An agent cannot fill the `Accepted-by:` fields or substitute its judgement for the Owner's
written acceptance.
