/**
 * Mastra, behind the engine port (ENG-10, #309).
 *
 * The fourth adapter. `compile` is `./compile.ts`, events are `./frames.ts`, memory is
 * `./session.ts`, the filesystem wrapper is `./workspace.ts` and `./guard.ts`, and the only SDK
 * import is `./boundary.ts`. The runner reaches it through {@link MASTRA_ENGINE_ADAPTER} and
 * nothing else.
 *
 * ## The session identity
 *
 * Mastra's conversation identity is a memory thread, and this adapter names the thread with the
 * platform session id (`sessions.id`) — or, on a resume, the engine session id the request carries,
 * which is the one an earlier run's `agent.session` reported. So the first frame of every run is an
 * `agent.session` reporting exactly the thread Mastra's memory runs under and the store stream is
 * keyed by, and `engineSessionId` resolves to it. Nothing is invented.
 */
import { ENGINE_CATALOGUE } from '@indx-workspace/contracts/engines';
import { createEngineAdapter, type AgentEngine } from '@agent-workspace/engine';

import { MASTRA_CORE_VERSION, startMastraRun, type MastraRunStarter } from './boundary.js';
import {
  compileMastraRun,
  MASTRA_ENGINE_ID,
  MASTRA_PROTECTED_CONFIG_DIRECTORY,
  type MastraCompiled,
} from './compile.js';
import { createMastraFrameMapper, type MastraEvent } from './frames.js';
import { mastraDurability, MastraMemoryJournal } from './session.js';

/** The adapter's own version: the package version plus the Mastra release it wraps. */
export const MASTRA_ADAPTER_VERSION = `0.0.0+${MASTRA_CORE_VERSION}`;

/**
 * What this adapter honours (ENG-02's capability set), stated for what it **does**:
 *
 * * `mcp: true` — connectors become `MCPClient` servers; their tools are `agent.tool.call {kind:'mcp'}`.
 * * `skills: true` — placed under `.mastra/skills/<name>/` and read as workspace skills.
 * * `resume: true` — the thread lives in the store (`./session.ts`); `fork: false` — a Mastra
 *   thread is continued, not branched, and a fork is refused by name.
 * * `interrupt: true` — `abortSignal` on `agent.stream()`.
 * * `streamingText: true`, `reasoning: true` — text and reasoning deltas are mapped.
 * * `maxTurns: 'native'` — Mastra's own `maxSteps`.
 * * `maxBudget: 'adapter'` — **provisional** (ADR-0074 D7, #342): each step is priced with the
 *   port's table and the run stops `max_budget` at the cap. Billing stays the gateway's.
 * * `wireProtocols` — Anthropic Messages, OpenAI Responses and Chat Completions, each through an
 *   explicit AI SDK provider at the gateway.
 *
 * The values are the engine catalogue's (ADR-0136), which the control plane's registry reads too.
 */
export const MASTRA_CAPABILITIES = ENGINE_CATALOGUE.mastra.capabilities;

/** Build the adapter. {@link MASTRA_ENGINE_ADAPTER} is this with the real Mastra. */
export function createMastraEngine(
  runStarter: MastraRunStarter = startMastraRun,
): AgentEngine<MastraCompiled> {
  return createEngineAdapter<MastraCompiled, MastraEvent>({
    id: MASTRA_ENGINE_ID,
    version: MASTRA_ADAPTER_VERSION,
    capabilities: MASTRA_CAPABILITIES,
    // Skills land in `.mastra/skills/<name>/` (the kit's default placeSkills) — the directories the
    // workspace is told to discover (ADR-0084).
    protectedConfigDirectory: MASTRA_PROTECTED_CONFIG_DIRECTORY,
    compile: compileMastraRun,
    plan(configuration, request, { sessionStore, abortController }) {
      const { threadId, projectKey, resourceId, mode } = configuration.memory;
      const journal =
        sessionStore === undefined
          ? null
          : new MastraMemoryJournal(sessionStore, { projectKey, sessionId: threadId });
      const mapper = createMastraFrameMapper(configuration.mcpServers.map((server) => server.name));
      return {
        identity: {
          kind: 'declared',
          engineSessionId: threadId,
          model: configuration.agent.model,
          raw: { type: 'mastra.thread', threadId, resourceId, mode },
        },
        events: () =>
          runStarter(configuration, request.prompt, { journal, signal: abortController.signal }),
        map: (event) => mapper.map(event),
        // An `error` chunk ends the stream without a `run_completed`, and still counts as completed.
        isTerminal: (event) =>
          event.kind === 'run_completed' || (event.kind === 'mastra' && isErrorChunk(event.chunk)),
        cancelled: {
          kind: 'run_completed',
          stopReason: 'cancelled',
          steps: 0,
          usage: null,
          finish: null,
        },
        durability: (completed) => mastraDurability({ journal, completed }),
      };
    },
  });
}

function isErrorChunk(chunk: unknown): boolean {
  return typeof chunk === 'object' && chunk !== null && 'type' in chunk && chunk.type === 'error';
}

/** The adapter the runner's registry loads. */
export const MASTRA_ENGINE_ADAPTER: AgentEngine<MastraCompiled> = createMastraEngine();
