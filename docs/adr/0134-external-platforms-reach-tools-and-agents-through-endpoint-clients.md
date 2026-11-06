# ADR-0134 — External platforms reach tools and agents through endpoint clients

Status: accepted
Date: 2026-10-11
Decided by: the issue #949 plan (T1a, part 1 of the platform-targets programme), reviewed in the pull request
Scope: `packages/core/src/db/schema/endpoint-client*.ts`, `migrations/0048_create_endpoint_clients.sql`, `packages/core/src/db/repositories/{endpoint-clients,directory}.ts`, `packages/contracts/src/endpoint-clients.ts`, `apps/web/server/rbac/`, `apps/web/server/endpoint-clients/`, `apps/web/app/api/endpoint-clients/`; the MCP project endpoint (T1b), the OAuth token endpoint (T1c) and the A2A endpoint (G1) build on it

## Context

External agent platforms (Claude Managed Agents, Copilot Studio, M365, Foundry, AgentCore, Gemini
Enterprise) must call a deployment: the project's code tools over MCP and a published agent over
A2A. The only long-lived machine credential was a workspace API key, which carries one of the four
roles and nothing narrower. A key pasted into a vendor vault could call every catalogue route its
role allows. The only attenuation was the browser token's `TokenScope`, enforced by `decide()`'s
scope grammar, and it lives at most an hour.

## Decisions

1. **One credential model for all external platforms.** An _endpoint client_ is a workspace row that
   names exactly one resource: an MCP project tool endpoint (`kind: 'mcp-project'`, T1b) or one
   agent's A2A endpoint (`kind: 'a2a-agent'`, G1). A credential is bound to a client, never
   free-floating: (a) an _endpoint-scoped API key_ (a static bearer; this change), and (b) an OAuth
   2.1 access token (T1c, for platforms that accept nothing else).
2. **Fail-closed attenuation through the existing scope grammar.** A credential bound to a client
   yields a `Principal` whose `scope` is non-null, so `decide()` refuses every route outside the
   scope's grammar with `403 token_out_of_scope`. No existing route changes to refuse it. The grammar
   of `a2a-agent` is `POST /api/agents/:id/runs` on the bound agent only; `mcp-project` has no
   catalogue route (T1b serves its own endpoint).
   _Amended by [ADR-0161](0161-an-app-backend-acts-as-the-signed-in-person-by-token-exchange.md) D4 and D8:_ a fourth kind, `app-backend`, whose grammar is running a bound agent, reading and interrupting one run by id, and `GET /api/me`.
3. **Acting identity.** A static key acts for the client's `actsForPrincipalId`, the member that
   created it, through the existing acts-for mechanism (`Principal.ownerPrincipalId`). This mirrors
   ADR-0105's surface publisher. Runs an external platform starts are owned by, and visible to, that
   member. The key's role is `builder`.
