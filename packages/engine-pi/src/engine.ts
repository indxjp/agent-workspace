/**
 * The pi coding agent, behind the engine port (ENG-08, #307).
 *
 * The third adapter. `compile` is `./compile.ts`, events are `./frames.ts`, the session is
 * `./session.ts`, the tool guard is `./workspace.ts` and `./guard.ts`, and the only SDK import is
 * `./boundary.ts`. The runner reaches it through {@link PI_ENGINE_ADAPTER} and nothing else.
 *
 * ## The session identity
 *
 * pi's session id is the id its `SessionManager` is created with, and this adapter creates it with
 * the platform session id (`sessions.id`) — or, on a resume, the engine session id the request
 * carries, which is the one an earlier run's `agent.session` reported. So the first frame of every
 * run is an `agent.session` reporting exactly the id pi runs under and the store stream is keyed
 * by, and `engineSessionId` resolves to it. Nothing is invented: it is the id pi's header carries.
 */
import { ENGINE_CATALOGUE } from '@indx-workspace/contracts/engines';
import { createEngineAdapter, type AgentEngine } from '@agent-workspace/engine';

import { PI_CODING_AGENT_VERSION, startPiRun, type PiRunStarter } from './boundary.js';
import {
  compilePiRun,
  PI_ENGINE_ID,
  PI_PROTECTED_CONFIG_DIRECTORY,
  type PiCompiled,
} from './compile.js';
import { createPiFrameMapper, type PiEvent } from './frames.js';
import { loadPiStream, piDurability, PiSessionMirror } from './session.js';

/** The adapter's own version: the package version plus the pi release it wraps. */
export const PI_ADAPTER_VERSION = `0.0.0+${PI_CODING_AGENT_VERSION}`;

/**
 * What this adapter honours (ENG-02's capability set), stated for what it **does**:
 *
 * * `mcp: false` — pi has no MCP client; a connector is refused by name (ADR-0081).
 * * `skills: true` — placed under `.pi/skills/<name>/` and returned by the pinned loader.
 * * `resume: true`, `fork: true` — the session tree lives in the store (`./session.ts`); a fork
 *   copies the parent's stream under a new header, as pi's own `forkFrom` does to a file.
 * * `streamingText: true`, `reasoning: true` — text and thinking deltas are mapped.
 * * `maxTurns: 'adapter'` — counted on `turn_end`, ended with `session.abort()`.
 * * `maxBudget: 'adapter'` — **provisional** (ADR-0074 D7, #342): each response is priced with the
 *   port's table and the run stops `max_budget` at the cap. Billing stays the gateway's.
 * * `wireProtocols` — Anthropic Messages, the one dialect the gateway serves pi today.
 *
 * The values are the engine catalogue's (ADR-0136), which the control plane's registry reads too.
 */
export const PI_CAPABILITIES = ENGINE_CATALOGUE.pi.capabilities;

/** Build the adapter. {@link PI_ENGINE_ADAPTER} is this with the real pi. */
export function createPiEngine(runStarter: PiRunStarter = startPiRun): AgentEngine<PiCompiled> {
  return createEngineAdapter<PiCompiled, PiEvent>({
    id: PI_ENGINE_ID,
    version: PI_ADAPTER_VERSION,
    capabilities: PI_CAPABILITIES,
    // Skills land in `.pi/skills/<name>/` (the kit's default placeSkills) — the one directory the
    // pinned loader reads (ADR-0081 D3).
    protectedConfigDirectory: PI_PROTECTED_CONFIG_DIRECTORY,
    compile: compilePiRun,
    plan(configuration, request, { sessionStore, abortController }) {
      const { engineSessionId, parentSessionId, projectKey } = configuration.session;
      const mirror =
        sessionStore === undefined
          ? null
          : new PiSessionMirror(sessionStore, { projectKey, sessionId: engineSessionId });
      const loadParent =
        sessionStore === undefined || parentSessionId === null
          ? null
          : () => loadPiStream(sessionStore, { projectKey, sessionId: parentSessionId });
      const mapper = createPiFrameMapper();
      return {
        identity: {
          kind: 'declared',
          engineSessionId,
          model: configuration.agent.model,
          raw: {
            type: 'pi.session',
            sessionId: engineSessionId,
            mode: configuration.session.mode,
            parentSessionId,
          },
        },
        events: () =>
          runStarter(configuration, request.prompt, {
            mirror,
            loadParent,
            signal: abortController.signal,
          }),
        map: (event) => mapper.map(event),
        isTerminal: (event) => event.kind === 'run_completed',
        cancelled: { kind: 'run_completed', stopReason: 'cancelled', turns: 0, usage: null },
        durability: (completed) => piDurability({ mirror, completed }),
      };
    },
  });
}

/** The adapter the runner's registry loads. */
export const PI_ENGINE_ADAPTER: AgentEngine<PiCompiled> = createPiEngine();
