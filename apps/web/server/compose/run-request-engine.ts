import { DEFAULT_RUN_ENGINE } from '@agent-workspace/run-protocol';

import type { ModelProvider } from '@indx-workspace/contracts/runs';

import { DomainError } from '../errors';
import { registeredEngine } from '../engines/registry';
import { resolveWireProtocol } from '../engines/protocol';
import type { AgentRecord } from '../agents/contract';

/**
 * The engine this agent runs on: the one its stored policy names, or the default.
 *
 * Read off the policy rather than off a column, because that is where ENG-02 put it — the policy
 * is discriminated by engine id, so an agent with no stored policy is on the engine
 * `compiledPolicyFor` answers with, which is the same default `apps/web/server/engines/session-engine.ts`
 * publishes and `packages/core`'s `DEFAULT_RUN_ENGINE` carries onto the wire.
 */
export function engineFor(agent: AgentRecord): string {
  return agent.policy?.engine ?? DEFAULT_RUN_ENGINE;
}

/**
 * Resolve the wire protocol for this run, or throw the typed `engine_model_protocol_unsupported`
 * refusal.
 *
 * Throws rather than returning a verdict because every other refusal in this function does:
 * `buildRunRequestFor`'s own contract is *"throws — with a sentence naming the reason — rather
 * than returning a partial request"*.
 *
 * The throw is a {@link DomainError}, not a bare `Error`, and that is what makes the refusal
 * reach a human. The launcher turns anything thrown while preparing a run into the run's public
 * failure through `publicRunFailure` (`../runs/failures.ts`), which keeps a `DomainError`'s
 * `publicMessage` and replaces every other error with a generic sentence. So the run is
 * recorded `failed` with an error that starts with the problem code and continues with the
 * resolver's sentence — the engine, the dialects the gateway serves for this provider, and what
 * to change — which is what the run API and the UI show.
 *
 * This is decided while the run is being composed, **after** its row exists, and not as an HTTP
 * `422` on the run-create route: the model connection is resolved here (`resolveModelForRun`,
 * which may call provider discovery), and the protocol check depends on which connection the
 * run resolved to. ENG-04's PR records that as a deviation from the issue's "`422` before a run
 * row exists"; `ENGINE_PROBLEM_CODES` keeps the status a future route-level check would answer.
 *
 * An unregistered engine is **not** decided here. `apps/web/server/agents/policy.ts` refuses one
 * at save time with `400 unsupported_engine`, and a descriptor this deployment has since stopped
 * registering is a deployment change rather than a request problem; composing on the
 * gateway-native dialect keeps that run working exactly as it did before this check existed,
 * which is the behaviour-preserving direction for a check whose job is to catch a *mismatch*.
 */
export function wireProtocolFor(engineId: string, provider: ModelProvider | undefined): string {
  if (provider === undefined) return 'anthropic-messages';
  const descriptor = registeredEngine(engineId);
  if (descriptor === null) return 'anthropic-messages';
  const resolution = resolveWireProtocol(engineId, descriptor.capabilities.wireProtocols, provider);
  if (!resolution.ok) {
    throw new DomainError({
      category: 'validation',
      code: 'engine_model_protocol_unsupported',
      publicMessage: `engine_model_protocol_unsupported: ${resolution.reason}`,
    });
  }
  return resolution.protocol;
}
