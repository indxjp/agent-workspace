# L-authz-run-token — run and browser token authentication

## Scope

`Authz/RunToken.lean` models the gateway run-token claims schema, issuance, verification verdict,
strict expiry, the tenant-scoped token registry, revoke-one and revoke-for-run, gateway
authentication in its first-failure order, the gateway error envelope, and the runner transcript
principal's claim-to-row check. It separately models the browser-token resolver's current
terminal-run and archived-session refusal and the documented read/follow target.

The HMAC primitive is an external cryptographic assumption. The Lean model starts at the signature
verdict and does not claim to prove unforgeability of SHA-256. The differential suite drives the
real Web Crypto codec, including a correctly signed payload with invalid claims and a payload
signed under the wrong key.

## Theorems and vectors

- T0: claims codec round trip, strict unknown-key and equal-expiry rejection, TTL bounds, blank
  subject rejection, and issued timestamp calculation.
- T1: gateway first-failure order and error envelope; repository revoke outcomes; runner row
  identity checks.
- T3: an expected run-id mismatch is denied before resolver use; revoked or expired repository
  rows cannot authenticate; an inactive token cannot become a runner principal.
- T4: the current browser-token resolver refines the documented read target, with a terminal-run
  witness where current resolution refuses and the target would allow. Archived sessions are
  refused by both.
- Vectors: `claims.json`, `issue.json`, `verify.json`, `gateway.json`, and `browser.json`. The first four replay
  against the public exports of `@agent-workspace/gateway` and `/tokens`; the last drives the real
  `installRbacApi` composition and PostgreSQL repositories in `apps/web/formal`.

## Finding

**Point 5 — current/target divergence.** `resolveBrowserTokenActor` refuses a run-scoped browser
token as soon as its run is terminal. SPEC §3.1.1 promises that the token can read and follow its
run, and the SDK's `waitForOutcome` performs a final run read after following. A run that settles
between follow and that read produces a 401 from the current resolver. The Lean witness is
`terminal_run_read_diverges`; `browser.json` and the PostgreSQL replay pin the current refusal.
Triage owns the decision whether to extend read/follow access after terminal status.

## Verification

Named Lean targets `AgentWorkspace.Theorems.Adversarial.AuthzRunToken` and
`Vectors.AuthzRunToken` build after restoration. The family vectors were generated and the
differential replay passed 25 tests; four PostgreSQL browser-token cases were skipped because
`TEST_DATABASE_URL` is absent. Seven definition mutations were killed by theorem failures:
TTL upper bound, claims expiry ordering, issue expiry arithmetic, verify expiry boundary, gateway
run-mismatch status, runner workspace identity, and terminal browser-token refusal. The first
mutation pass revealed the missing exact verification-expiry boundary theorem; that theorem was
added before the successful 7/7 pass. The original definition bytes were restored and rebuilt.
An independent pass found six surviving definition changes: unsafe `issuedAt`, invalid verdict
precedence over expiry, registry workspace and token-hash guards, revoke-by-run workspace guard,
and runner-principal session equality. Direct T0/T1/T3 properties with valid and invalid witnesses
now kill all six. The source was restored and the named vector target rebuilt. The combined
ContractsRuns/AuthzRunToken/RunCompose `lake exe axioms` audit passed for 1,315 declarations,
`lake exe imports` passed for 30 edges, and 93 citations resolved. The focused combined replay
passed 109 tests with five service-backed tests skipped because `TEST_DATABASE_URL` was absent.
Concrete T3 witnesses show a matching registry row active before revocation and expiry, then
inactive after revocation or at the exact expiry instant.

## Limits

`createGatewayApplication` does not expose the optional `expectedRunId` argument of its internal
`authenticateGatewayRequest` call. This unit proves the mismatch branch in Lean and relies on the
existing direct test in `packages/gateway/src/auth.test.ts` for TypeScript evidence; the unit's
public-export gateway vectors cover every other error branch. `RunTokenRepository` is a pure
transition model here. Its PostgreSQL behavior is tested in the core package's repository suite,
not replayed by this unit. The runner principal is modeled field by field but not driven through
`installSessionTranscripts`, which also starts the transcript retention scheduler. These are
coverage limits, not assertions that the corresponding checks passed.

## Coverage against D1

| Checklist                            | Evidence                                                                           | Limit                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| AZ-26 browser resolution             | `browserCurrent`, `browserReadTarget`, T4 divergence, PostgreSQL vectors           | Requires `TEST_DATABASE_URL`.                                                 |
| AZ-27 claims codec, issue and verify | `claimsShape`, `issueClaims`, `verifyVerdict`, T0, signed claims and issue vectors | HMAC security is assumed by Lean and exercised by real Web Crypto.            |
| AZ-28 gateway order and codes        | `authenticate`, `gatewayEnvelope`, T1/T3, gateway vectors                          | Public export does not pass `expectedRunId`; package-local test exercises it. |
| AZ-29 registry                       | `isActive`, `revokeOne`, `revokeForRun`, T1/T3                                     | No PostgreSQL replay in this unit.                                            |
| AZ-30 runner principal               | `runnerPrincipal`, T1/T3                                                           | The transcript composition is not started by this unit.                       |
| S-6, S-7, S-15                       | `terminal_run_read_diverges`, browser vectors                                      | Requires triage of the read and terminal-expiry sentences.                    |
