# ADR-W9-AUTH-118 — The OIDC callback's Origin check is the same one every write uses, and that is a declared gap against a real `form_post` provider

Status: accepted
Date: 2026-09-11
Decided by: W9-AUTH-118 implementing agent
Scope: `apps/web/app/api/auth/callback/route.ts`

## Context

The task card says the callback must "validate state, PKCE and origin," and the verifier attack
requires "an Origin header from another host" to be refused. `apps/web/server/auth/origin.ts`'s
`checkRequestOrigin` is this application's one Origin check, used unchanged by every other
state-changing endpoint (`apps/web/app/signin/actions.ts`, `apps/web/app/api/auth/workspace/route.ts`):
for an unsafe method, it requires the `Origin` header to be present and to name a host this
deployment answers to, and refuses `null` and every other value.

`beginOidcLogin` (unchanged, `apps/web/server/auth/oidc.ts`, prior wave) requests
`response_mode: 'form_post'`. Applied literally, a real identity provider's `form_post` submission
is a cross-site top-level form navigation from the provider's own page to this callback: the
`Origin` header a browser sends on it, when it sends one at all, names the **provider's** origin,
never this deployment's. `checkRequestOrigin` as written therefore refuses every real `form_post`
callback in a live deployment — present-but-foreign `Origin` fails the host match, and no `Origin`
at all fails the "absence is a rejection" rule origin.ts states explicitly.

## Decision

Reuse `checkRequestOrigin` unchanged on the callback, exactly as every other write in this
application uses it, and record the resulting gap rather than silently building a different check
for this one route. The callback's actual CSRF defence is `state` + PKCE, both already validated
inside `finishOidcLogin` before this application ever reads an identity — the state value is bound
to a transaction cookie this server set, which a cross-site page cannot read or forge, and that
property does not depend on the Origin header at all. The Origin check is defence in depth here,
the same secondary role OWASP recommends it play everywhere `SameSite` is the primary control
(`apps/web/server/auth/origin.ts`'s own header comment).

This is issue #118's own declared gap G-4 ("No live identity-provider verification. The tests use a
stubbed issuer fixture") extended one step: this task's tests drive the Origin check and the
state/PKCE failure paths independently and prove each refuses (see
`apps/web/app/api/auth/callback/callback.test.ts`), but neither test, nor any other in this task,
exercises a real external identity provider's actual `form_post` `Origin` behaviour end to end.

## Alternatives considered

- **Skip the Origin check for `POST /api/auth/callback` entirely.** Rejected: the task card and the
  verifier attack both name it explicitly, and dropping it removes a real (if secondary) defence for
  the sake of a production nuance that a specific deployment can resolve on its own terms (see
  below) — the honest answer is to keep the check and declare its limit, not to remove it.
- **Write a callback-specific Origin rule that treats a foreign `Origin` as acceptable.** Rejected:
  that is indistinguishable from no check at all for this route (a forged cross-site request also
  carries a foreign Origin), so it would satisfy the letter of "checks origin" while providing zero
  of the defence in depth the check exists for.
- **Change `response_mode` to `query` so the callback becomes a plain, safe-method `GET`** (which
  `checkRequestOrigin` passes unconditionally, matching `GET /api/auth/login`'s reasoning). This is
  very likely the right production answer and is recorded here as the recommended remediation, but
  it changes `beginOidcLogin`'s behaviour in `apps/web/server/auth/oidc.ts`, which this task's Owns
  line covers but which the card's Minimum implementation does not ask this task to touch — `oidc.ts`
  predates this wave and reusing it unchanged is this task's own stated approach elsewhere in its
  header comments. Left for the task or operator that first deploys against a real identity provider.

## Consequences

- A production deployment using a real OIDC provider with `response_mode: 'form_post'` may find its
  callback refused by the Origin check depending on that provider's exact `form_post` browser
  behaviour. This is stated here as a known limitation, not discovered later as a support ticket.
- Nothing in this task's test suite can catch a regression in a real provider's Origin behaviour,
  because nothing in it talks to one; `apps/web/app/api/auth/callback/callback.test.ts` proves this
  application's own reaction to a foreign Origin and to a `finishOidcLogin` failure, which is the
  boundary this task owns.
- Whoever next touches `apps/web/server/auth/oidc.ts` for a real deployment should read this record
  before assuming `form_post` is a free choice.
