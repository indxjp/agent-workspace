# ADR-0142 — Tools learn who is asking: a signed identity assertion per run and a run subject

Status: D1 and D2 accepted, built by #1278, #1279 and #1280; D3 proposed until ADR-0104 is accepted — built by #1281
Date: 2026-10-18
Decided by: issue #1277 (Path to 100 P2-0, part of #1273)
Scope: `packages/contracts` (`project-file.ts`, `runs.ts`, a new `identity-assertion.ts`), `apps/web/server/compose/run-request.ts`, `packages/gateway/src/tools/openapi.ts`, `packages/sdk`

## Context

Credentials and grants belong to the agent. A connector holds one credential for every run of its
agent, a file grant covers every person who may run it, and nothing in a run says who is asking. Only
the code-tool host receives run headers today (`withToolHostRunHeaders` in
`apps/web/server/compose/run-request.ts`); MCP connectors and `openapiTool()` calls receive only the
connector credential (`packages/gateway/src/tools/openapi.ts`).

The gallery benchmark shows the cost: nine of the ten enterprise use cases cannot restrict what an
agent shows by person, and the tenth (customer inquiry) puts a backend-minted token in the prompt,
where the model can read, alter or omit it. A team works around the gap with one agent per department.

The gap was cited as RF-102, which is per-row connector-route authorization (shipped, #237). RF-102
governs who may manage a connector, not what a connector sees. Nothing tracked the real gap;
[ADR-0105](0105-surfaces-ship-a-widget-and-a-page.md) proposes identity linking for the widget, which
covers a different leg (browser to session, not run to tool). The gap is now roadmap N-8.

## Decision

- **D1. A run sends a signed identity assertion to connectors that opt in.** The header is
  `x-aw-identity: base64url(JSON{ sub, principalKind, workspace, runId, aud, exp }).base64url(HMAC-SHA256)`.
  - A connector opts in with `identity: { secret }` in `agent-workspace.yaml` and on the connector
    resource. `secret` is a secret reference, never a literal value. The key is per connector.
  - The payload has exactly those six keys. A verifier rejects a payload with another key, a bad
    signature, or an `exp` in the past.
  - **Lifetime.** `exp` is the signing time plus 300 seconds, in epoch seconds. The platform signs a
    fresh assertion for each outgoing connector request, so a long run is not a long token. A verifier
    allows 30 seconds of clock skew, no more.
  - **Audience.** `aud` is the connector's id. A connector refuses an assertion whose `aud` is not
    its own, so a token meant for one connector cannot be replayed to another, even when two share a
    secret by mistake.
  - **Replay.** None beyond the above, and no `jti`. A token is bound to one connector (`aud`), one
    workspace and one run, lasts at most 330 seconds, and travels only to the connector it was signed
    for. A single-use store would need state in every connector for a bearer that cannot reach another
    audience; a connector that wants it can key on `(runId, exp)` itself.
  - **Rotation.** The connector's server verifies with a list of secrets; the platform signs only
    with the current one. To rotate, the connector adds the new secret, the platform switches, and the
    old one is removed after at least 330 seconds (`exp` plus skew), so no assertion in flight fails.
  - **Minimisation.** The payload carries an opaque `sub`, the workspace and the run, and no email,
    name, role, team or other claim. A connector may log `sub`, `runId`, `workspace` and the
    verification outcome. It must not log the header, the signature or the secret, and the platform
    never logs them either.
  - **Tenant scope.** An assertion is valid only for its `workspace` claim. A verifier is given the
    workspace it serves and refuses any other by name; the platform signs a connector's assertion
    only for runs of the workspace that owns the connector.
  - **Revocation.** The platform stops signing at once when the run ends, when the principal's
    membership or key is removed or revoked, or when the connector's `identity` is removed. An
    assertion already sent stays valid until its `exp`, at most 300 seconds. Rotating the connector
    secret ends it earlier only once the old secret leaves the connector's list. A connector that
    cannot accept that window does not opt in.
  - **Refusals by name.** A verifier answers `identity_assertion_invalid` (bad signature, extra or
    missing key), `identity_assertion_expired`, `identity_audience_mismatch` and
    `identity_workspace_mismatch`; each is a 401 that never echoes the token.
  - A connector without `identity` receives no header.
  - Signing and verifying are one pair of pure functions in `packages/contracts`
    (`signIdentity` / `verifyIdentity`, WebCrypto HMAC, no new dependency), so a connector's server
    verifies with the same code the platform signs with.
  - **An engine or connector that cannot carry the identity is refused by name**, following
    [ADR-0065](0065-an-agents-engine-is-an-extension-point-behind-one-port.md) D3: `422
    connector_identity_unsupported`, when the connector is saved. It covers a connector that cannot
    set a request header (`stdio`; a `postgres` connector has no `identity` field at all). A run that
    reaches a connector which opted in, with no caller to assert or no signing secret to sign with,
    is refused the same way at run compose, before its run token is issued. The run is never started
    without the identity the connector asked for.
- **D2. `StartRunRequest.subject` names the person an API-key caller acts for.** It is an opaque
  string of 1 to 256 characters.
  - Only an API-key caller may set it: a backend acting for its own users. The assertion's `sub` is
    the subject, with `principalKind: 'api-key'` saying it was asserted by a key.
  - A signed-in user's run takes the user's own principal as `sub`, with `principalKind:
    'membership'`. A user session or a browser token that sends `subject` is refused with `403
    run_subject_forbidden`.
  - **Anonymous surface visitors** ([ADR-0105](0105-surfaces-ship-a-widget-and-a-page.md)) have no
    principal. Their assertion has `principalKind: 'visitor'` and `sub` is the visitor session id: an
    opaque value that names one conversation, not a person, and changes with the next one. A
    connector that needs a person sees the named kind and refuses it. The `visitor` kind belongs to
    the assertion's vocabulary only; `PRINCIPAL_KINDS` in `team.ts` stays `membership` and `api-key`.
    Linking a visitor to a person is the identity linking ADR-0105 keeps proposed, and not decided
    here.
  - The server honours `subject` for an API-key caller and refuses it from any other caller with
    `403 run_subject_forbidden`. A public field is honoured or refused by name, never silently
    ignored. An API key that sets no `subject` has no caller to assert, so its run is refused when a
    connector opted in.
- **D3. Per-person file grants follow as a second step.** Status: proposed, because it depends on
  [ADR-0104](0104-a-team-is-a-resource.md), which defines teams and is still proposed. A grant path
  may carry a team placeholder, `files('deals/{team}')`. `{team}` does not resolve from a claim of
  the assertion, which carries no team; the server resolves it from the run principal, that is the
  `workspace` and `sub` the run was composed for, against the teams ADR-0104 defines. A run whose
  principal is a `visitor`, an API-key `subject` (which names no platform principal), or a member of
  no team gets no grant (fail closed). Decided here in principle and built only after ADR-0104 is
  accepted.
- **Build order**: #1278 (contract, sign and verify, the two fields refused by the server), then
  #1279 (send the header by generalising `withToolHostRunHeaders`, and the 403), then #1280 (the SDK
  and the gallery connectors verify and filter by subject) and #1281 (the team placeholder in file
  grants). The gallery probe `run-caller-identity` flips with #1278.
