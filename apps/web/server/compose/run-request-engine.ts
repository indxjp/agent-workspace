import { DEFAULT_RUN_ENGINE } from '@agent-workspace/run-protocol';

import { claudeReadOnlyGrantDenials, engineSettingsOf } from '@indx-workspace/contracts/agents';
import { isWithholdingEngine } from '@indx-workspace/contracts/engines';
import type { ModelProvider } from '@indx-workspace/contracts/runs';

import { DomainError } from '../errors';
import { registeredEngine, resolveWireProtocol } from '../execution';
import type { AgentRecord } from '../agents/contract';
import type { AgentRunResourceSelection } from './resource-loader';
import type { GrantedFiles } from './run-request-resources';
import {
  withMemberApprovalRules,
  withMemberToolRules,
  withRunConnectorKeys,
} from './run-request-tool-connectors';

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

/**
 * The engine-native arm of the private `/run` contract, for the engine this run is addressed to.
 *
 * The stored policy's engine-specific half, forwarded **verbatim** — never recomputed here. That is
 * the whole of ENG-04b's first item: `AgentPolicy` is discriminated by engine and its `tools` field
 * is *"engine-native: the Claude Agent SDK's own tool grammar. No other arm may reuse it"*
 * (`packages/contracts/src/agents.ts`), so this function's job is to hand it across, not to
 * interpret it. An agent with no stored policy sends `tools: null`, and the adapter compiles the
 * permission floor alone.
 *
 * A further engine of the withholding kind adds nothing here: its settings come from the engine
 * catalogue (ADR-0136).
 */
export function enginePolicyArmFor(
  agent: AgentRecord,
  cwd: string,
  resources: Pick<AgentRunResourceSelection, 'connectorKeys' | 'toolConnectors'> & {
    readonly files: GrantedFiles;
  },
  approvedToolCalls: readonly { readonly canonicalCall: string }[],
): unknown {
  const policy = agent.policy;
  // A withholding arm is its engine-native settings, verbatim: the adapter compiles its tools from
  // the portable permissions and enforces grants itself, and has no pre-ENG-04 image to be
  // defended for (ADR-0072 D5).
  if (policy !== null && isWithholdingEngine(policy.engine)) return engineSettingsOf(policy);
  // Every write operation of an openapi tool is implicitly `requireApproval` (ADR-0113 SD4); the
  // rules carry the run's own server keys, so they are added here rather than stored on the policy.
  // A rule written against a member tool's neutral name, `agent__<member>`, is given the engine's
  // spelling, `mcp__agent__<member>` (ADR-0104 acceptance decision 3).
  const requireApproval = [
    ...new Set([
      ...withMemberApprovalRules(
        policy !== null && 'tools' in policy ? (policy.requireApproval ?? []) : [],
      ),
      ...(resources.toolConnectors ?? []).flatMap((connector) => connector.approvalRules ?? []),
    ]),
  ];
  return {
    tools:
      policy !== null && 'tools' in policy
        ? withMemberToolRules(withRunConnectorKeys(policy.tools, resources.connectorKeys ?? {}))
        : null,
    fileGrantDeny: applyFileGrantPolicy(cwd, resources.files),
    // Left out when empty, so a run without a gate sends the arm an older runner image accepts.
    ...(requireApproval.length === 0 ? {} : { requireApproval }),
    ...(policy !== null && 'tools' in policy && policy.handoff === true ? { handoff: true } : {}),
    ...(approvedToolCalls.length === 0
      ? {}
      : { approvedToolCalls: approvedToolCalls.map((call) => call.canonicalCall) }),
  };
}

/**
 * File grants narrow the agent-wide permission switches: read-only paths are removed from the
 * engine's write tools, and command execution is removed because a shell redirect would otherwise
 * bypass those tool-specific rules. The runner also materialises these paths with read-only
 * filesystem modes; the two checks protect independent write paths.
 *
 * ## This is the legacy guard, and here is when it can be removed (ENG-04b, #325)
 *
 * The rules (`@indx-workspace/contracts`' `claudeReadOnlyGrantDenials`, shared with the adapter) are
 * written in the Claude Agent SDK's tool vocabulary — the one thing this unit
 * otherwise removed from compose — and they are kept deliberately, as **defence in depth on the
 * compose side**. `packages/engine-claude-agent-sdk`'s `claudeFileGrantDenials` derives the same
 * list from the same grants and the adapter de-duplicates the two in order, so this list can only
 * ever narrow a run and never widen or reorder one; ENG-04b's refinement theorem covers both the
 * request that carries it and the request that does not.
 *
 * It exists for a runner image whose Claude adapter predates ENG-04 (#324) — one that trusted the
 * control plane to have compiled grant denials, because at that point nothing else did. It may be
 * deleted once the minimum supported runtime image carries an adapter that compiles grants itself,
 * which is every image from ENG-04 onwards;
 * `docs/adr/0072-the-claude-tool-mapping-and-skills-live-in-the-claude-adapter.md` records the condition so
 * that removing it is a decision somebody takes rather than a line nobody dares touch.
 */
export function applyFileGrantPolicy(cwd: string, files: GrantedFiles): readonly string[] {
  return claudeReadOnlyGrantDenials(
    cwd,
    files.filter((file) => file.access === 'read'),
  );
}
