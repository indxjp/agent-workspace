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

## Amendment — an app backend decides an approval as the person (issue #1509, 2026-10-31)

Reason: the app kit's agent panel (issue #1509) shows a paused run's pending tool call beside the
record it acts on, with inline Approve and Reject (ADR-0145). The backend calls
`POST /api/runs/:id/approval` as the signed-in person with the token of D1. D8's grammar has no
cell for it, so D9 refuses it as unauthenticated and the person would have to leave the app for
the console to decide.

- **D8 gains one cell.** `TOKEN_SCOPE_GRAMMAR['app-backend']` also admits
  `{ runs, run, sub: 'approval' }`: `POST /api/runs/:id/approval` (catalogue operation
  `runs.approval`). It is keyed by the sub-resource, as `interrupt` is, so `feedback` stays out.
- **D9's list follows.** `APP_BACKEND_OPERATIONS` gains `runs.approval`, so `apps/web/proxy.ts` and
  `resolveActor` admit an `awo_live_` token on that route and on no other new one.
- **Still the person, still the client's agents.** The decision clears the same checks as for any
  other caller (ADR-0145 D2: the person may see the run, and `runs.run.approval` for an own or
  another's run). An approval starts a continuation run on the paused run's agent, which is running
  that agent, so the handler also refuses `403 token_out_of_scope` when an `app-backend` caller's
  run is on an agent the client does not bind. The agent's id is a row fact, so the check lives
  where the run is read, beside the session-scope check, and not in `decide()`. A person can
  therefore approve through the app only what the app could have started, and never more than the
  console lets them decide.
- **Unchanged.** The run list, run feedback, files, sessions and every administration route stay
  out of the grammar.

## Amendment — aw dev signs a person in through a development issuer (issue #2075, 2026-11-01)

Reason: under `aw dev` a generated app cannot act as the signed-in person on a run route, so the
agent panel's run start and the `RecipeGraph` approval answer `401`. The only person credential
there is `aw login`'s `awu_live_` token, which ADR-0083 admits on no run route. D1's `awo_live_`
token needs an ID token from `OIDC_ISSUER_URL`, and the local runtime has no issuer. This amendment
gives `aw dev` a development issuer, so the exchange of D3 runs locally **unchanged**. ADR-0083 is
not widened, and `awu_live_` stays refused on every run route.

What is on `main` when this is recorded:

- The local runtime sets no `OIDC_*` variable (contract C1, `applyLocalRuntimeEnvironment` in
  `packages/embedded/src/local-environment.ts`). So `GET /api/auth/login` answers
  `503 oidc_not_configured`, and the exchange answers `503 token_exchange_not_configured` (D6).
- C1 fixes `AW_DEPLOYMENT_POSTURE=local` and `HOST=127.0.0.1`. The runtime runs with
  `NODE_ENV=production`, and the console's origin is `http://127.0.0.1:<port>`.
- `openid-client` discovery refuses a plain `http:` issuer unless the caller passes
  `allowInsecureRequests`. The browser flow (`apps/web/server/auth/oidc.ts`) and the exchange's key
  source (`apps/web/server/auth/token-exchange.ts`) both call discovery without it.
- `POST /api/endpoint-clients` refuses every API key (`403 api_key_not_permitted`). So does
  `POST /api/endpoint-clients/:id/secret`, where the S1-21 guard (`refusingLocalRuntimeKey`) also
  refuses the local runtime's key. So `aw dev`'s Admin key cannot create an `app-backend` client or
  mint its secret today. DI10 corrects this, narrowly.

The decisions are DI1 to DI12. D1 to D4, D6 to D12 and the exchange route are unchanged. D5.2 and
D5.7 are amended (DI9 and DI8), and so is [ADR-0109](0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md)'s
contract C1 (DI5). DI10 makes one narrow exception to the endpoint-client routes' API-key refusal
([ADR-0134](0134-external-platforms-reach-tools-and-agents-through-endpoint-clients.md)) and to the
S1-21 guard.

- **DI1. The issuer is a tool of the CLI.** It runs inside the `aw dev` process
  (`packages/aw/src/dev/issuer.ts`), never in the platform: `apps/web`, `packages/core` and
  `packages/embedded` do not import it.
  - **Listener.** A `node:http` server bound to `127.0.0.1` only, never to `localhost`, `::1` or
    `0.0.0.0`.
  - **Port.** The first free one from the web port + 200, trying 50. That is near the app's port
    (+100, `packages/aw/src/dev/app.ts`) and clear of the derived service ports. When none is free,
    `aw dev` stops before the fork with `dev_issuer_port_unavailable`.
  - **URL.** `http://127.0.0.1:<port>`, with no path and no trailing slash.
  - **Lifetime.** It starts before the runtime is forked, because its URL is in the `start`
    message (DI5), and it stops with `aw dev`.
  - **Host check.** A request whose `Host` header is not exactly `127.0.0.1:<port>` is refused with
    `421 dev_issuer_wrong_host`. This closes the DNS-rebinding path to the sign-in form.
- **DI2. When it runs.** Only when none of `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`,
  `OIDC_CLIENT_SECRET` and `OIDC_REDIRECT_URI` is set. `aw dev` looks in its own environment and in
  the project's `.env`, by name, as it already does to locate the console password
  (`passwordLocation` in `packages/aw/src/commands/dev.ts`). It prints no `OIDC_*` value.
  - **All four set.** The developer's own identity provider wins. No development issuer runs,
    nothing is added to the `start` message, and `aw dev` prints one line saying so.
  - **One to three set.** `aw dev` refuses before the fork with `oidc_configuration_incomplete`,
    naming the missing variables. This is `readOidcConfiguration`'s rule, checked earlier.
  - **Second layer.** The runtime loads `.env` after the fork. When the `start` message carries
    `devIssuer` and the runtime's environment then holds any `OIDC_*` name, the runtime refuses to
    start with the `LocalRuntimeEnvironmentError` code `dev_issuer_oidc_set`, naming the variable.
    This is the pattern of SD17's `withheld_secret_set` (ADR-0109, slice-2 amendment), so a value
    is never accepted and then ignored.
- **DI3. Cryptography, with no new dependency.** `pnpm-lock.yaml` is not touched.
  - **The key.** One Ed25519 key pair per `aw dev` process, from
    `node:crypto.generateKeyPairSync('ed25519')`, held in memory and never written. A new `aw dev`
    therefore invalidates every ID token the previous one signed.
  - **The tokens** are compact JWS with the header `{ "alg": "EdDSA", "typ": "JWT", "kid": … }`,
    signed with `node:crypto.sign(null, …)`. The `kid` is the key's RFC 7638 thumbprint.
  - **The JWKS** is the public key's `KeyObject.export({ format: 'jwk' })`, plus `kid`,
    `alg: "EdDSA"` and `use: "sig"`.
  - **The verifiers exist.** `EdDSA` is one of D5.1's algorithms, and `jose` and `openid-client`
    already verify it on the platform side, so the platform gains no code path.
  - **Why not `oidc-provider`, or `jose` in `aw`.** Either adds dependencies to the published
    `@indx-workspace/aw` package and changes the lockfile, which makes the osv gate strict. The
    platform needs four endpoints of one flow, and `node:crypto` signs and exports the key. The
    issuer builds no cryptography of its own: it encodes base64url and calls `node:crypto`.
- **DI4. Endpoints.** Exactly these four; every other path answers `404`.
  - **`GET /.well-known/openid-configuration`:** `issuer`, `authorization_endpoint`,
    `token_endpoint`, `jwks_uri`, `response_types_supported: ["code"]`,
    `response_modes_supported: ["query", "form_post"]`,
    `grant_types_supported: ["authorization_code"]`, `subject_types_supported: ["public"]`,
    `id_token_signing_alg_values_supported: ["EdDSA"]`,
    `token_endpoint_auth_methods_supported: ["client_secret_basic"]`,
    `code_challenge_methods_supported: ["S256"]` and
    `scopes_supported: ["openid", "profile", "email"]`.
  - **`GET /jwks`:** the one public key (DI3).
  - **`GET` and `POST /authorize`:** the code flow only (`response_type=code`), with `scope`
    containing `openid`. S256 PKCE and `state` are required, `state` is echoed, and `nonce` goes
    into the ID token. `redirect_uri` is matched exactly against the client's one registered URI
    (DI5).
  - **`POST /token`:** the `authorization_code` grant, with `client_secret_basic` only. A code is
    single-use, lives 60 seconds, and is bound to its client, its `redirect_uri` and its PKCE
    challenge. The answer is `Cache-Control: no-store` with
    `{ access_token, token_type: "Bearer", expires_in, id_token }`. The `access_token` is an opaque
    random value that nothing accepts, because there is no userinfo endpoint.
  - **Not served:** userinfo, refresh tokens, dynamic registration, introspection, revocation,
    end-session, the implicit and hybrid flows, and `client_secret_post`.
- **DI5. Clients, registered in memory at each start.** Each has a random 32-byte secret
  (base64url), made per `aw dev` process and never printed. The issuer keeps its SHA-256 and
  compares in constant time.
  - **The local console.** `client_id` `aw-local-console`, redirect URI
    `http://127.0.0.1:<web port>/api/auth/callback`, `form_post` (as `beginOidcLogin` asks). Its
    values reach the runtime in a new `start` field, `environment.devIssuer`, which **amends
    ADR-0109's contract C1**. It is a `.strict()` object in `@indx-workspace/contracts/local-runtime`
    with `issuer` (`http://127.0.0.1:<port>`, matched by pattern), `clientId`, `clientSecret`
    (43 base64url characters), `redirectUri` (which must equal
    `http://127.0.0.1:<environment.port>/api/auth/callback`) and `ownerSubject` (the bootstrap
    Owner's `sub`, DI7 and DI8).
  - **What the runtime does with it.** When the field is present, `applyLocalRuntimeEnvironment`
    sets `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and `OIDC_REDIRECT_URI` from it,
    after DI2's check. The four names join the contracts' reserved list of variables that a secret
    reference may not name. The client secret is in the runtime's environment, in the trust class
    of `SESSION_SECRET`. It travels on the fork's IPC channel, never on a command line, and the
    field is never logged. A `start` message without the field starts exactly as before, and a
    runtime older than the field refuses it as an unknown key.
  - **The app.** The project's app (the `app:<name>` entry of `aw-generated.json`) gets a client
    whose `client_id` is the app name, with the redirect URI
    `http://127.0.0.1:<app port>/api/sign-in/callback`, in `query` or `form_post` mode. With no
    app, this client is not registered.
- **DI6. How the person authenticates.** `/authorize` shows a sign-in form, in English or Japanese
  from `Accept-Language` (English by default). Its fields are labelled, it is keyboard-operable, and
  it announces errors in an `aria-live` region. It asks for:
  - **an email:** a member's, prefilled with the project's bootstrap Owner (`BOOTSTRAP_ADMIN`);
  - **the local console password,** found in the runtime's precedence: the environment, then
    `.env`, then `.agent-workspace/secrets/local-secrets.json`. The issuer reads it when the form
    is posted and compares SHA-256 digests in constant time.

  The password keeps the trust bar where the local console already sets it. Without one, any
  process on the machine could mint the Owner's ID token. With it, whoever can sign in to the
  console as the Owner may sign in as any member of the local workspace, which as Owner they could
  already administer.
  - **No database.** The issuer reads none, so membership stays the platform's decision. The
    console's callback answers an unknown email with its invitation path, and the exchange answers
    `403 subject_not_member` (D7).
  - **Session.** A successful form sets the issuer cookie `aw_dev_issuer`: random, held in memory,
    `HttpOnly`, `SameSite=Lax`, for 12 hours (the browser session's lifetime, ADR-0083 decision 3). With
    it, a later `/authorize` answers without the form unless it carries `prompt=login`.
    `prompt=none` without a session answers `login_required`.
  - **Headers.** Every page is `Cache-Control: no-store`, `X-Frame-Options: DENY` and
    `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self';
frame-ancestors 'none'`.

- **DI7. Claims.** The ID token carries exactly these:
  - `iss`: the issuer URL;
  - `sub`: `local:` + base64url(SHA-256(the email, trimmed and lowercased)), so one email always
    has one `sub`;
  - `aud` and `azp`: the client id;
  - `email` as typed, trimmed, and `email_verified: true`;
  - `iat`, `auth_time`, and `exp` 10 minutes after `iat`;
  - `nonce`, when the request sent one.

  D5's checks pass on it unchanged: an asymmetric `alg` that discovery lists, a `kid` in the one
  JWKS, `iss`, `aud` and `azp`, the times, `email_verified`, and the identity lookup.

- **DI8. D5.7 is amended: a third way to link an identity, in the local posture only.** D5.7 links
  an identity only by the browser sign-in or an invitation. At each start that carries
  `devIssuer`, the local runtime's launcher also links `(devIssuer.issuer, devIssuer.ownerSubject)`
  to the bootstrap Owner in `user_identities`, idempotently, after the seed has made the Owner.
  - **Why.** An app's exchange then finds the Owner before anyone has signed in to the console.
  - **Stale links.** The issuer URL holds the port, so a link from a start on another port stays.
    It is harmless: nothing trusts that issuer any more, and the pair still names the same user.
  - **Other members** link the existing way: they sign in once to the local console through the
    development issuer, and `resolveOidcSignIn` links a verified email whose account has a
    membership.
  - **Still no JIT provisioning.** The exchange refuses an unknown `(iss, sub)` and writes nothing.
- **DI9. D5.2 is amended: plain `http:` discovery, in the local posture on loopback only.**
  - **Discovery.** The browser flow's discovery and the exchange's `IdTokenKeySource` pass
    `allowInsecureRequests` only when `readDeploymentPosture` answers `local` **and**
    `OIDC_ISSUER_URL` is `http:` on a host `isLoopbackHost` accepts. Otherwise discovery is called
    exactly as today. The JWKS still comes only from discovery's `jwks_uri`.
  - **Production refuses at boot.** Under the `production` posture, explicit or derived from
    `NODE_ENV`, `checkDeploymentPosture` refuses an `OIDC_ISSUER_URL` that is not `https:`,
    loopback or not, with the new `DeploymentPostureError` code `oidc_issuer_not_https`. `startWeb`
    checks the posture before Next is created, so nothing serves. This is how production refuses
    the development issuer: the issuer is `http:` by construction, and `aw dev` never runs in a
    production image.
  - **The test that proves it.** G1 adds `packages/core/src/posture.test.ts` › "refuses an http
    OIDC issuer under the production posture, a loopback one included". It covers an explicit and
    a derived `production` with `http://127.0.0.1:3200`, and accepts an `https:` issuer. A case in
    `apps/web/server/start.test.ts` shows `startWeb` rejecting before Next is created.
- **DI10. The app's `app-backend` client under `aw dev`.** After its first sync, `aw dev` makes sure
  there is one `app-backend` endpoint client named after the app.
  - **What it binds.** The project's synced agents, 1 to 64 as D4 allows. Its `oidcAudience` is the
    app's issuer client id, the app name (DI5). When a later sync changes the agent set, `aw dev`
    re-binds with `PATCH /api/endpoint-clients/:id`.
  - **No agent, or more than 64.** `aw dev` makes no client and prints one
    `app_backend_not_configured` line with the reason. The app's sign-in then says it is not
    configured, and never falls back to another credential.
  - **The secret is minted at every start.** `aw dev` calls `POST /api/endpoint-clients/:id/secret`
    once per process and passes the answer only to the app's environment, never to disk or the
    terminal. This departs from the plan of keeping it in a `.aw/` file: the issuer's key and
    client secrets already change per process (DI3, DI5), so a longer-lived secret buys nothing and
    leaves a file to protect. Each start writes one `oauth-client-secret-rotated` audit row.
  - **The one exception to the API-key refusal.** `POST /api/endpoint-clients` and
    `POST /api/endpoint-clients/:id/secret` admit an API key **only** when the key is the local
    runtime's (its name carries `LOCAL_RUNTIME_API_KEY_NAME_PREFIX`, which only the in-process
    issuer can mint, S1-21), the posture is `local`, and the client's kind is `app-backend`. Every
    other key, kind and posture is refused exactly as today, with `api_key_not_permitted` or
    `local_runtime_key_not_permitted`.
  - **Why it is safe.** API keys are refused because a key represents no person while a client acts
    for its creator. An `app-backend` client acts for no creator: its tokens are the signed-in
    person's (D10), narrowed by D8. Its secret is useless without an ID token from the one trusted
    issuer, and under `aw dev` that issuer's key dies with the process. The audit actor is the
    key's member, the bootstrap Owner, and D4's Owner-or-Admin rule still holds (the key is Admin).
- **DI11. The app's environment names, fixed once (ADR-0114).** `aw dev` sets five variables in the
  app's dev-server environment, beside `APP_<NAME>_IDENTITY` and through the same channel. A
  production operator sets the same names for the real identity provider and a console-made client.
  - `AW_OIDC_ISSUER_URL`: the issuer the app signs a person in at (under `aw dev`, DI1's URL);
  - `AW_OIDC_CLIENT_ID`: the app's client id there, the ID token's `aud` (under `aw dev`, the app
    name);
  - `AW_OIDC_CLIENT_SECRET`: the app's client secret there (DI5's per-process secret);
  - `AW_APP_CLIENT_ID`: the `app-backend` endpoint client's id, `clientId` of `aw.auth.exchange`;
  - `AW_APP_CLIENT_SECRET`: its secret (DI10), `clientSecret` of `aw.auth.exchange`.

  The sign-in page and callback are the app's (U3.6-b): `/sign-in` and `/api/sign-in/callback`.
  The callback derives its redirect URI from the app's own origin, checks `state` and `nonce`,
  takes the ID token from the token endpoint and calls `aw.auth.exchange`. It keeps the
  `awo_live_` token in the `aw_user_token` cookie that `currentPerson` already reads.
  - **With the developer's own IdP** (DI2, all four `OIDC_*` set), `aw dev` sets none of the
    `AW_OIDC_*` names: the developer registers the app at that IdP and sets them. `aw dev` still
    makes the `app-backend` client when `AW_OIDC_CLIENT_ID` is in its environment, with that value
    as `oidcAudience`, and otherwise prints `app_backend_not_configured`.

- **DI12. Unchanged.** ADR-0083: `awu_live_` is still refused on every run route. D1 to D4, D6 to
  D12, and the exchange's route, request, answer and codes. A deployment still trusts exactly one
  issuer, and the platform itself issues no identity: the development issuer is the CLI's, on
  loopback, and the production posture refuses it. Spec §38 says so.

### Refusal codes

`aw dev`, the runtime and the posture check use plain names. `/authorize` and `/token` use RFC 6749
`error` strings, because `openid-client` and the app's sign-in read them. No refusal and no log
line includes a password, a code, a secret or a token.

| Where                            | Status and code                                  | When                                                                                                                 |
| -------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `aw dev`, before the fork        | `dev_issuer_port_unavailable`                    | no free port among the 50 tried (DI1)                                                                                |
| `aw dev`, before the fork        | `oidc_configuration_incomplete`                  | one to three `OIDC_*` variables set (DI2)                                                                            |
| runtime, after `.env`            | `dev_issuer_oidc_set`                            | `devIssuer` sent and an `OIDC_*` name set (DI2)                                                                      |
| control plane, at boot           | `oidc_issuer_not_https`                          | a non-`https:` `OIDC_ISSUER_URL` under the `production` posture (DI9)                                                |
| `aw dev`, after sync             | `app_backend_not_configured` (a notice)          | no agent, more than 64, or the developer's IdP without `AW_OIDC_CLIENT_ID` (DI10, DI11)                              |
| issuer, any path                 | `421 dev_issuer_wrong_host`                      | `Host` is not `127.0.0.1:<port>` (DI1)                                                                               |
| `/authorize`, shown, no redirect | `400 invalid_client`, `400 invalid_redirect_uri` | an unknown `client_id`; a `redirect_uri` that is not the client's. The issuer never redirects to an unregistered URI |
| `/authorize`, redirected         | `invalid_request`                                | no S256 `code_challenge`, no `state`, or a malformed parameter                                                       |
| `/authorize`, redirected         | `unsupported_response_type`, `invalid_scope`     | a `response_type` other than `code`; a `scope` without `openid`                                                      |
| `/authorize`, redirected         | `login_required`                                 | `prompt=none` without an issuer session                                                                              |
| `/authorize`, form shown again   | `401 dev_issuer_sign_in_refused`                 | a blank or malformed email, or a wrong password, with one message that never says which                              |
| `/authorize`, form               | `429 rate_limited`                               | more than 10 failed posts a minute, with `Retry-After`                                                               |
| `/token`                         | `401 invalid_client`                             | no Basic credentials, an unknown client or a wrong secret, with `WWW-Authenticate: Basic`                            |
| `/token`                         | `400 invalid_grant`                              | an unknown, used or expired code, another client's code, or a `redirect_uri` or `code_verifier` that does not match  |
| `/token`                         | `400 unsupported_grant_type`                     | a grant other than `authorization_code`                                                                              |
| `/token`                         | `400 invalid_request`                            | a missing parameter, or a body that is not form-encoded                                                              |

The endpoint-client routes keep `403 api_key_not_permitted` and
`403 local_runtime_key_not_permitted` for everything but DI10's one exception.

### Not adopted

- **`oidc-provider`** (DI3).
- **Admitting `awu_live_` on run routes, or a new person token for `aw dev`.** Either widens
  ADR-0083 and opens a second way to act as a person on run routes.
- **A second trusted issuer in production,** or the development issuer beside a configured one.
  DI2 makes them exclusive.
- **Refresh tokens,** at the issuer or the platform. The issuer session (DI6) re-issues an ID token
  without the form, and the app exchanges again (D2).
- **A form without a password.** Any local process could then sign in as the Owner (DI6).
- **The issuer inside the local runtime,** so that `packages/embedded` mints ID tokens. The
  platform would then issue identities, which spec §38 rules out.

### Consequences

- **G1 (#2075) builds it**, inside out:
  - the contracts' `devIssuer` field and the reserved names;
  - `packages/aw/src/dev/issuer.ts`, with tests that drive discovery, the JWKS, the form and the
    code flow through `openid-client`, and every refusal code above;
  - `aw dev`'s DI2 and DI10 steps and the DI11 variables;
  - the launcher's DI8 link and the runtime's `dev_issuer_oidc_set`;
  - DI9's discovery option and `oidc_issuer_not_https`, with the named test;
  - DI10's handler exception, with tests that every other key, kind and posture is still refused.

  Its done-when is the issue's: a portal created by `npm create --template portal` signs a person
  in under `aw dev` and starts a run as them, and production refuses the development issuer.

- **U3.6-b (#1510)** builds the portal's `/sign-in` on the DI11 names and `aw.auth.exchange`, in
  English and Japanese.
- **The reference apps' journeys** (wiki, CRM and service desk) then run their agent-panel runs and
  the `RecipeGraph` approval as the signed-in person.

## Amendment — an app backend lists the person's runs of its agents (issue #1530, 2026-11-02)

Reason: an app's home Dashboard (`dashboardRoutes()` in `@indx-workspace/app/server`, issue #1522)
and the portal's Dashboard and `/runs` page read the run list as the signed-in person, with the
token of D1. D8 keeps `GET /api/runs` out of the grammar, so D9 refuses it as unauthenticated:
`/api/dashboard` answers `401` for every signed-in person, and the service desk's journey cannot
show the approval a run waits on (#1530 step 5). The person can read each of those runs by id
through the same token (D8's `runs read`), so the list shows nothing the token cannot already
read; what is missing is the collection.

- **D8 gains the collection.** The `app-backend` grammar's `{ runs, read }` cell also admits
  `GET /api/runs` (catalogue operation `runs.list`). This amends D8's sentence "`GET /api/runs`
  stays out" for this kind only: the `run` and `session` browser-token scopes still read one run
  by id and never the list.
- **D9's list follows.** `APP_BACKEND_OPERATIONS` gains `runs.list`, so `apps/web/proxy.ts` and
  `resolveActor` admit an `awo_live_` token on that route and on no other new one.
- **Which runs: the person's, of the client's agents.** The list is the one the person gets in the
  console (§21: Owner and Admin every run of the workspace, Builder and Viewer their own; the
  `user` filter only for a workspace-wide grant), **intersected with the agents the client binds**
  (`TokenScope.agentIds`, read on every request, D8). The handler adds that intersection to the
  query; it is never the caller's to ask for. An `agent` filter naming an agent the client does not
  bind is `403 token_out_of_scope`. So the list never shows a run the token could not read by id,
  and never a run of an agent outside the app. A run's agent is a row fact, so the narrowing lives
  in the list query, beside the own-grant owner filter, and not in `decide()`.
- **Unchanged.** Run feedback, files, sessions and every administration route stay out of the
  grammar. The run list's paging, filters and answer are the console's (spec §35).

### Consequences

- `GET /api/runs` with an `app-backend` token answers the narrowed list; the store's run-list
  filter gains an `agentIds` set (an `IN` on the session's agent), and both stores apply it.
- Spec §34's sentence naming the `app-backend` routes gains `GET /api/runs`.
- The app kit's Dashboard, the portal's Dashboard and `/runs` page, and the reference apps'
  journeys read the run list as the signed-in person with no change of their own.