- **Out of scope**: OAuth per end user, and the widget identity linking of ADR-0105. ADR-0105 may
  later become the source of `subject` for a hosted surface; that is a separate decision.

## Alternatives considered

- **OAuth per end user.** Rejected for v1. It needs a consent flow, token storage and refresh per
  person per connector. The assertion tells a connector who is asking; whether that person may see a
  record stays the connector's rule.
- **A JWT library.** Rejected. It is a new dependency for a job WebCrypto HMAC does in a few lines,
  and a library invites algorithm-negotiation mistakes. The format is fixed to HMAC-SHA256.
- **The identity in the prompt.** What customer inquiry does today. Rejected as the platform answer:
  the model can alter or drop it, and a prompt is not a trust boundary.
- **One credential per run for each connector.** Rejected. The platform would hold a minted credential
  for every connector API, and a connector would need to understand platform-issued credentials.
- **The assertion on every connector.** Rejected. Sending a person's identity to a server that did
  not ask for it is a disclosure; the connector owner opts in.

## Consequences

- A connector that opts in can scope, mask and audit by person, and the one-agent-per-department
  workaround can go. The ten gallery scope cells move from a documented gap to the platform's answer
  as #1278 to #1281 land.
- The platform now holds a signing secret per opted-in connector. It is stored like the connector
  credential: write-only, never returned, never logged.
- An opted-in `openapi` connector is sent an assertion signed per call at the gateway. An opted-in
  MCP `http` or `sse` connector is dialled by the engine, so its assertion is signed once when the
  run is composed and lives 300 seconds; a longer run reaches it with an expired assertion, which
  fails closed. `aw dev` passes `identity` through like `aw deploy`: the server resolves the named workspace
  secret (`aw secrets set`) at run compose, and a missing secret is refused by name.
- The roadmap tracks the gap as [N-8](../sdk/site/concepts/roadmap.mdx#n-8-tools-learn-who-is-asking), and RF-102 points to it.