4. **Not adopted.** A JSONB scope list on `api_keys` (the schema's own header rejects it); reusing
   `browser_tokens` (wrong lifetime and name); per-agent MCP URLs (one project URL, translators
   restrict tools per agent).
5. The ADR-0118 TS3 amendment (the gateway stays the only caller of a tool sandbox) is recorded by T1b.

## Consequences

- Revoking a client revokes every key bound to it, in one transaction; the row stays so the
  revocation is auditable.
- A client is created by a session; an API key is refused (`403 api_key_not_permitted`), since the
  client would otherwise act for no member.
- A key's plaintext is shown once, by the mint response; only its hash is stored.
- The bound key is joined by `endpoint_client_api_keys` (key id to client id) rather than by a column
  on `api_keys`, because `endpoint_clients` already references the workspace principals that
  `api_keys` also references, and a column back into it made the schema modules import each other.
  A key belongs to at most one client, enforced by the join table's primary key.

## Part 2 — the MCP project endpoint (T1b, issue #967)

Amends decision 5 and fills in decision 2 for `mcp-project`.

6. **`POST /mcp/projects/{name}` serves the project's code tools.** The path is outside `/api`
   (spec §34 prints it), so it is catalogued with `security: 'endpoint-credential'` and the edge
   admits it by the same rule as the A2A routes. It accepts an endpoint-scoped API key only (a session
   or browser token gets `403 tool_endpoint_credential_not_accepted`) whose client is the named,
   unrevoked `mcp-project` client of the caller's workspace; every other name is `404`. Any other
   method is `405` with `Allow: POST`, a body over 1 MiB is `413 tool_endpoint_body_too_large`, and
   an `MCP-Protocol-Version` other than `2025-06-18` or `2025-03-26` is
   `400 mcp_protocol_version_unsupported`. It speaks `initialize` and `ping` itself, so connecting
   never starts a sandbox, and forwards `tools/list` and `tools/call`; a message with no `id` is a
   notification and gets `202`. The tools are the production-pointed code tool bundles of the
   client's agents, narrowed by `toolNames`; with none, `tools/list` is empty and `tools/call` is
   `-32602`. Two agents pinning one tool name to different code is JSON-RPC `-32603` with
   `data.code: tool_name_conflict`, not a pick, and a tool the sandbox request cannot be built for is
   `-32603` with the builder's code (`code_tool_unbundled`, …) rather than a `503`.
7. **The gateway stays the only caller of a tool sandbox (amends ADR-0118 TS3).** The control plane
   never dials a sandbox. It signs a 60-second _endpoint grant_ (`awg.<payload>.<sig>`, kind
   `tool-endpoint`, bound to the workspace and client) and calls the gateway's
   `POST /v1/tool-sandbox/endpoint/mcp`, which verifies it and derives the sandbox bearer itself. The
   runner manager opens the sandbox under the run id `endpoint-<clientId>`. The workspace's default
   runtime profile and its provider credential open it; with no default profile the call is
   `503 tool_endpoint_unavailable` and nothing is forwarded.
   Revoking the client, one of its endpoint keys or an OAuth grant (including a replayed refresh
   token) closes that sandbox through the runner manager, best effort: the revoke has already
   happened and the handler refuses the client, so a failed close is logged by error class only and
   the sandbox's idle timeout is the backstop.
8. **Acting identity is checked per agent.** The key acts for a member, so each of the client's agents
   must be runnable by that member (`requireRunPermission`) on every call; one that is not, or is
   gone, leaves the union of tools rather than refusing the call. Each `tools/call` writes an
   `endpoint-tool-called` audit row before the sandbox is reached.
9. **Limits.** The endpoint is rate limited per key (120 calls a minute), the limiter admitting right
   after the credential is identified; refusals count, an absent credential does not.

## Part 3 — the OAuth 2.1 authorization server (T1c, issue #971)

Fills in decision 1(b): platforms that accept only OAuth (Microsoft 365 MCP plugins, Gemini
Enterprise's `serverSideOauth2`) obtain an access token bound to one endpoint client.

10. **A minimal OAuth 2.1 subset, no library.** Grants: `authorization_code` with PKCE `S256` only,
    `client_credentials` (confidential clients only) and `refresh_token` with rotation. No implicit,
    password or device grant. Client authentication is `client_secret_basic`, `client_secret_post` or
    `none` (a public client: PKCE is then the only proof). The token surface is the API-key one
    (`<prefix><22-char id>_<43-char secret>`, SHA-256 of the secret stored, Web Crypto for PKCE):
    `awc_live_` (code, 60 s, single use), `awo_live_` (access, 1 h), `awr_live_` (refresh, 30 d).
11. **Clients are endpoint clients; no dynamic registration.** The OAuth `client_id` is the endpoint
    client's id, registered by hand in each platform. A client names exactly one resource URL,
    `${AW_PUBLIC_URL}/mcp/projects/{name}` or `${AW_PUBLIC_URL}/api/a2a/agents/{name}`, and that URL is
    the token's audience. `resource` (RFC 8707), when sent, must equal it (`invalid_target`). There is
    one scope, `endpoint`; narrowing lives in the client binding. Redirect URIs are exact strings
    (at most 10), set on the client with `PATCH`; the confidential secret is minted, and rotated, by
    `POST /api/endpoint-clients/:id/secret` and shown once.
12. **The issuer is `AW_PUBLIC_URL`.** RFC 8414 and RFC 9728 metadata are pure functions of it and the
    path; the protected-resource document never reads the database. With it unset every OAuth and
    metadata route is `404 oauth_not_configured` and the endpoints keep accepting static keys.
13. **Consent by a signed-in member.** `/oauth/authorize` needs the control-plane session itself
    (an API, browser, user or OAuth token is refused) and only finds clients of the session's
    workspace. The member must be able to run every agent of the client. The token's subject is that
    member's membership principal, re-read on every request, so removing the member kills the token;
    for `client_credentials` the subject is the client's `actsForPrincipalId`.
14. **Reuse is theft.** A code exchanged twice, or a refresh token presented after rotation, revokes
    the whole family (`family_id`: one authorization and its chain of tokens) and answers
    `invalid_grant`. Single use is an atomic `UPDATE ... WHERE used_at IS NULL`. Revoking a client
    kills its tokens at lookup time (the lookup joins the unrevoked client), so T1a's revoke
    transaction does not change.
15. **Tokens are admitted only at the two endpoints, for their own audience.** The identity path
    resolves `awo_live_` only on an agent-endpoint route, because the `a2a-agent` grammar also allows
    `POST /api/agents/:id/runs`, which would otherwise be a second way in. The principal carries
    `via: 'oauth-token'`, the endpoint scope and an `audience`; both endpoint handlers answer
    `401 invalid_token` unless the audience is their own URL, and every endpoint `401` carries
    `WWW-Authenticate: Bearer resource_metadata=...`. The access token is never forwarded.
    _Amended by [ADR-0161](0161-an-app-backend-acts-as-the-signed-in-person-by-token-exchange.md) D9:_ a token whose client is the `app-backend` kind is also admitted on exactly that kind's grammar routes (`POST /api/agents/:id/runs` on a bound agent, `GET /api/runs/:id`, `GET /api/runs/:id/events`, `POST /api/runs/:id/interrupt`, `GET /api/me`), read from one list by the proxy and `resolveActor`.
16. **Limits.** `/oauth/token` and `/oauth/revoke` admit 120 a minute per address and 60 a minute per
    client, the client counted only after it authenticated: a `client_id` is public, so counting it
    earlier would let anyone lock a client out by naming it. Guessing a secret is bounded by the
    failed client authentications of the source address instead (10 a minute, checked before the
    secret is). `POST /oauth/authorize` admits 30 a minute per session. A refusal is `429` with
    `Retry-After` and `{ "error": "temporarily_unavailable" }`.
17. **Migration number.** The issue reserved `0049`, but `0049_add_runtime_verifications` landed first;
    this change is `0050_add_oauth_to_endpoint_clients`. It is additive (nullable or defaulted
    columns, one new table), so the previous revision keeps running during a rollout.
18. **Not adopted.** Dynamic client registration (RFC 7591), JWT access tokens, token introspection
    (RFC 7662) and federation to Entra or Google as the identity provider: no target needs them.
    _Amended by [ADR-0161](0161-an-app-backend-acts-as-the-signed-in-person-by-token-exchange.md):_ exchanging an ID token from the deployment's one configured `OIDC_ISSUER_URL` for an `app-backend` access token is allowed. It is not federation: the platform accepts no other issuer and provisions no identity.

19. **`next` is same-origin only; revocation audits once.** The sign-in page and the OIDC login carry
    `next` through to the destination, and it is honoured only as a relative path on this origin
    (`safeNextPath`: no scheme, host, backslash or control character), re-checked where it is used.
    A revoke is one atomic `UPDATE ... WHERE revoked_at IS NULL RETURNING`, so concurrent revocations
    of one token write one audit event. The consent page reads the client's agents from the database
    and shows the error page, not a shorter list, if one no longer exists. The check that the member
    can run every agent of the client also reads the agents and grants from the database, through the
    same `ownershipOf` rule as `POST /api/agents/:id/runs`, so it does not need the agents runtime.

Consequences: a visitor without a session is sent to `/signin?next=<authorize URL>` and returns to
the authorize page after signing in with a password, a single-workspace SSO, or the workspace
picker (`next` travels as a query parameter and a hidden field and is re-checked on every read).
Invitation sign-ins still land on `/`: a user without a membership cannot consent to any client,
and there is no in-app invitation page to carry `next` through. Whether Teams and Gemini send a
`scope` value is pending manual vendor verification; an absent scope is treated as `endpoint`.
