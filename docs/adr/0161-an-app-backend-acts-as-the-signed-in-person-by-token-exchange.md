# ADR-0161 — An app backend acts as the signed-in person by token exchange

Status: accepted
Date: 2026-10-31
Decided by: issue #1498 (agent-portal plan F-9, unit U2.5a, tracker #1476); built by U2.5b (#1499)
Scope: spec §34 and §38; amends [ADR-0134](0134-external-platforms-reach-tools-and-agents-through-endpoint-clients.md) D2, D15 and D18 and supersedes the agent-portal plan's "reuse [ADR-0083](0083-the-cli-signs-a-person-in-with-a-device-flow-and-a-short-lived-user-token.md)'s user token"; `packages/contracts/src/{endpoint-clients,token-exchange,routes}.ts`; `packages/core/src/db/schema/{endpoint-clients,audit-events}.ts` and one expand-only migration; `apps/web/server/{auth,oauth,rbac,endpoint-clients}/`, `apps/web/server/composition/session-rbac.ts`, `apps/web/proxy.ts`, `apps/web/app/api/auth/token-exchange/route.ts`; `packages/sdk` (`aw.auth.exchange`)

## Context

An app built on the platform (agent-portal plan F-9, architecture §3.1) has a backend that serves a signed-in person. It must start runs, read them and stop them
**as that person**, so that the role, the agent grants and the audit trail are the person's. Today
the backend can hold only an API key or an endpoint-scoped key. A key acts as its member
([ADR-0134](0134-external-platforms-reach-tools-and-agents-through-endpoint-clients.md) D3), which
brings back the "act as some Owner" fallback RF-101 removed.

[ADR-0142](0142-tools-learn-who-is-asking.md) D2 gave runs a `subject`, but a subject is only an
assertion that tools see. The run is still authorised as the key: only an API-key caller may set
`subject` (`packages/contracts/src/runs.ts`). This record decides the missing half, in which the
platform authorises the request as the person.

What exists on `main` (`5a5d3c50d`), and why neither credential fits as is:

- **OIDC.** A deployment trusts one issuer: `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`,
  `OIDC_CLIENT_SECRET` and `OIDC_REDIRECT_URI` (`apps/web/server/auth/oidc.ts`). It is used only by
  the browser code flow, through `openid-client` discovery. The callback requires `sub`, `email` and
  `email_verified: true`. It links a person by `(issuer, subject)` in `user_identities`, where the
  issuer is the configured `OIDC_ISSUER_URL` string. Nothing verifies a bearer ID token today.
- **ADR-0083's user token** is `awu_live_` and lasts 12 hours with no refresh. It is stored in
  `cli_sessions`, whose `user_code` is `NOT NULL` with a device-code shape check. It is admitted
  only on person-facing routes (`apps/web/server/cli-auth/token-routes.ts`), so run routes refuse
  it. Reusing it would mean a new TTL, a new row shape and a wider route list, and each of those
  would amend ADR-0083.
- **ADR-0134 Part 3's access token** is `awo_live_`, stored as an `oauth_tokens` row with
  `client_id`, `subject_principal_id`, `resource`, `family_id`, `expires_at` and `revoked_at`.
  - It is bound to an endpoint client. Its subject is a membership principal, re-read on every
    request (ADR-0134 D13).
  - Revoking the client kills the token at lookup (ADR-0134 D14).
  - It resolves to a principal with `via: 'oauth-token'`, a `scope` and an `audience`.
  - It is admitted only on agent-endpoint routes (ADR-0134 D15).
- **Endpoint-client kinds** are `mcp-project`, `a2a-agent` and `builder`
  (`ENDPOINT_CLIENT_KINDS`, migration `0086`). The issue predates `builder`, so `app-backend` is
  the **fourth** kind, not the third. The bound agents live in `endpoint_client_agents`. Each kind
  has a route grammar in `TOKEN_SCOPE_GRAMMAR` (`apps/web/server/rbac/decide.ts`).
