import AgentWorkspace.Theorems.Normative.GatewayIngress

/-!
T4 for `gateway-ingress`: the messages-only gateway refines into the three-dialect one.

The claim the unit has to make good on is that Anthropic ingress is **unchanged**. Here it is as a
theorem rather than as a promise: for `anthropic-messages` the target decision is definitionally the
current one, on every connection family, and the routes the current table did not have are exactly
the two this unit adds.

One rule inside the unit was narrowed after review, and that direction is a theorem here too: the
upstream request header allowlist became a closed list of names where it was an `openai-` prefix, and
what it admits is a subset of what the prefix admitted.
-/

namespace AgentWorkspace.Theorems.Refinement.GatewayIngress

open AgentWorkspace AgentWorkspace.Authz.RunToken
open AgentWorkspace.Behaviour.GatewayIngress
open AgentWorkspace.Concepts.Usage
open AgentWorkspace.Theorems.WellFormed.GatewayIngress (clean)

/-- On `/v1/messages` the target decision is the current one, for every request: adding two dialects
changed no Anthropic code path. -/
@[aw_spec (tier := T4) (ts := "packages/gateway/src/router.ts#createMessage")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#consequences")]
theorem messages_route_is_unchanged (r : Request) :
    ingressDecisionRouteCurrent .messages r = ingressDecisionRoute .messages r := rfl

/-- So are the three routes that carry no model turn. -/
@[aw_spec (tier := T4) (ts := "packages/gateway/src/router.ts#createRouter")]
theorem the_other_existing_routes_are_unchanged (r : Request) :
    ingressDecisionRouteCurrent .countTokens r = ingressDecisionRoute .countTokens r ∧
      ingressDecisionRouteCurrent .models r = ingressDecisionRoute .models r ∧
      ingressDecisionRouteCurrent .health r = ingressDecisionRoute .health r :=
  ⟨rfl, rfl, rfl⟩

/-- Every route the current table already had decides identically in the target table. -/
@[aw_spec (tier := T4) (ts := "packages/gateway/src/router.ts#ROUTES")
  (doc := "docs/spec.md#9-model-gateway")]
theorem the_current_route_table_embeds_in_the_target (route : Route) (r : Request)
    (h : route.existedBeforeIngress = true) :
    ingressDecisionRouteCurrent route r = ingressDecisionRoute route r := by
  unfold ingressDecisionRouteCurrent
  simp [h]

/-- The routes the two tables disagree on are exactly the two this unit adds, and the disagreement
is exactly that they used to be 404. -/
@[aw_spec (tier := T4) (ts := "packages/gateway/src/router.ts#ROUTES")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d1--two-new-ingress-routes-and-they-are-passthrough")]
theorem only_the_two_new_routes_changed :
    Route.all.filter (!Route.existedBeforeIngress ·) = [.responses, .chatCompletions] ∧
      ∀ r : Request,
        ingressDecisionRouteCurrent .responses r = .answered 404 "not_found_error" ∧
          ingressDecisionRouteCurrent .chatCompletions r = .answered 404 "not_found_error" :=
  ⟨by decide, fun _ => ⟨rfl, rfl⟩⟩

/-- Anthropic Messages behaves identically on every connection family in both tables, so the
refinement is not merely about the route's existence. -/
@[aw_spec (tier := T4) (ts := "packages/gateway/src/providers/anthropic.ts#createAnthropicProvider")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#consequences")]
theorem messages_behaves_identically_on_every_family :
    ConnectionFamily.all.all (fun family =>
      ingressDecisionRouteCurrent .messages (clean .anthropicMessages family) ==
        ingressDecisionRoute .messages (clean .anthropicMessages family)) = true := by decide

/-- The `wire_protocol` column's default is the only dialect the gateway spoke before this unit, so
a row written by the previous release is correctly labelled without a backfill. -/
@[aw_spec (tier := T4) (ts := "packages/core/src/db/schema/run-usage-records.ts#wireProtocol")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#consequences")]
theorem the_column_default_is_the_previous_only_dialect :
    WireProtocol.columnDefault = .anthropicMessages ∧
      WireEnum.toWire WireProtocol.columnDefault = "anthropic-messages" ∧
      (Route.all.filter Route.existedBeforeIngress).filterMap routeProtocol? =
        [WireProtocol.columnDefault] := by decide

/-- The upstream request allowlist is a **refinement** of the `openai-` prefix rule it replaces, not a
different rule: every name the closed list still admits the prefix admitted too, and the names the
prefix admitted that the list now drops are the account selectors — `openai-organization` and
`openai-project` decide which account on the stored credential serves and is billed for the turn,
which is the model connection's decision and never the caller's (ADR-0068 D7). Fewer client headers
reach the upstream than before; none that did not reach it now does. -/
@[aw_spec (tier := T4) (ts := "packages/gateway/src/providers/passthrough.ts#UPSTREAM_HEADERS")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d7--both-header-directions-are-closed-allowlists")]
theorem the_upstream_allowlist_refines_the_prefix_rule :
    upstreamAllowedHeaders.all (fun name => hasOpenAIPrefix name && travelsUpstream name) = true ∧
      ["openai-organization", "openai-project"].all (fun name =>
        hasOpenAIPrefix name && !travelsUpstream name) = true ∧
      ["authorization", "cookie", "x-api-key"].all (fun name =>
        !hasOpenAIPrefix name && !travelsUpstream name) = true := by decide

/-- Metering an Anthropic Messages response is the same function it was: the extraction was moved
into its own module, not changed. A `message_start` / `message_delta` pair with a tool block still
merges by maximum and still counts one call. -/
@[aw_spec (tier := T4)
  (ts := "packages/gateway/src/usage/anthropic.ts#createAnthropicUsageAccumulator")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#consequences")]
theorem anthropic_metering_is_unchanged :
    extractAnthropic [.usageSnapshot 12 0 4 2, .toolBlockStart, .usageSnapshot 12 7 4 2, .stop] =
      ⟨⟨12, 7, 4, 2, 1⟩, true, true⟩ ∧
    settle .anthropicMessages (extractAnthropic [.usageSnapshot 12 0 4 2, .toolBlockStart,
      .usageSnapshot 12 7 4 2, .stop]) = .recorded ⟨12, 7, 4, 2, 1⟩ true := by decide

/-- An Anthropic response carrying no usage at all still settles as a failure, exactly as it did
before the gateway spoke three dialects — **including** the shape every real one has, which ends in
`message_stop` (or is a non-streaming `type: "message"` body) and so reports itself complete. The
`unavailable` outcome is new behaviour for the two OpenAI dialects, not a change to this one. -/
@[aw_spec (tier := T4) (ts := "packages/gateway/src/auth.ts#recordResponseUsage")
  (ts := "packages/gateway/src/auth.ts#isUnpricedWhenUnmetered")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d9--no-sixth-accounting-state-is-invented")]
theorem an_anthropic_response_without_usage_still_fails :
    settle .anthropicMessages (extractAnthropic []) = .failed ∧
      settle .anthropicMessages (extractAnthropic [.toolBlockStart]) = .failed ∧
      settle .anthropicMessages (extractAnthropic [.stop]) = .failed ∧
      settle .anthropicMessages (extractAnthropic [.toolBlockStart, .stop]) = .failed := by decide

end AgentWorkspace.Theorems.Refinement.GatewayIngress
