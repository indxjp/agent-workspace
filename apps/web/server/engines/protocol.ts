/**
 * The compose-time **protocol check** (ENG-04, #303).
 *
 * ENG-02 gave the control plane a capability check that asks *"can this engine honour what this
 * agent is assigned?"* This module asks the other question a run needs answered before it
 * starts: *"can this engine reach this run's model at all?"*
 *
 * An engine does not talk to a provider. It talks to the gateway (§26), in one of the HTTP
 * dialects `WIRE_PROTOCOLS` names, and the gateway relays. So a run is only servable when the
 * engine speaks a dialect the gateway serves **for that connection's provider** — and those two
 * sets are not the same for every provider: every provider answers `anthropic-messages` because
 * the gateway's own `createMessage` is the Anthropic Messages shape, while only the OpenAI
 * family can be handed an `openai-responses` or `openai-chat-completions` body to forward
 * (`packages/gateway/src/providers/registry.ts`'s `forwardingRow`, ADR-0068 D3).
 *
 * Without this check the failure is late and unreadable: the run is accepted, a runtime is
 * provisioned, the engine makes its first model call minutes later and the gateway answers
 * `protocol_not_supported_for_connection`, which reaches the operator as a failed run carrying a
 * provider error. With it the run fails while it is being composed, before a runtime is asked for
 * anything, with a public error that names `engine_model_protocol_unsupported` and says which
 * dialects would have worked. It is decided at compose rather than as a `422` on the run-create
 * route because the model connection is only resolved there (see `wireProtocolFor` in
 * `../compose/run-request.ts`).
 *
 * Pure, and it knows nothing about HTTP. `apps/web/server/compose/run-request.ts` is what turns
 * its answer into the refusal, exactly as `./capabilities.ts` is turned into one by
 * `apps/web/server/agents/policy.ts`.
 */
import type { WireProtocol } from '@indx-workspace/contracts/engines';
import { MODEL_PROVIDERS, type ModelProvider } from '@indx-workspace/contracts/runs';

/**
 * The dialect every provider answers, because it is the gateway's own request shape.
 *
 * Not a capability of the provider: `packages/gateway`'s `ModelProvider.createMessage` takes an
 * `AnthropicMessageRequest` for every row in the registry, translating it where the provider's
 * own API differs. So an engine that speaks Anthropic Messages can reach any model connection
 * this platform has.
 */
const GATEWAY_NATIVE_PROTOCOL: WireProtocol = 'anthropic-messages';

/**
 * The two dialects the gateway **forwards** rather than translates, and the providers it will
 * forward them to.
 *
 * ADR-0068 D3: an OpenAI-family row declares `forwards` and relays the body; `anthropic` has no
 * such row, and the absence of `forward` is what makes `/v1/responses` answer
 * `protocol_not_supported_for_connection`. This table restates which providers those are because
 * `apps/web` may not import `packages/gateway`'s registry — the same restatement rule
 * `apps/web/server/engines/registry.ts` applies to the SDK version — and
 * `protocol.test.ts` holds it to the gateway's own `OPENAI_WIRE_PROTOCOLS` forwarding rows.
 */
const FORWARDING_PROVIDERS: ReadonlySet<ModelProvider> = new Set<ModelProvider>([
  'openai',
  'azure-openai',
  'openai-compatible',
]);

const FORWARDED_PROTOCOLS: readonly WireProtocol[] = [
  'openai-responses',
  'openai-chat-completions',
];

/**
 * Every wire protocol the gateway can serve a run over, for one model connection's provider.
 *
 * Ordered with the gateway-native dialect first, which is what makes {@link resolveWireProtocol}
 * below deterministic without a preference list of its own.
 */
export function gatewayProtocolsFor(provider: ModelProvider): readonly WireProtocol[] {
  return FORWARDING_PROVIDERS.has(provider)
    ? [GATEWAY_NATIVE_PROTOCOL, ...FORWARDED_PROTOCOLS]
    : [GATEWAY_NATIVE_PROTOCOL];
}

export type WireProtocolResolution =
  | { readonly ok: true; readonly protocol: WireProtocol }
  | { readonly ok: false; readonly reason: string };

/**
 * Which protocol this run will use, or why there is none.
 *
 * The **engine's** order decides, not the gateway's: an engine that lists
 * `['openai-responses', 'anthropic-messages']` is saying it would rather speak the first, and
 * the gateway serves both to an OpenAI connection. Reading the engine's preference is what makes
 * the field an ordered list rather than a set.
 *
 * A positive assertion (ADR-0015): the resolution succeeds because a protocol was found in both
 * lists, never because nothing objected. `ok: false` always names both sides, because the fix is
 * either a different engine or a different model connection and the operator has to be able to
 * tell which.
 */
export function resolveWireProtocol(
  engineId: string,
  engineProtocols: readonly WireProtocol[],
  provider: ModelProvider,
): WireProtocolResolution {
  const served = gatewayProtocolsFor(provider);
  const protocol = engineProtocols.find((candidate) => served.includes(candidate));
  if (protocol === undefined) {
    return {
      ok: false,
      reason:
        `The engine '${engineId}' speaks ${engineProtocols.join(', ') || '(nothing)'}, and the ` +
        `gateway serves ${served.join(', ')} for a '${provider}' model connection. A run needs ` +
        'one protocol in both lists; choose an engine that speaks one the gateway serves for ' +
        'this provider, or point the agent at a connection whose provider it can reach.',
    };
  }
  return { ok: true, protocol };
}

/**
 * The model providers an engine speaking `engineProtocols` can reach through the gateway — the
 * provider half of the composer's model filter (issue #393, `components/models/engine-models.ts`).
 * The same overlap {@link resolveWireProtocol} decides for one run, asked of every provider.
 */
export function providersReachableBy(
  engineProtocols: readonly WireProtocol[],
): readonly ModelProvider[] {
  return MODEL_PROVIDERS.filter((provider) =>
    gatewayProtocolsFor(provider).some((protocol) => engineProtocols.includes(protocol)),
  );
}
