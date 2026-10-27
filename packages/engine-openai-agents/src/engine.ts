/**
 * The OpenAI Agents SDK, behind the engine port (ENG-09, #308).
 *
 * The second adapter, and the one the port was designed to be proved against (ADR-0065
 * Consequences): `compile` is `./compile.ts`, events are `./frames.ts`, the session is
 * `./session.ts`, and the only SDK import is `./boundary.ts`. The runner reaches it through
 * {@link createOpenAiAgentsEngine} and nothing else.
 *
 * ## The session identity
 *
 * The SDK has no session event of its own: a `Session` is whatever id its implementation answers.
 * This adapter's answers the platform session id (`sessions.id`), or on a resume the engine session
 * id the request carries — which compose sets to that same id. So the first frame of every run is
 * an `agent.session` reporting exactly the id the store stream is keyed by, and
 * `engineSessionId` resolves to it. Nothing is invented: it is the id the engine's session reports.
 */
import { ENGINE_CATALOGUE } from '@indx-workspace/contracts/engines';
import { createEngineAdapter, type AgentEngine } from '@agent-workspace/engine';

import {
  OPENAI_AGENTS_SDK_VERSION,
  startOpenAiAgentsRun,
  type OpenAiAgentsRunStarter,
} from './boundary.js';
import {
  compileOpenAiAgentsRun,
  OPENAI_AGENTS_ENGINE_ID,
  OPENAI_AGENTS_PROTECTED_CONFIG_DIRECTORY,
  type OpenAiAgentsCompiled,
} from './compile.js';
import { createOpenAiAgentsFrameMapper, type OpenAiAgentsEvent } from './frames.js';
import { EngineStoreSession, openAiAgentsDurability } from './session.js';

/** The adapter's own version: the package version plus the SDK it wraps. */
export const OPENAI_AGENTS_ADAPTER_VERSION = `0.0.0+${OPENAI_AGENTS_SDK_VERSION}`;

/**
 * What this adapter honours (ENG-02's capability set), stated for what it **does**:
 *
 * * `skills: false` — a plain `Agent` has no skills, and a loader on top of it would re-implement
 *   a harness feature (ADR-0065 D3). Refused by name (ADR-0074).
 * * `fork: false` — the store has no branch operation.
 * * `streamingText: true`, `reasoning: true` — text and reasoning deltas are mapped.
 * * `maxTurns: 'native'` — the SDK's own `maxTurns`.
 * * `maxBudget: 'adapter'` — **provisional** (ADR-0074 D7, #342): the adapter prices the usage the
 *   gateway reports back with `./budget.ts`'s table and stops the run `max_budget` when the cap is
 *   reached; a cap on a model the table cannot price is refused at compile time. Billing stays the
 *   gateway's (ADR-0065 D6).
 * * `wireProtocols` — Responses first, so compose prefers it for an OpenAI-family connection.
 *
 * The values are the engine catalogue's (ADR-0136), which the control plane's registry reads too.
 */
export const OPENAI_AGENTS_CAPABILITIES = ENGINE_CATALOGUE['openai-agents'].capabilities;

/** Build the adapter — the package root's only export (W3-8). With no arguments it runs the real SDK. */
export function createOpenAiAgentsEngine(
  runStarter: OpenAiAgentsRunStarter = startOpenAiAgentsRun,
): AgentEngine<OpenAiAgentsCompiled> {
  return createEngineAdapter<OpenAiAgentsCompiled, OpenAiAgentsEvent>({
    id: OPENAI_AGENTS_ENGINE_ID,
    version: OPENAI_AGENTS_ADAPTER_VERSION,
    capabilities: OPENAI_AGENTS_CAPABILITIES,
    structuredOutput: ENGINE_CATALOGUE['openai-agents'].structuredOutput,
    // `skills: false`: the kit places nothing, and `compile` refuses a granted skill by name.
    protectedConfigDirectory: OPENAI_AGENTS_PROTECTED_CONFIG_DIRECTORY,
    compile: compileOpenAiAgentsRun,
    plan(configuration, request, { sessionStore, abortController }) {
      const { engineSessionId, mode, projectKey } = configuration.session;
      const session =
        sessionStore === undefined
          ? null
          : new EngineStoreSession(sessionStore, { projectKey, sessionId: engineSessionId });
      const mapper = createOpenAiAgentsFrameMapper({
        localTools: configuration.agent.tools,
        hasMcp: configuration.mcpServers.length > 0,
      });
      return {
        identity: {
          kind: 'declared',
          engineSessionId,
          model: configuration.agent.model,
          raw: { type: 'openai-agents.session', sessionId: engineSessionId, mode },
        },
        events: () =>
          runStarter(configuration, request.prompt, { session, signal: abortController.signal }),
        map: (event) => mapper.map(event),
        isTerminal: (event) => event.kind === 'run_completed',
        cancelled: { kind: 'run_completed', stopReason: 'cancelled', turns: 0, usage: null },
        durability: (completed) => openAiAgentsDurability({ session, completed }),
      };
    },
  });
}