- **Audit rows** have `oauth-grant-issued` and `oauth-grant-revoked` but no action for an exchange.
  Since #1847 they also have a `details` column, which a CHECK limits to `agent-created` and
  `agent-changed` rows.
- **Spec drift.** §34 says an `/oauth` access token "is accepted only by the endpoint it names",
  and its route block has no exchange route. The spec outranks this record, so the spec is amended
  in the same change (D13).

Spec §38 lists "identity-provider replacement" as a non-goal, and ADR-0134 D18 lists "federation to
Entra or Google as the identity provider" as not adopted. Both stay true. **The platform accepts an
ID token only from the one issuer it already trusts for browser sign-in. It never issues an
identity, never provisions a person from a token, and never trusts a second issuer.** The exchange
trades a proof of an identity the platform already knows for a short, narrow credential of that
same identity.

## Decisions

D1 to D12 decide the issue's points 2.1 to 2.11 in order, except that 2.5 is split into D5 (the
checks) and D6 (not configured); point 2.12 is [Not adopted](#not-adopted). D13 records the spec
amendment.

- **D1. The token is an ADR-0134 access token, not an ADR-0083 user token.** A successful exchange
  writes one `oauth_tokens` row of kind `access`. The row has a **new `family_id` per exchange**
  and no code row or refresh row in that family, and the bearer is `awo_live_<22>_<43>`. The token
  inherits what Part 3 already built: it is bound to a client, its subject is re-read per request
  (ADR-0134 D13), the client's revocation kills it at lookup (ADR-0134 D14), and it carries an audience. The plan's
  "reuse ADR-0083's user token, 5 min" is **superseded**. That token lasts 12 h, needs a
  `cli_sessions` row whose `user_code` is `NOT NULL`, and is admitted on person routes only.
- **D2. Lifetime: 300 seconds, with no refresh.** `TOKEN_EXCHANGE_TTL_SECONDS = 300` is exported
  from `@indx-workspace/contracts/token-exchange`, and the row's `expires_at` is the issue time
  plus that value. `OAUTH_TOKEN_TTL_MS.access` (1 h) is not changed: it remains the lifetime of an
  endpoint's access token. An app that needs more time exchanges again with a fresh ID token. It is
  expected to cache one token per person for that token's lifetime, which also bounds the audit
  volume (D11).
- **D3. Route and wire shape.** The route is `POST /api/auth/token-exchange`.
  - **Request.** The body is JSON, validated by a `.strict()` Zod schema, and uses RFC 8693's field
    names:
    - `grant_type: "urn:ietf:params:oauth:grant-type:token-exchange"`;
    - `subject_token`, the ID token as a compact JWS of at most 16 KiB;
    - `subject_token_type: "urn:ietf:params:oauth:token-type:id_token"`;
    - optionally, `requested_token_type: "urn:ietf:params:oauth:token-type:access_token"`.
  - **Request refusals.** No other value of these fields is accepted. Any other shape is
    `400 invalid_body` (ADR-0075's common code) with the field path, and the strict schema refuses
    unknown keys. `audience`, `resource`, `scope` and `actor_token` are not accepted: the client
    binding decides all of them.
  - **Client authentication.** The client authenticates with `client_secret_basic` only, using the
    endpoint client's confidential secret, checked by `apps/web/server/oauth/client-auth.ts`. A
    secret in the body is refused. A public client (one without a secret) cannot exchange. The
    secret is minted and rotated by the existing `POST /api/endpoint-clients/:id/secret`.
  - **Answer.** `200` with `Cache-Control: no-store` and this body, with no `refresh_token` and no
    `scope`:

    ```json
    {
      "access_token": "awo_live_…",
      "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
      "token_type": "Bearer",
      "expires_in": 300
    }
    ```

  - **Refusals** use the ADR-0075 problem envelope with the codes of D7, never RFC 6749 `error`
    strings. A `401 invalid_client` also carries `WWW-Authenticate: Basic`.
  - **Catalogue.** The route is catalogued in `API_ROUTES` with `operationId: 'auth.exchange'`,
    `tag: 'auth'`, `security: 'none'`, because the handler authenticates the client and no member,
    as for `auth.pollToken`. Its feature is `feature: 'core'` (ADR-0160 D4: `/api/auth/**` is
    core). The proxy lets it through on its exact allowlist, beside `/api/auth/cli-token`.
  - **One name** (ADR-0114 S1). The operation is `auth.exchange`, and the SDK method is
    `aw.auth.exchange({ clientId, clientSecret, idToken })`. This **supersedes** the guide's
    `{ idToken, clientId }`, because the client is confidential and the call needs its secret.
    There is no `aw` command: an ID token is a backend's input, never a terminal user's.
  - **Where the route lives.** It sits under `/api/auth/` rather than on `/oauth/token`, so it does
    not depend on `AW_PUBLIC_URL` (ADR-0134 D12) and can answer with named problem codes.
- **D4. A fourth endpoint-client kind, `app-backend`.** `ENDPOINT_CLIENT_KINDS` becomes
  `['mcp-project', 'a2a-agent', 'builder', 'app-backend']`. The same spelling is used in the
  database CHECK, the `TokenScopeKind`, the SDK and the console label, as ADR-0114 asks.
  - **Bound agents.** It binds 1 to 64 agents in `endpoint_client_agents`, as `mcp-project` does.
  - **`oidc_audience`.** One new nullable column, `endpoint_clients.oidc_audience` (text, 1 to 255
    characters). It holds the app's own OIDC `client_id` at the issuer, which is the ID token's
    `aud`. A table CHECK, `(kind = 'app-backend') = (oidc_audience is not null)`, makes the column
    set exactly on this kind.
  - **Migration.** One expand-only migration, numbered after the highest on the branch: `0096`,
    because the webhooks migration took `0095` on `main` first. It widens the `endpoint_clients.kind`
    CHECK, adds the column and its CHECK, and re-creates the `audit_events` action CHECK with
    `user-token-exchanged`. Every change is additive, so the previous revision keeps running.
  - **What it refuses.** An `app-backend` client is used only by this exchange.
    - It mints no endpoint-scoped API key. `POST /api/endpoint-clients/:id/keys` answers
      `endpoint_client_invalid`, as for `builder`. A static key would act as the client's creator,
      which is the problem this record removes.
    - `/oauth/authorize` and `/oauth/token` refuse it as `unauthorized_client`. Its
      `client_credentials` grant would act for the creator, and it has no resource URL.
    - It has no redirect URIs.
    - Creating, changing or rotating the secret of an `app-backend` client needs an Owner or Admin,
      as for `builder`. Its tokens act as any member of the workspace who signs in to the app.
  - **The issuer is always `OIDC_ISSUER_URL`.** A client never names its own issuer.
- **D5. The ID-token checks and the JWKS source.** Each check is refused by name (D7). They run in
  this order, and every check runs before any database read about the person.
  1. **Shape.** The token is a compact JWS with three segments. Its `alg` is asymmetric (`RS256`,
     `PS256`, `ES256` or `EdDSA`) and appears in the issuer's
     `id_token_signing_alg_values_supported`. `none` and every `HS*` algorithm are refused: an
     HMAC-signed ID token is signed with an OIDC client's secret, not by the issuer.
  2. **Signature.** The signature is checked against a key from the issuer's JWKS. **Where the keys
     come from is fixed by configuration, never by the token.**
     - The JWKS URL is the `jwks_uri` that OIDC discovery returns for the configured
       `OIDC_ISSUER_URL`, through the same `openid-client` discovery the browser flow uses.
     - The token's `jku`, `x5u`, `x5c` and `jwk` header parameters are never followed or used. The
       header picks a key only by `kid` within that one key set.
     - The key set is cached per process. An unknown `kid` refreshes it at most once per 30
       seconds, so a forged `kid` cannot make the platform fetch on every request.
     - The source is an injectable port, `IdTokenKeySource`: production uses the discovery-backed
       remote set (`jose`'s `createRemoteJWKSet`, already a dependency), and tests use a local key
       set and a local fake issuer. No test reaches the network.
  3. **Issuer.** `iss` equals the issuer that discovery validated for `OIDC_ISSUER_URL`.
  4. **Audience.** `aud` equals the client's `oidc_audience`, or is an array that contains it. When
     `aud` has more than one value, `azp` must equal `oidc_audience`.
  5. **Time.** `exp` is later than now minus 30 seconds, and `iat` is earlier than now plus 30
     seconds. Both claims are required.
  6. **Verified email.** `sub` is a non-empty string, and `email_verified` is `true`. The browser
     callback requires the same ("nOAuth").
  7. **Person.** The pair (configured `OIDC_ISSUER_URL`, `sub`) resolves in `user_identities` to a
     user. That user holds a membership in the **client's** workspace. There is **no JIT
     provisioning**: an unknown pair is refused and nothing is written. An identity is linked only
     by the browser sign-in or an invitation. The token's subject is that membership's principal.

  `nonce`, a single-use `jti` and a maximum ID-token age are not checked.
  - The `nonce` belongs to the app's own sign-in, which the platform did not start.
  - Replay is bounded in three ways: only the authenticated confidential client can exchange, `aud`
    binds the token to that client, and the result lasts 300 s.

  The pure part of these checks is one domain function, which turns verified claims, the client and
  the membership lookup into "accept" or a named refusal. The JWKS port and the database are
  adapters around it.

- **D6. Not configured.** The route answers `503 token_exchange_not_configured` in two cases: the
  deployment has no complete OIDC configuration (the `readOidcConfiguration` rule), or it has no
  database. It never answers the gate's `401` in those cases. `tests/no-route-answers-503.test.ts`
  declares this refusal by name.
- **D7. Problem codes.** `TOKEN_EXCHANGE_PROBLEM_CODES` in `@indx-workspace/contracts/token-exchange`,
  with their statuses:

  | Code                            | Status | When                                                                                                           |
  | ------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
  | `token_exchange_not_configured` | 503    | no OIDC configuration or no database (D6)                                                                      |
  | `invalid_client`                | 401    | no Basic credentials, an unknown, revoked or public client, a wrong secret, or a kind other than `app-backend` |
  | `subject_token_invalid`         | 401    | shape, algorithm, signature, an unknown `kid`, `exp`, `iat`, a missing `sub`, or `email_verified` not `true`   |
  | `subject_token_wrong_issuer`    | 401    | `iss` is not the configured issuer                                                                             |
  | `subject_token_wrong_audience`  | 401    | `aud` (or `azp`) is not the client's `oidc_audience`                                                           |
  | `subject_not_member`            | 403    | no identity for `(iss, sub)`, or that person is not a member of the client's workspace                         |
  | `rate_limited`                  | 429    | D12, with `Retry-After`                                                                                        |

  The body-shape refusals are ADR-0075's common `400 invalid_body`, `400 malformed_body` and
  `415 unsupported_media_type`.
  - **Concealment.** `subject_not_member` says the same thing in both of its cases. It never says
    whether the person exists, or is a member of another workspace.
  - **No echo.** No refusal and no log line includes the ID token, the client secret or the issued
    token. A refusal is logged by its code and the client id only.

- **D8. The `app-backend` scope, and where the bound-agent check lives.**
  - **The grammar.** `TOKEN_SCOPE_GRAMMAR['app-backend']` is:
    - `{ agents, run }`: `POST /api/agents/:id/runs`, only for an agent bound to the client;
    - `{ runs, read }`: `GET /api/runs/:id` and `GET /api/runs/:id/events`;
    - `{ runs, run, sub: 'interrupt' }`: `POST /api/runs/:id/interrupt`;
    - `{ me, read }`: `GET /api/me`.

    Everything else is out of scope. That includes files, sessions, connectors, run feedback, the
    run list and every administration route. `GET /api/runs` stays out: the existing rule in
    `checkTokenScope` reads one run by `:id`, never the list. Outside the grammar the token is
    refused at admission, so the wire answer is `401`, unauthenticated (D9), and the route never
    runs. `decide()`'s `403 token_out_of_scope` for the same request is the second layer: it holds
    if a route is ever admitted without being in the grammar. An agent not bound to the client, on
    an admitted route, gets `403 token_out_of_scope` on the wire.

  - **`TokenScope` gains the bound agents.** `decide()` is pure and cannot read
    `endpoint_client_agents`, so the bound agents travel on the principal. `TokenScope` gains an
    optional `agentIds: readonly string[]`, which is required and non-empty exactly when `kind` is
    `app-backend`. Its `id` is the client id. `resolveActor` reads the bound agent ids **on every
    request**, in the same lookup that joins the unrevoked client (ADR-0134 D14), so unbinding an
    agent takes effect on the next request. `checkTokenScope` refuses an `agents` request whose
    path `:id` is not in `agentIds`, comparing UUIDs case-insensitively as it does for
    `a2a-agent`. The `Principal` invariant is updated so that an `app-backend` scope rides only on
    `via: 'oauth-token'`.
  - **Effective permission.** The scope only narrows; it never grants. A request in the grammar
    still clears the person's own role, ownership and agent-grant checks (`decide()`, then
    `requireRunPermission`). So the effective permission is the person's role ∩ the client's scope
    ∩ the person's agent grants (ADR-0134 D2 attenuation).
  - **Which runs.** `runs read` and `runs interrupt` reach the runs the person can already see and
    stop. They are not narrowed further to runs started through this client: the person could read
    those same runs in the console.
- **D9. Admission (amends ADR-0134 D15).** An `awo_live_` token is now admitted on two route sets:
  the agent-endpoint routes, as before, and **exactly the `app-backend` grammar's routes**.
  - **One list.** The routes are one pure list, `apps/web/server/auth/app-backend-routes.ts`
    (`isAppBackendRoute(method, pathname)`), derived from the catalogue entries named in D8. Both
    `apps/web/proxy.ts` and `resolveActor` read it, as both read `token-routes.ts` for ADR-0083.
  - **On an `app-backend` route,** `resolveActor` resolves the token. It then refuses it as
    unauthenticated unless its client's kind is `app-backend`. So an `a2a-agent` token still cannot
    use `POST /api/agents/:id/runs` as a second way in, which is the reason D15 gave.
  - **On an agent-endpoint route,** an `app-backend` token is refused by the endpoint's own audience
    check: `401 invalid_token`, because its `resource` (D12) is never an endpoint URL.
  - **Elsewhere,** an `awo_live_` token is unauthenticated, as today.
- **D10. A run started with this token is the person's.** The principal is the person's membership
  principal, with `via: 'oauth-token'`. So the run's `initiatingUserId` is the person, its owner is
  the person, and ADR-0142's assertion carries `principalKind: 'membership'` with the person's
  principal as `sub`. `StartRunRequest.subject` stays API-key-only (ADR-0142 D2): this caller is
  already the person, so a `subject` from it is `403 run_subject_forbidden`. Every write the run
  makes carries its `run_id`, as for any run, and the run never exceeds the person: its permission
  is the person's, attenuated by D8.
- **D11. Audit, one row per exchange.** There is one new action, `user-token-exchanged`.
  - **Who and what.** The actor is the person: `actor_user_id` is the user and
    `actor_principal_id` is the membership principal. The subject is the endpoint client: its id and
    its name at the time.
  - **Same transaction.** The row is written in the same transaction as the token row, so no token
    exists without its audit row.
  - **Refusals** write no audit row. They are logged by code (D7) and bounded by D12.
  - **Why not `oauth-grant-issued`.** That action already means a member's consent at
    `/oauth/authorize`. Reusing it would mix consent and exchange in one action, and telling them
    apart would mean widening the `details` CHECK, which admits only agent rows today.
- **D12. Limits and the token's `resource`.**
  - **Per client.** `POST /api/auth/token-exchange` admits 120 exchanges a minute per client. The
    client is counted only after it has authenticated: a `client_id` is public, so counting it
    earlier would let anyone lock a client out by naming it (ADR-0134 D16).
  - **Per address.** Each source address may fail client authentication 10 times a minute. This is
    checked **before** the secret is.
  - **Refusal.** `429 rate_limited` with `Retry-After`.
  - **Where the counters live.** They are per-process counters, like
    `apps/web/server/oauth/limits.ts`, and the code marks them the same way — shortcut: each replica
    admits its own limit and a restart resets it, move the counters to PostgreSQL when the control
    plane runs more than one replica.
  - **`resource`.** The `oauth_tokens.resource` column (the audience, `NOT NULL`) is
    `urn:agent-workspace:app-backend:<client id>`, written by the exchange. It is an absolute URI
    that needs no `AW_PUBLIC_URL`, it is unique per client, and it never equals an endpoint's URL.
    The principal's `oauth.audience` carries it, and D9's endpoint check refuses it.
- **D13. The spec is amended with this record.**
  - §34's route block gains the exchange route.
  - §34's sentence that an `/oauth` access token "is accepted only by the endpoint it names" now
    names the one exception: a token from this exchange is accepted on exactly the `app-backend`
    grammar's routes.
  - §38 gains one line: accepting the configured issuer's ID token is not identity-provider
    replacement.

## Not adopted

- **Refresh tokens.** A second secret held for every person, for a flow the app can repeat with the
  ID token it already holds.
- **Accepting an access token as `subject_token`.** Only an ID token states who signed in, and for
  which client (`aud`). An IdP access token's audience is an API, often not this platform.
- **More than one issuer, or a per-client issuer.** That would make the platform a federation hub,
  which is what ADR-0134 D18 and spec §38 rule out.
- **Dynamic client registration (RFC 7591) and token introspection (RFC 7662).** ADR-0134 D18
  already rules both out.
- **A fourth grant on `/oauth/token`.** It speaks only RFC 6749 `error` codes, so D7's refusals
  could not be named. It also requires `AW_PUBLIC_URL` (ADR-0134 D12), and the OAuth server is
  `404` without it.
- **ADR-0083's `awu_live_` token** (D1).
- **Provisioning a person on the first exchange.** The platform would then issue identities.
- **A form-encoded body.** RFC 8693 is form-encoded. Every other `/api/**` route is JSON with
  ADR-0075 answers, so this route keeps the RFC's field names and uses JSON.

## Consequences

- An app backend acts as the signed-in person. Runs, grants and audit name the person, and an agent
  the person has no grant to run is refused (`403`) even when the client binds it. The phase-2 done
  criterion "a sample backend acting as a person starts a run the person's grants allow and is
  refused for an agent they lack a grant to" is testable against this record.
- **Revocation.** Removing the membership, revoking the client or unbinding an agent takes effect
  on the next request. A person who signs out of the issuer keeps any token already issued until
  it expires, at most 300 s later. `/oauth/revoke` accepts the token where the OAuth server is
  configured.
- **ADR-0134 is amended in three places.**
  - D2: a fourth kind and its grammar.
  - D15: admission on the `app-backend` routes.
  - D18: this one exchange, from the trusted issuer only, is allowed and is not federation.
    ADR-0083 is unchanged, and its Consequences point here.
- **U2.5b builds it**, inside out: the contracts (`app-backend`, `TOKEN_EXCHANGE_TTL_SECONDS`,
  `TOKEN_EXCHANGE_PROBLEM_CODES`, the request and response schemas, the route entry), the
  migration, the pure decision function, the JWKS port and the token and audit write, the route,
  the admission list, `aw.auth.exchange`, and the console's endpoint-client form (ja and en). The
  tests use a local fake issuer and a local key set.
- **Formal model.** The formal ER model and the claims register follow the migration: the wider
  kind CHECK, the new column CHECK and the wider action CHECK. They are restated in place, with no
  theorem weakened.
