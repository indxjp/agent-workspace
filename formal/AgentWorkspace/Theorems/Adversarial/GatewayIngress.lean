import AgentWorkspace.Theorems.Normative.GatewayIngress

/-!
T3 for `gateway-ingress`: what an attacker cannot get out of the new front door.

Two claims, each stated for every protocol rather than for one:

* **Authentication.** No dialect forwards anything upstream without a valid, unexpired, unrevoked
  run token — and what it forwards names only its own connection's credential and model.
* **Credential isolation.** The upstream request never carries the caller's run token, and the
  client-visible response never carries the stored provider credential. Both directions are closed
  allowlists, and an allowlist is the only form of this rule that fails closed.
-/

namespace AgentWorkspace.Theorems.Adversarial.GatewayIngress

open AgentWorkspace AgentWorkspace.Authz.RunToken
open AgentWorkspace.Behaviour.GatewayIngress
open AgentWorkspace.Concepts.Usage
open AgentWorkspace.Theorems.WellFormed.GatewayIngress (clean)

/-! ## Authentication -/

/-- Nothing is forwarded on any protocol unless `authenticateGatewayRequest` allows the request.
The authentication order is the one `Authz.RunToken` already proves, not a second copy of it. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/auth.ts#authenticateGatewayRequest")
  (ts := "packages/gateway/src/router.ts#forwardProtocol")]
theorem a_denied_request_is_never_forwarded (r : Request) (status : Nat) (code : String)
    (h : authenticate r.hasBearer r.verification r.expectedRunId r.resolution = .deny status code) :
    ingressDecision r = .answered status code := by
  unfold ingressDecision; rw [h]

/-- No protocol forwards without a bearer token at all. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/auth.ts#authenticateGatewayRequest")]
theorem no_protocol_forwards_without_a_bearer (r : Request) (h : r.hasBearer = false) :
    ingressDecision r = .answered 401 "token_missing" := by
  unfold ingressDecision authenticate; simp [h]

/-- No protocol forwards on an invalid signature or a malformed claims set. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/tokens/run-token.ts#createRunTokenCodec")]
theorem no_protocol_forwards_on_an_invalid_token (r : Request) (hb : r.hasBearer = true)
    (h : r.verification = .invalid) :
    ingressDecision r = .answered 401 "token_invalid" := by
  unfold ingressDecision authenticate; simp [h, hb]

/-- No protocol forwards on an expired token. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/auth.ts#authenticateGatewayRequest")]
theorem no_protocol_forwards_on_an_expired_token (r : Request) (hb : r.hasBearer = true)
    (h : r.verification = .expired) :
    ingressDecision r = .answered 401 "token_expired" := by
  unfold ingressDecision authenticate; simp [h, hb]

/-- No protocol forwards on a revoked token, however well formed its claims are. -/
@[aw_spec (tier := T3) (ts := "packages/core/src/db/repositories/run-tokens.ts#isActive")]
theorem no_protocol_forwards_on_a_revoked_token (protocol : WireProtocol)
    (family : ConnectionFamily) :
    ingressDecision { clean protocol family with resolution := .revoked } =
      .answered 401 "token_revoked" := by
  cases protocol <;> cases family <;> decide

/-- A token minted for one run never reaches another run's connection, whatever the protocol: the
expected-run check happens before the resolver is consulted at all. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/auth.ts#authenticateGatewayRequest")]
theorem a_token_for_another_run_is_never_forwarded (r : Request) (claims : Claims) (other : String)
    (hb : r.hasBearer = true) (hv : r.verification = .valid claims)
    (he : r.expectedRunId = some other) (hne : other ≠ claims.runId) :
    ingressDecision r = .answered 403 "token_run_mismatch" := by
  unfold ingressDecision authenticate; simp [hv, he, hb, hne]

/-- Every unauthenticated outcome, across the whole protocol × family product, forwards nothing.
The witness for the statements above, spelled out cell by cell. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/auth.ts#authenticateGatewayRequest")]
theorem no_unauthenticated_cell_forwards :
    ([Resolution.revoked, .deleted, .missing]).all (fun resolution =>
      (WireEnum.all (α := WireProtocol)).all fun protocol =>
        ConnectionFamily.all.all fun family =>
          !(ingressDecision { clean protocol family with
            resolution := resolution }).forwardedUpstream) = true := by decide

/-! ## The token only ever reaches its own connection -/

