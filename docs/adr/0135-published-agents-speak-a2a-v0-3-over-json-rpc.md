# ADR-0135 — Published agents speak A2A v0.3 over JSON-RPC

Status: accepted
Date: 2026-10-11
Decided by: the issue #955 plan (G1, part of the platform-targets programme of issue #949), reviewed in the pull request
Scope: `packages/contracts/src/a2a.ts`, `packages/contracts/src/routes.ts`, `apps/web/server/a2a/`, `apps/web/server/composition/register.ts` (the A2A environment), `apps/web/server/endpoints/public-url.ts`, `apps/web/server/auth/agent-endpoint-routes.ts`, `apps/web/app/api/a2a/`, `apps/web/proxy.ts`, `apps/web/server/runs/api.ts` (`interruptRunFor`); the platform translators (P8, U3b) and the OAuth token endpoint (T1c) build on it

## Context

Agent platforms that consume agents (Gemini Enterprise, Copilot Studio, Foundry, AgentCore) speak
the Agent2Agent protocol. ADR-0134 gave them a credential (an endpoint-scoped key of an `a2a-agent`
client); nothing yet answered the call. A published agent must be reachable over A2A without a new
runtime path: every message is an ordinary run.

## Decisions

1. **Binding.** A2A v0.3.0, JSON-RPC 2.0 over HTTP, with `message/send`, `message/stream` (SSE; each
   `data:` is a full JSON-RPC response), `tasks/get` and `tasks/cancel`. `tasks/resubscribe`, the
   `agent/getAuthenticatedExtendedCard` answer `-32004` `UnsupportedOperationError`; the
   push-notification methods answer `-32003` `PushNotificationNotSupportedError` (the A2A v0.3
   error-code table, <https://a2a-protocol.org/v0.3.0/specification/#82-a2a-specific-errors>); the
   card says `capabilities.pushNotifications: false`.
2. **Version dispatch.** `apps/web/server/a2a/dispatch.ts` reads `A2A-Version` (header, else the
   query parameter of that name). Absent, empty, `0.3` or `0.3.0` select the v0.3 binding
   (`apps/web/server/a2a/v0_3/`); anything else is `400 a2a_version_unsupported` naming the served
   version. A later v1.0 is a sibling `v1_0/` module and one dispatch arm.
3. **Mapping.** `contextId` is our session id and a task `id` is our run id; one `message/send` is
   one run. A message that names a `taskId` is `-32004` ("each message starts a new task; continue
   the conversation with `contextId`"): our runs never wait for input. Only `user` messages with
   text parts are accepted (`-32005` otherwise).
4. **What runs.** The version the agent's `production` pointer names. A new context pins it through
   `startRunOnSession`'s `agentVersionId`. An agent with no `production` pointer is not served:
   `404 a2a_agent_not_found`, the same body as an unknown name or another workspace's agent.
5. **Paths.** `POST /api/a2a/agents/{agentName}` (JSON-RPC) and
   `GET /api/a2a/agents/{agentName}/.well-known/agent-card.json` (card). `agentName` is unique per
   workspace; the workspace comes from the credential. The two literal shapes are named exceptions
   in `tests/route-inventory.test.ts`'s `routeShape` (beside `/api/me`): `a2a` is a protocol prefix,
   not a plural resource, and the card path is deeper than `/api/<resource>/:id/<sub>`. `decide()`'s
   path parser cannot read them, so authorisation is decided on the canonical shape
   `POST /api/agents/{id}/runs` with the same run-ownership resolution the run route uses. Spec §34
   prints both routes; because `a2a` is not a resource, `permissions.test.ts` exempts it by name
   (`PROTOCOL_PREFIXES`) and asserts that §34 still prints it and that it is not in `RESOURCES`.
6. **Credentials.** (a) an endpoint-scoped key of an `a2a-agent` client for this agent (ADR-0134);
   (b) an ordinary workspace API key whose role may run the agent; (c) after T1c, an OAuth access
   token whose audience is this endpoint's URL. A session cookie or browser token is refused
   (`403 a2a_credential_not_accepted`): the endpoint is for machines. A key that is not bound to the
   agent (an endpoint-scoped key for another agent, or an `mcp-project` key) answers the unknown-name
   `404 a2a_agent_not_found`, never `403`, so a credential cannot learn which agent names exist; a
   key whose role may not run agents at all stays `403`. A request with an `Origin`
   header is refused (`403 origin_not_allowed`): no browser calls it. The route is exempt from the
   proxy's session gate (`isAgentEndpointRoute`, checked before the API-key gate) and authenticates
   the bearer itself; `ApiRouteSecurity` gains `endpoint-credential`.
7. **Public URL.** The card's `url` is `${AW_PUBLIC_URL}/api/a2a/agents/{agentName}`. `AW_PUBLIC_URL`
   is an https origin with no path (loopback http is allowed), parsed by
   `apps/web/server/endpoints/public-url.ts`; T1c reuses it as the OAuth issuer. Unset, the card
   route answers `503 a2a_public_url_not_configured`; JSON-RPC still works. The deploy tooling
   delivers it: `aw deploy` writes it into the `.env` (Compose, Vercel, Cloud Run's `public_url`
   Terraform variable) and into the Helm overlay (`publicUrl`); `agent-workspace render` renders the
   `.env` value as `public_url` for the gcp-cloudrun and azure-container-apps modules and as
   `publicUrl` in the v1 Helm overlay; on Cloudflare the `.env` line reaches the control-plane
   Worker's secrets like any other project variable. Unset, every rendered artefact is
   byte-identical to before.
8. **Limits.** The route is reachable without a session, so it has its own limits: per credential,
   120 calls per minute of any kind, of which at most 30 may be `message/send`/`message/stream`
   (`429 a2a_rate_limited`, `Retry-After`). The 120 are spent right after the credential is
   identified, keyed on the key id and before the agent is looked up, so a 404 or 403 answer costs
   budget like any other. There is also a 256 KiB body cap (`413 a2a_body_too_large`) and a 120 s
   cap on a blocking `message/send`. The limiter is per process; a deployment with several instances multiplies it.
9. **Audit.** No new audit event. The run row records the owner and initiating principal, which is
   the durable record of who asked an agent what; logs never carry the bearer, a prompt or an
   answer.
10. **Streaming.** `message/stream` answers `text/event-stream`: the Task (`submitted`), a `working`
    status update, one artifact update per assistant text block (`response`, appended after the
    first), then the final status update (`final: true`; a failed run carries a safe error). A client
    that disconnects does not cancel the run; `tasks/cancel` does.

## Checked against the specification

The card's `protocolVersion` is `0.3.0` and its bearer scheme is `{ type: 'http', scheme: 'bearer' }`.
Both were checked against the A2A v0.3.0 JSON schema (`a2a.json`, tag `v0.3.0`): `protocolVersion` is
a free `string` defaulting to `"0.3.0"`, which is what the card emits and what Google's REST
registration examples for Gemini Enterprise use; `HTTPAuthSecurityScheme` requires `scheme` and
`type`, and `type` is the constant `"http"`. The
excerpt is committed as `packages/contracts/src/__fixtures__/a2a-spec.v0_3_0.agent-card.json` and
`packages/contracts/src/a2a.test.ts` holds the card against it.

## Not adopted

An A2A SDK dependency (the four methods are small and the wire shapes are in `packages/contracts`);
a new task store (a task is a run); per-method audit events; gRPC and HTTP+JSON bindings.

## Consequences

- The OpenAPI document describes the JSON answer of the route. The event stream is described here,
  because the route catalogue carries one body kind per status.
- The in-process limiter does not share state between instances (`ponytail:` note in
  `apps/web/server/a2a/limits.ts`); a shared limiter is a follow-up if a deployment scales out.

## Amendment — the agent card is public discovery metadata (issue #1076, 2026-10-12)

Gemini Enterprise reads the card before it registers an agent, and `aw platforms publish` reads it
before it plans the registration; neither holds a credential at that point, and A2A discovery is
unauthenticated by design. Decisions 5 and 6 are amended for the card only:

- `GET /api/a2a/agents/:agentName/.well-known/agent-card.json` with neither `Authorization` nor
  `Cookie` is served, for the published agent of the deployment's workspace (`WORKSPACE_SLUG`,
  resolved as the hosted surfaces resolve theirs). The URL carries no workspace, so a credential-less
  card is the deployment workspace's.
- The card holds the name, description, skills and security scheme and the address already in it; no
  secret, no agent, version or workspace id.
- An unknown name, an unpublished agent and an agent of another workspace answer the same 404.
  A browser `Origin` is still refused (403).
- It is counted per client address, 60 a minute (a shared bucket ten times that where
  `AW_TRUSTED_PROXY_HOPS` is unset), answering 429 `a2a_rate_limited` with `Retry-After`.
- A request with a credential meets decisions 5 and 6 unchanged, so a caller of another workspace
  still reads its own card.
- Every other A2A path (`message/send`, `message/stream`, `tasks/get`, `tasks/cancel`) still answers
  401 to a request with no credential.

Not adopted: fetching the card with the endpoint client's OAuth credentials (the executor would
work, Gemini's own fetch would not). Not done: the OpenAPI entry still lists the card under bearer
authentication; marking it optional is a follow-up, as is a workspace-qualified card URL for a
deployment that publishes agents outside `WORKSPACE_SLUG`.