/-- A forwarded request carries the run's own stored credential and nothing else. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/providers/passthrough.ts#upstreamHeaders")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d7--both-header-directions-are-closed-allowlists")]
theorem a_forwarded_request_carries_its_own_credential (r : Request) (up : UpstreamRequest)
    (h : ingressDecision r = .forwarded up) : up.credential = r.connection.credential := by
  unfold ingressDecision at h
  split at h
  · cases h
  · repeat' split at h
    · cases h
    · cases h
    · cases h
    · cases h
    · cases h
    · cases h; rfl

/-- A forwarded request names this connection's own model: the client's, or the deployment the
connection pins. Never a third thing, and never another connection's. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/providers/passthrough.ts#relayedBody")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d8--model-enforcement-mirrors-today-the-acceptance-criterion-is-amended")]
theorem a_forwarded_request_names_its_own_model (r : Request) (up : UpstreamRequest)
    (h : ingressDecision r = .forwarded up) :
    up.model = r.requestedModel ∨ up.model = r.connection.deployment := by
  unfold ingressDecision at h
  split at h
  · cases h
  · repeat' split at h
    · cases h
    · cases h
    · cases h
    · cases h
    · cases h
    · cases h
      simp only [relayedModel]
      split
      · exact Or.inr rfl
      · exact Or.inl rfl

/-- A forwarded request keeps the protocol it arrived on. A Chat Completions request cannot be
smuggled onto the Responses endpoint, or the other way round. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/router.ts#forwardProtocol")]
theorem a_forwarded_request_keeps_its_protocol (r : Request) (up : UpstreamRequest)
    (h : ingressDecision r = .forwarded up) : up.protocol = r.protocol := by
  unfold ingressDecision at h
  split at h
  · cases h
  · repeat' split at h
    · cases h
    · cases h
    · cases h
    · cases h
    · cases h
    · cases h; rfl

/-! ## Credential isolation, in both directions -/

/-- Every header the gateway sends upstream is one of exactly three things: the substituted
credential, the fixed `content-type`, or a client header the allowlist admitted. Nothing else is
relayed, so the caller's own collection cannot smuggle a header through. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/providers/passthrough.ts#upstreamHeaders")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d7--both-header-directions-are-closed-allowlists")]
theorem upstream_headers_are_exactly_the_allowlist (family : ConnectionFamily)
    (credential : String) (clientHeaders : List Header) :
    ∀ h ∈ upstreamHeaders family credential clientHeaders,
      (h.name = family.credentialHeader ∧ h.value = credential) ∨
        h = ⟨"content-type", "application/json"⟩ ∨
        (h ∈ clientHeaders ∧ travelsUpstream h.name = true) := by
  intro h hmem
  simp only [upstreamHeaders, List.mem_cons, List.mem_filter] at hmem
  rcases hmem with rfl | rfl | ⟨hin, hallow⟩
  · exact Or.inl ⟨rfl, rfl⟩
  · exact Or.inr (Or.inl rfl)
  · exact Or.inr (Or.inr ⟨hin, hallow⟩)

/-- The caller's run token never travels upstream. It arrives in `authorization`, which the
allowlist does not admit, so no relayed client header carries it — and the gateway's own
`authorization` carries the substituted credential instead. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/providers/passthrough.ts#upstreamHeaders")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d7--both-header-directions-are-closed-allowlists")]
theorem no_relayed_client_header_carries_the_run_token (runToken : String)
    (clientHeaders : List Header)
    (hbearer : ∀ h ∈ clientHeaders, h.value = runToken → h.name = "authorization") :
    ∀ h ∈ clientHeaders.filter (fun h => travelsUpstream h.name), h.value ≠ runToken := by
  intro h hmem hv
  simp only [List.mem_filter] at hmem
  have hname := hbearer h hmem.1 hv
  rw [hname] at hmem
  exact absurd hmem.2 (by decide)

/-- The `authorization` header a caller sent is dropped rather than relayed, so an
`Authorization: Bearer <run token>` cannot reach the upstream even by accident. The list is closed by
name: `openai-organization` and `openai-project` do not travel either, so the caller cannot choose
which account on the stored credential serves and is billed for the turn (ADR-0068 D7, D10). -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/providers/passthrough.ts#UPSTREAM_HEADERS")]
theorem the_callers_authorization_header_is_dropped :
    travelsUpstream "authorization" = false ∧ travelsUpstream "cookie" = false ∧
      travelsUpstream "x-api-key" = false ∧ travelsUpstream "openai-organization" = false ∧
      travelsUpstream "openai-project" = false ∧ travelsUpstream "openai-beta" = true := by decide

/-- The client-visible response never carries the stored credential, because it is rebuilt from a
name allowlist that contains no credential-bearing header. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/providers/passthrough.ts#CLIENT_RESPONSE_HEADERS")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d7--both-header-directions-are-closed-allowlists")]
theorem the_client_response_never_carries_the_credential (upstream : List Header)
    (credential : String)
    (hcarrier : ∀ h ∈ upstream, h.value = credential → clientVisibleHeaders.contains h.name = false) :
    ∀ h ∈ clientResponseHeaders upstream, h.value ≠ credential := by
  intro h hmem
  simp only [clientResponseHeaders, List.mem_filter] at hmem
  intro hv
  have := hcarrier h hmem.1 hv
  rw [this] at hmem
  exact absurd hmem.2 (by simp)

/-- No credential-bearing or session-bearing upstream header name is in the client allowlist. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/providers/passthrough.ts#CLIENT_RESPONSE_HEADERS")]
theorem the_client_allowlist_holds_no_credential_header :
    (["set-cookie", "authorization", "api-key", "x-api-key", "openai-organization",
      "openai-project"]).all (fun name => !clientVisibleHeaders.contains name) = true := by decide

/-- A refusal sends nothing upstream at all, so neither allowlist is even reached: the hosted-tool
and wrong-protocol rules are decided before any network call. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/providers/passthrough.ts#createWireProtocolForwarder")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d4--hosted-tools-are-refused-by-a-closed-allowlist")]
theorem a_refused_request_reaches_no_upstream :
    (ingressDecision { clean .openaiResponses .openai with
      tools := [.webSearch] }).forwardedUpstream = false ∧
    (ingressDecision { clean .openaiChatCompletions .openai with
      hostedToolField := true }).forwardedUpstream = false ∧
    (ingressDecision { clean .openaiResponses .openai with
      background := true }).forwardedUpstream = false ∧
    (ingressDecision { clean .openaiResponses .openai with
      vendorState := true }).forwardedUpstream = false ∧
    (ingressDecision (clean .openaiResponses .anthropic)).forwardedUpstream = false ∧
    (ingressDecision { clean .openaiResponses .openai with
      resolution := .revoked }).forwardedUpstream = false := by decide

/-! ## The tool routes (ADR-0113 C16, ADR-0118 TS3) -/

/-- The tool routes are never metered: they are dispatched before the model boundary. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/index.ts#createGatewayApplication")
  (ts := "packages/gateway/src/auth.ts#meteredProtocol")]
theorem tool_ingress_is_unmetered :
    Ingress.tool.metered = false ∧ Ingress.toolSandbox.metered = false ∧
      Ingress.toolSandboxEndpoint.metered = false := ⟨rfl, rfl, rfl⟩

/-- The tool routes never resolve, and so never decrypt, the run's model key. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/index.ts#createGatewayApplication")]
theorem tool_ingress_never_resolves_a_model_key :
    Ingress.tool.resolvesModelKey = false ∧ Ingress.toolSandbox.resolvesModelKey = false ∧
      Ingress.toolSandboxEndpoint.resolvesModelKey = false :=
  ⟨rfl, rfl, rfl⟩

/-- The application's route table is exactly §9's fenced block: the six model routes, in order,
then the three tool routes. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/index.ts#GATEWAY_ROUTES")
  (doc := "docs/spec.md#9-model-gateway")]
theorem ingress_paths_are_the_spec_contract :
    Ingress.all.map Ingress.path =
      ["/v1/messages", "/v1/messages/count_tokens", "/v1/responses", "/v1/chat/completions",
        "/v1/models", "/health", "/v1/tools/:connectorId/mcp", "/v1/tool-sandbox/mcp",
        "/v1/tool-sandbox/endpoint/mcp"] := by decide

/-- The model classes embed `Route` unchanged: same path, same metering, in the same order. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/index.ts#GATEWAY_ROUTES")]
theorem model_ingress_is_route (route : Route) :
    (Ingress.model route).path = route.path ∧
      (Ingress.model route).metered = (routeProtocol? route).isSome ∧
      Ingress.all.filter
          (fun i => i != .tool && i != .toolSandbox && i != .toolSandboxEndpoint) =
        Route.all.map Ingress.model := by
  exact ⟨rfl, rfl, by decide⟩

end AgentWorkspace.Theorems.Adversarial.GatewayIngress
